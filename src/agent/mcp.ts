/**
 * 远程 MCP（Model Context Protocol）服务器的 streamable-http 客户端。
 *
 * 职责：把远程 MCP 服务器接成这台 iPhone 上的又一个工具来源——握手（initialize）、
 * 告知握手完成（notifications/initialized）、拉工具清单（tools/list）、调用工具（tools/call），
 * 并把 MCP 的 content 数组摊平成模型能直接读的文本。
 *
 * 为什么 iOS 上只做 http、不做 stdio：手机上的 App 起不了子进程（没有 fork/exec，
 * 也没有可用的 shell），桌面 DSH 里 `npx -y @modelcontextprotocol/server-xxx` 那类
 * stdio 服务器在这台设备上根本拉不起来。streamable-http 只要 HTTP + fetch，
 * iOS 与 Node 都自带全局 fetch，所以它是这里唯一能走通的传输。
 *
 * 传输层的形态（按规范的 streamable-http）：单端点 POST JSON-RPC；同一个请求的响应
 * 可能是 application/json，也可能是 text/event-stream（两种都得吃下）；会话靠
 * Mcp-Session-Id 头维持，握手之后每个请求都要带上。
 *
 * 为什么是按行解析整体读到的文本、而不是流式读 response.body：RN 的 fetch 不给
 * response.body（请求体、响应体都得整体读完），所以这里统一 await response.text()
 * 再按 SSE 事件框切行。代价是**服务端发完响应必须关闭 SSE 流**——规范是"建议关闭"，
 * 真遇到长连接型 SSE（发完不关、继续推通知），我们只能等到超时后报错。
 * 那种服务端要支持的话得换成 expo/fetch 的流式读取，不是改这个文件能解决的。
 *
 * 本文件刻意不 import 任何 expo / react / react-native 模块：它既在 App 里跑，
 * 也要在 Node 下被 scripts/test-mcp.mts 直接 import 验证，因此只依赖全局 fetch。
 */

export type McpServerConfig = {
  /** 短名，用于工具名前缀；kebab-case，例如 'fs' */
  name: string
  /** 完整 URL，例如 https://example.com/mcp */
  url: string
  /** 额外请求头（放 token 用） */
  headers?: Record<string, string>
  /** 服务器信息，连接后填 */
}

export type McpToolDescriptor = {
  /** 原始工具名，不含前缀 */
  name: string
  description: string
  /** JSON Schema（MCP 叫 inputSchema） */
  inputSchema: Record<string, unknown>
}

export type McpConnectResult = {
  protocolVersion: string
  serverName: string
  serverVersion: string
  tools: McpToolDescriptor[]
}

/**
 * 默认值集中放这里。做成可变对象的唯一原因是"单次请求超时"必须能被测试改小：
 * 20 秒的正常值没法在自动化测试里真等到，超时路径又恰恰是最容易写错的一段。
 */
export const MCP_DEFAULTS = {
  /** 单次请求（不是整次 connect）的超时上限，毫秒。 */
  requestTimeoutMs: 20_000,
  /** 我们优先声明的协议版本；服务端可以在 initialize 响应里回一个它支持的版本。 */
  protocolVersion: '2025-06-18',
}

/** clientInfo 用；服务端拿它做日志与兼容判断。 */
const CLIENT_NAME = 'dsh-ios'
const CLIENT_VERSION = '0.1.0'

/** 工具名前缀，与桌面 DSH 的命名约定一致：mcp__<server>__<tool>。 */
const TOOL_PREFIX = 'mcp__'
/** server 与 tool 之间的分隔符。 */
const TOOL_SEPARATOR = '__'

/** tools/list 的服务端分页最多翻这么多页：防服务端给一个永远不收敛的 cursor 把连接拖住。 */
const MAX_TOOL_PAGES = 20

/** 报错里附带响应体片段的上限，避免把整页 HTML 塞进错误信息。 */
const SNIPPET_LIMIT = 200

// ─────────────────────────────────────────────────────────── 小工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 unknown 收窄成对象；不是对象就给个空对象，调用处只需要读字段、不需要区分 null。 */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function snippet(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** JSON-RPC 响应里我们关心的三个字段（通知是没有 id 的，所以 id 可选）。 */
type JsonRpcMessage = { id?: unknown, result?: unknown, error?: unknown }

