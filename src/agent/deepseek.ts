/**
 * DeepSeek 流式客户端。
 *
 * 走 OpenAI 兼容的 /chat/completions（SSE）。两条硬要求：
 *   · 逐字返回 —— 手机上等一坨完整回复的体验绝对不能接受；
 *   · 思考过程单独一股流 —— deepseek-reasoner 的 reasoning_content 要能单独渲染。
 *
 * 用 expo/fetch 而不是全局 fetch：RN 自带的 fetch 不暴露 response.body，
 * 没法做真正的流式读取。
 */
import { fetch as expoFetch } from 'expo/fetch'
import type { ChatMessage, LlmConfig, StreamChunk, StreamRequest, ToolSpec } from './types'

export type { LlmConfig, StreamChunk, StreamRequest }

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message)
    this.name = 'LlmError'
  }
}

/** 把界面上的消息压成线上格式；思考过程不回流（DeepSeek 明确要求不要回传 reasoning_content）。 */
export function toWireMessages(messages: ChatMessage[]): unknown[] {
  const wire: unknown[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'user':
        wire.push({ role: message.role, content: message.text })
        break
      case 'assistant': {
        const item: Record<string, unknown> = {
          role: 'assistant',
          content: message.text === '' ? null : message.text,
        }
        if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
          item.tool_calls = message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
          }))
        }
        wire.push(item)
        break
      }
      case 'tool':
        wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.text })
        break
    }
  }
  return wire
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

const MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function headers(config: LlmConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    accept: 'text/event-stream',
  }
}

/** 把服务端错误翻成"人该干什么"。 */
export async function describeHttpError(response: Response): Promise<LlmError> {
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    detail = ''
  }
  const trimmed = detail.slice(0, 400)
  if (response.status === 401) return new LlmError('API Key 不对（401）。到设置里重新填。', 401)
  if (response.status === 402) return new LlmError('账户余额不足（402）。', 402)
  if (response.status === 429) return new LlmError('请求太频繁（429），等一会儿再发。', 429, true)
  if (response.status >= 500) return new LlmError(`服务端出错（${response.status}），稍后重试。`, response.status, true)
  return new LlmError(`请求被拒绝（${response.status}）：${trimmed}`, response.status)
}

/**
 * 增量 UTF-8 解码。
 *
 * Hermes 上 TextDecoder 不一定在，而流式的每个 chunk 都可能把中文切在两半，
 * 逐块 toString 会直接出乱码 —— 所以要么用原生 TextDecoder，要么自己攒字节。
 */
function createUtf8Decoder(): (bytes: Uint8Array) => string {
  if (typeof TextDecoder !== 'undefined') {
    const decoder = new TextDecoder('utf-8')
    return bytes => decoder.decode(bytes, { stream: true })
  }
  let pending: number[] = []
  return bytes => {
    const all = pending.length === 0 ? Array.from(bytes) : [...pending, ...Array.from(bytes)]
    pending = []
    let out = ''
    let index = 0
    while (index < all.length) {
      const byte = all[index] as number
      let size = 1
      if (byte >= 0xf0) size = 4
      else if (byte >= 0xe0) size = 3
      else if (byte >= 0xc0) size = 2
      if (index + size > all.length) { pending = all.slice(index); break }
      let code = byte & (0xff >> (size + 1))
      for (let offset = 1; offset < size; offset += 1) {
        code = (code << 6) | ((all[index + offset] as number) & 0x3f)
      }
      out += String.fromCodePoint(code)
      index += size
    }
    return out
  }
}

function parseChunk(payload: string): StreamChunk[] {
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }

  const chunks: StreamChunk[] = []
  if (typeof parsed.usage === 'object' && parsed.usage !== null) {
    chunks.push({
      type: 'usage',
      promptTokens: parsed.usage.prompt_tokens,
      completionTokens: parsed.usage.completion_tokens,
    })
  }

  const delta = parsed.choices?.[0]?.delta
  if (delta === undefined || delta === null) return chunks

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
    chunks.push({ type: 'reasoning', text: delta.reasoning_content })
  }
  if (typeof delta.content === 'string' && delta.content !== '') {
    chunks.push({ type: 'text', text: delta.content })
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      chunks.push({
        type: 'tool-call',
        index: typeof call.index === 'number' ? call.index : 0,
        id: typeof call.id === 'string' ? call.id : undefined,
        name: typeof call.function?.name === 'string' ? call.function.name : undefined,
        argsDelta: typeof call.function?.arguments === 'string' ? call.function.arguments : undefined,
      })
    }
  }
  return chunks
}

/** 按行喂 SSE；一行以 data: 开头才算数据，[DONE] 收尾。 */
function createSseParser(): (text: string) => StreamChunk[] {
  let buffer = ''
  return text => {
    buffer += text
    const chunks: StreamChunk[] = []
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      chunks.push(...parseChunk(payload))
    }
    return chunks
  }
}

/** 一次流式补全，带重试（对应 DSH 的 llm-retry）。逐块 yield，调用方负责把它拼成消息。 */
export async function* streamCompletion(request: StreamRequest): AsyncGenerator<StreamChunk> {
  for (let attempt = 1; ; attempt += 1) {
    let emitted = false
    try {
      for await (const chunk of streamOnce(request)) {
        emitted = true
        yield chunk
      }
      return
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      // 已经吐过字就不能重试 —— 重试会把同一段内容再写一遍，比失败更糟。
      if (emitted) throw cause
      const retryable = cause instanceof LlmError ? cause.retryable : true
      if (attempt >= MAX_ATTEMPTS || !retryable) throw cause
      await sleep(attempt * attempt * 600)
    }
  }
}

async function* streamOnce(request: StreamRequest): AsyncGenerator<StreamChunk> {
  const { config, messages, tools, signal } = request
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toWireMessages(messages),
    stream: true,
    temperature: config.temperature,
    // 只要 token 用量，不要服务端把 stream_options 当成非法参数
    stream_options: { include_usage: true },
  }
  if (tools.length > 0) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }

  let response: Response
  try {
    response = await expoFetch(endpoint(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    // 网络层失败按可重试处理（DNS/连接中断/超时）。
    throw new LlmError(`连不上 ${config.baseUrl}：${cause instanceof Error ? cause.message : String(cause)}`, undefined, true)
  }

  if (!response.ok) throw await describeHttpError(response)

  const parser = createSseParser()

  // 有 body 就真流式；拿不到 body 就退化成"一次性解析"，界面照样能出结果。
  if (response.body === null || typeof response.body?.getReader !== 'function') {
    const text = await response.text()
    for (const chunk of parser(text)) yield chunk
    return
  }

  const reader = response.body.getReader()
  const decode = createUtf8Decoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      for (const chunk of parser(decode(value))) yield chunk
    }
  } finally {
    reader.releaseLock?.()
  }
}

/** 拉一次模型清单，让用户从真实可用的模型里选，而不是我猜。 */
export async function listModels(config: Pick<LlmConfig, 'apiKey' | 'baseUrl'>): Promise<string[]> {
  const response = await expoFetch(endpoint(config.baseUrl, '/models'), {
    headers: { authorization: `Bearer ${config.apiKey}` },
  })
  if (!response.ok) throw await describeHttpError(response)
  const payload = (await response.json()) as { data?: { id?: unknown }[] }
  const ids = (payload.data ?? [])
    .map(item => item.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  return ids.sort()
}
