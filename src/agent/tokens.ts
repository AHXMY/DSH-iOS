/**
 * 上下文预算：估算 token、裁剪旧工具结果。
 *
 * 手机上没有 tokenizer 可用（BPE 表塞不进 App），所以这里是**估算**，
 * 目标不是精确，而是"别撞上限、别浪费"。宁可估高一点：估高了只是多压缩一次，
 * 估低了就是整轮报废。
 *
 * 经验系数（DeepSeek 中文语料）：中文约 1 字 ≈ 0.6 token，英文约 4 字符 ≈ 1 token。
 */
import type { ChatMessage, ToolSpec } from './types'

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 单条文本的粗略 token 估算。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 0.6 + other / 4)
}

/** 一条消息的估算：正文 + 思考 + 工具调用壳。 */
export function estimateMessage(message: ChatMessage): number {
  let total = estimateTokens(message.text) + 4
  if (message.reasoning !== undefined) total += estimateTokens(message.reasoning)
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(call.arguments) + 8
  }
  return total
}

/** 整个请求的估算，含工具 schema（每轮都要带上，别漏）。 */
export function estimateContext(messages: ChatMessage[], tools: ToolSpec[] = []): number {
  let total = 0
  for (const message of messages) total += estimateMessage(message)
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description) + 20
    total += estimateTokens(JSON.stringify(tool.parameters))
  }
  return total
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`
  return `${(count / 1000).toFixed(1)}k`
}

/**
 * 裁剪旧的工具结果（对应 DSH 的 compaction-tool-result-pruner）。
 *
 * 一轮 agent 会话里，真正把上下文撑爆的往往不是对话，是工具输出：
 * 一个网页正文、一次目录列表就是几千字。保留最近的，老的只留头部。
 */
export function pruneToolResults(
  messages: ChatMessage[],
  options: { keepRecent: number, maxChars: number } = { keepRecent: 8, maxChars: 600 },
): { messages: ChatMessage[], prunedCount: number, savedTokens: number } {
  const { keepRecent, maxChars } = options
  const boundary = Math.max(0, messages.length - keepRecent)
  let prunedCount = 0
  let savedTokens = 0

  const next = messages.map((message, index) => {
    if (index >= boundary) return message
    if (message.role !== 'tool') return message
    if (message.pruned === true) return message
    if (message.text.length <= maxChars) return message
    const kept = message.text.slice(0, maxChars)
    const text = `${kept}\n…（这条工具输出在历史里已被裁剪，原 ${message.text.length} 字符）`
    savedTokens += estimateTokens(message.text) - estimateTokens(text)
    prunedCount += 1
    return { ...message, text, pruned: true }
  })

  return { messages: next, prunedCount, savedTokens }
}

/**
 * 摘要压缩时给模型的输入：把消息摊成紧凑文本。
 *
 * 逐条截断是必要的 —— 要压缩的区间里往往就躺着几条巨型工具输出，
 * 原样喂进去等于还没压缩就先超了。
 */
export function serializeForSummary(messages: ChatMessage[], maxCharsPerMessage = 1500, maxTotal = 30_000): string {
  const lines: string[] = []
  let total = 0

  for (const message of messages) {
    let body = message.text
    if (body.length > maxCharsPerMessage) body = `${body.slice(0, maxCharsPerMessage)}…（截断）`
    let label: string
    if (message.role === 'user') label = message.summary === true ? '历史摘要' : '用户'
    else if (message.role === 'assistant') label = '助手'
    else if (message.role === 'tool') label = `工具 ${message.toolName ?? ''}`
    else label = '系统'

    const calls = (message.toolCalls ?? []).map(call => `[调用 ${call.name} ${call.arguments.slice(0, 200)}]`).join(' ')
    const line = `${label}：${body}${calls === '' ? '' : ` ${calls}`}`
    if (total + line.length > maxTotal) {
      lines.push('…（更早的内容已省略）')
      break
    }
    lines.push(line)
    total += line.length
  }

  return lines.join('\n\n')
}