type JsonRpcRequest = { jsonrpc: '2.0', id: number, method: string, params: Record<string, unknown> }
type JsonRpcNotification = { jsonrpc: '2.0', method: string, params: Record<string, unknown> }

function parseJson(text: string, serverName: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`MCP 服务器 ${serverName} 返回的不是合法 JSON：${snippet(text)}`)
  }
}

/** 一个 JSON-RPC 响应至少得是对象，否则后面读 result/error 全靠猜。 */
function asRpcMessage(value: unknown, serverName: string): JsonRpcMessage {
  if (!isRecord(value)) throw new Error(`MCP 服务器 ${serverName} 返回的不是 JSON-RPC 响应对象`)
  return value
}

/** id 松比对：服务端把数字 id 回成字符串也不该让匹配失败。 */
function sameId(left: unknown, right: unknown): boolean {
  return left === right || String(left) === String(right)
}

/**
 * 把一次请求的超时与调用方的 AbortSignal 合成一个信号。
 * 不依赖 AbortSignal.any（Hermes 上不一定有），手工挂监听，保证任何一边触发都能打断 fetch。
 */
function withTimeout(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal,
  timedOut: () => boolean,
  done: () => void,
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forward = (): void => {
    controller.abort()
  }
  if (external !== undefined) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', forward)
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', forward)
    },
  }
}

function abortedError(serverName: string): Error {
  // name 保持 AbortError：上层的取消逻辑（agent 循环里那套）认这个名字。
  const error = new Error(`MCP 服务器 ${serverName} 的请求已取消`)
  error.name = 'AbortError'
  return error
}

/**
 * 按 SSE 的事件框切出所有 data 载荷。
 * 只认 data: 行：注释行（: 开头的心跳）与 event:/id:/retry: 都与 JSON-RPC 无关，跳过即可。
 */
function parseSsePayloads(body: string, serverName: string): unknown[] {
  const payloads: unknown[] = []
  let data: string[] = []
  const flush = (): void => {
    if (data.length === 0) return
    // 同一条事件里的多行 data 按 SSE 规范用换行拼起来
    const joined = data.join('\n')
    data = []
    if (joined.trim() === '') return
    payloads.push(parseJson(joined, serverName))
  }
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    data.push(line.slice('data:'.length).replace(/^ /, ''))
  }
  flush()
  return payloads
}

/**
 * 从一次 SSE 响应里挑出属于本次请求的那条 JSON-RPC 响应。
 * 同一条流里可以夹带通知（没有 id），甚至夹带别的响应，所以先按 id 精确匹配，
 * 匹配不上再退而取第一条带 result/error 的——顺序取错会把"别人的结果"当成自己的。
 */
function pickSseResponse(body: string, id: number, serverName: string): JsonRpcMessage {
  const responses = parseSsePayloads(body, serverName)
    .filter((payload): payload is JsonRpcMessage => isRecord(payload) && ('result' in payload || 'error' in payload))
  const chosen = responses.find(candidate => sameId(candidate.id, id)) ?? responses[0]
  if (chosen === undefined) throw new Error(`MCP 服务器 ${serverName} 的 SSE 响应里没有 JSON-RPC 结果`)
  return chosen
}

// ─────────────────────────────────────────────────────────── 工具名

/** 非 [a-z0-9] 一律换成 '-'：连下划线也换掉，所以规范化结果里不可能自带 '__'。 */
function kebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-')
}

/** 桌面 DSH 的命名约定：mcp__<server>__<tool> */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${kebab(serverName)}${TOOL_SEPARATOR}${kebab(toolName)}`
}

/**
 * 从 rest（已去掉 mcp__ 前缀的部分）里切出 server 与 tool。
 * 默认用最后一个 '__' 切；只有当切出来的 server 段自己还含 '__'（说明对面给的是
 * 没规范化过的名字，例如手工拼的 mcp__a__b__c）时，退回用第一个 '__' 切，
 * 让 tool 段把 '__' 保留下来——两种情况都不会把 server 名切错成半截。
 */
function splitName(rest: string): { server: string, tool: string } | null {
  const cut = (index: number): { server: string, tool: string } | null => {
    if (index <= 0) return null
    const server = rest.slice(0, index)
    const tool = rest.slice(index + TOOL_SEPARATOR.length)
    if (server === '' || tool === '') return null
    return { server, tool }
  }
  const byLast = cut(rest.lastIndexOf(TOOL_SEPARATOR))
  if (byLast !== null && !byLast.server.includes(TOOL_SEPARATOR)) return byLast
  return cut(rest.indexOf(TOOL_SEPARATOR))
}

/** 从公开工具名反解出 (server, tool)；不是 mcp__ 命名的返回 null。 */
export function parseMcpToolName(full: string): { server: string, tool: string } | null {
  if (!full.startsWith(TOOL_PREFIX)) return null
  return splitName(full.slice(TOOL_PREFIX.length))
}

// ─────────────────────────────────────────────────────────── 客户端

export class McpClient {
  private readonly config: McpServerConfig
  /** 握手时服务端下发的会话 id；之后每个请求都要带上它。 */
  private sessionId: string | null = null
  /** 协商后的协议版本，握手成功后按规范放进后续请求的 MCP-Protocol-Version 头。 */
  private negotiatedVersion: string | null = null
  private nextId = 1
  private closed = false

  constructor(config: McpServerConfig) {
    // 配置错了就当场报出来：等到发请求时才炸，排查成本高得多。
    if (config.name.trim() === '') throw new Error('MCP 服务器需要一个非空的 name（工具名前缀要用它）')
    if (config.url.trim() === '') throw new Error(`MCP 服务器 ${config.name} 缺少 url`)
    this.config = config
  }

  /** initialize → notifications/initialized → tools/list */
  async connect(signal?: AbortSignal): Promise<McpConnectResult> {
    // 重新连接 = 重新握手：丢掉上一轮的会话，避免拿着过期 session id 去撞 404。
    this.sessionId = null
    this.negotiatedVersion = null

    const initialized = asRecord(await this.request('initialize', {
      protocolVersion: MCP_DEFAULTS.protocolVersion,
      // 我们只用工具；roots / sampling 不声明，服务端就不该拿它们来问我们。
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    }, signal))

    const protocolVersion = asString(initialized.protocolVersion, MCP_DEFAULTS.protocolVersion)
    this.negotiatedVersion = protocolVersion
    const serverInfo = asRecord(initialized.serverInfo)

    // 这是通知：服务端按规范回 202、没有 body。照样 await，链路断了要当场知道。
    await this.notify('notifications/initialized', {}, signal)

    const tools = await this.listTools(signal)
    return {
      protocolVersion,
      // 服务端没自报名字时用配置名兜底，总比空字符串好
      serverName: asString(serverInfo.name, this.config.name),
      serverVersion: asString(serverInfo.version, 'unknown'),
      tools,
    }
  }

  /** 返回拼接后的文本与是否出错 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string, isError: boolean }> {
    const result = asRecord(await this.request('tools/call', { name, arguments: args }, signal))
    if (!Array.isArray(result.content)) {
      throw new Error(`MCP 服务器 ${this.config.name} 的 tools/call 没有返回 content 数组`)
    }
    const parts: string[] = []
    for (const block of result.content) {
      const record = asRecord(block)
      const type = asString(record.type, 'unknown')
      // 文本块按顺序拼起来；图片/音频/资源这类只留占位，让模型知道"这里有东西但读不了"
      if (type === 'text' && typeof record.text === 'string') parts.push(record.text)
      else parts.push(`[${type}]`)
    }
    return { text: parts.join('\n'), isError: result.isError === true }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const sessionId = this.sessionId
    this.sessionId = null
    if (sessionId === null) return
    // 尽力而为地告诉服务端会话结束（规范里的 DELETE）。close() 是同步的，所以只发不等：
    // 失败也无所谓，服务端自己会回收过期会话，而卡在这里等网络回包更糟。
    try {
      void fetch(this.config.url, {
        method: 'DELETE',
        headers: { ...this.config.headers, 'mcp-session-id': sessionId },
      }).catch(() => undefined)
    } catch {
      // fetch 都不可用（例如运行环境收尾阶段）就什么都不做
    }
  }

  // ───────────────────────────────────────── 内部

  private async listTools(signal: AbortSignal | undefined): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params: Record<string, unknown> = cursor === null ? {} : { cursor }
      const result = asRecord(await this.request('tools/list', params, signal))
      const entries = Array.isArray(result.tools) ? result.tools : []
      for (const entry of entries) {
        const record = asRecord(entry)
        const name = asString(record.name)
        // 没名字的工具没法注册成工具，直接跳过（服务端脏数据不该毁掉整份清单）
        if (name === '') continue
        tools.push({
          name,
          description: asString(record.description),
          inputSchema: asRecord(record.inputSchema),
        })
      }
      const next = result.nextCursor
      if (typeof next !== 'string' || next === '') break
      cursor = next
    }
    return tools
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 规范要求两种都声明：服务端可能用 JSON 直接回，也可能改成 SSE 流回，客户端都得吃下
      accept: 'application/json, text/event-stream',
      ...this.config.headers,
    }
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId
    // 协议版本头只在握手之后才带：initialize 本身就是用来协商版本的
    if (this.negotiatedVersion !== null) headers['mcp-protocol-version'] = this.negotiatedVersion
    return headers
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, id, signal)
    if (response === null) throw new Error(`MCP 服务器 ${this.config.name} 对 ${method} 没有返回响应`)
    const error = response.error
    if (isRecord(error)) {
      const code = typeof error.code === 'number' ? error.code : '?'
      throw new Error(`MCP 服务器 ${this.config.name} 报错（${code}）：${asString(error.message, '服务端没有给出错误信息')}`)
    }
    if (error !== undefined && error !== null) {
      throw new Error(`MCP 服务器 ${this.config.name} 报错（没有错误码）：${snippet(String(error))}`)
    }
    if (!('result' in response)) throw new Error(`MCP 服务器 ${this.config.name} 的 ${method} 响应里既没有 result 也没有 error`)
    return response.result
  }

  private async notify(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // id 传 null 表示这是通知：服务端回 202 且没有 body，不需要解析
    await this.post({ jsonrpc: '2.0', method, params }, null, signal)
  }

  /** 一次 POST。id 为 null 时按通知处理（不等 body）。 */
  private async post(
    body: JsonRpcRequest | JsonRpcNotification,
    id: number | null,
    signal: AbortSignal | undefined,
  ): Promise<JsonRpcMessage | null> {
    const name = this.config.name
    if (this.closed) throw new Error(`MCP 服务器 ${name} 的连接已关闭`)
    const timeoutMs = MCP_DEFAULTS.requestTimeoutMs
    const combined = withTimeout(signal, timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(this.config.url, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify(body),
          signal: combined.signal,
        })
      } catch (cause) {
        // 只把"连不上"归到这一类；超时与取消在下面统一判，免得错误信息说错原因
        throw new Error(`MCP 服务器 ${name} 连不上：${this.config.url}（${messageOf(cause)}）`)
      }

      // 非 2xx 也先把 body 读出来：错误信息里带上服务端原话，排查快得多
      const raw = await response.text()
      if (!response.ok) {
        const detail = snippet(raw)
        throw new Error(`MCP 服务器 ${name} 返回 ${response.status}${detail === '' ? '' : `：${detail}`}`)
      }

      // 服务端可以在任何响应里下发/续期会话 id，见到就收下
      const session = response.headers.get('mcp-session-id')
      if (typeof session === 'string' && session !== '') this.sessionId = session

      if (id === null) return null

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/event-stream')) return pickSseResponse(raw, id, name)
      if (raw.trim() === '') throw new Error(`MCP 服务器 ${name} 的响应体是空的（期待 application/json）`)
      return asRpcMessage(parseJson(raw, name), name)
    } catch (cause) {
      // 超时/取消优先判：fetch 被中断时抛的是环境相关的错误，直接透传会看不出真因
      if (combined.timedOut()) throw new Error(`MCP 服务器 ${name} 请求超时（${timeoutMs} 毫秒）`)
      if (signal?.aborted === true) throw abortedError(name)
      throw cause
    } finally {
      combined.done()
    }
  }
}
