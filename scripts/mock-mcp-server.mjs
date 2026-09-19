/**
 * 零依赖的 mock MCP 服务器 —— streamable-http 传输的**服务端一侧**。
 *
 * 存在的意义是给 src/agent/mcp.ts 一个能真跑的对手：单端点 POST JSON-RPC、
 * 响应可能是 application/json 也可能是 text/event-stream、会话靠 Mcp-Session-Id 头维持。
 * 除了正常路径，它还刻意留了一批"坏天气"开关（见 QUERY_SWITCHES），
 * 让测试能把客户端的错误分支也真跑一遍，而不是只验证顺利的时候。
 *
 * 两种用法：
 *   · 被 scripts/test-mcp.mts import：startMockMcpServer() 在**同一个进程内** listen 随机端口
 *     （测试不 spawn 子进程，免得进程间时序问题把结论搅浑）；
 *   · 单独跑：node scripts/mock-mcp-server.mjs（默认 8787，或用 PORT=xxxx 指定）。
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/** 服务端在 initialize 里自报的身份；测试会断言客户端把它透传出来。 */
export const MOCK_SERVER_INFO = { name: 'mock-mcp', version: '1.2.3' }

/** 本 mock 只认这一个协议版本（客户端声明别的也可以，服务端有权回自己的）。 */
export const MOCK_PROTOCOL_VERSION = '2025-06-18'

/**
 * 暴露的工具。四个是刻意配齐的：一个正常、一个多内容块、一个 isError、
 * 一个回 JSON-RPC error（服务端自身故障），刚好覆盖客户端结果处理的四条分支。
 */
export const MOCK_TOOLS = [
  {
    name: 'echo',
    description: '把传入的 text 原样回显，用来验证正常调用链路。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'multi_block',
    description: '返回三个内容块（文本 / 图片 / 文本），用来验证客户端对非文本块的占位处理。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'boom',
    description: '故意失败的工具：以 isError: true 返回，而不是抛协议错误。',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: '失败原因，会出现在文本里' } },
      additionalProperties: false,
    },
  },
  {
    name: 'explode',
    description: '模拟服务端自身故障：直接回 JSON-RPC error（-32603），用来验证客户端的 error 分支。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** 查询串开关一览（单独跑时打印出来，省得回头翻代码）。 */
export const QUERY_SWITCHES = [
  'mode=sse —— 用 text/event-stream 回响应（默认 json）',
  'noise=0 —— 关掉 SSE 流里的通知干扰（默认开：先发一条通知再发真响应）',
  'mismatched=1 —— SSE 流里先塞一条 id 不匹配的假响应（默认不塞）',
  'multiline=1 —— 把一条 JSON-RPC 消息拆成多行 data（验证 SSE 事件框的拼接）',
  'body=garbage|empty —— 回坏响应体（非 JSON / 空），两行代码就能验证客户端的解析报错',
  'status=401 —— 直接以该状态码拒绝，验证客户端的非 2xx 分支',
  'delay=800 —— 响应前先睡这么多毫秒，验证客户端超时与取消',
  'forget=1 —— 每个请求都先清空会话表（模拟会话过期 / 服务端重启）',
]

/** 一次工具调用的结果：要么 { result }，要么 { error }（JSON-RPC 层错误）。 */
function callMockTool(name, args) {
  switch (name) {
    case 'echo':
      return { result: { content: [{ type: 'text', text: `echo: ${typeof args.text === 'string' ? args.text : ''}` }] } }
    case 'multi_block':
      return {
        result: {
          content: [
            { type: 'text', text: '第一块' },
            // 真实的 data 这里会是 base64；客户端只该给个占位，所以内容不重要
            { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png' },
            { type: 'text', text: '第二块' },
          ],
        },
      }
    case 'boom':
      return {
        result: {
          content: [{ type: 'text', text: `故意失败：${typeof args.reason === 'string' ? args.reason : '没给理由'}` }],
          isError: true,
        },
      }
    case 'explode':
      return { error: { code: -32603, message: '工具执行内部错误（mock 按脚本炸的）' } }
    default:
      // 未知工具按规范用 isError 结果回答，而不是协议错误
      return { result: { content: [{ type: 'text', text: `mock 服务器上没有名为 ${String(name)} 的工具` }], isError: true } }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 连接可能已经被客户端 abort 掉了，写之前先看一眼，免得在死 socket 上抛错。 */
function alive(response) {
  return !response.writableEnded && !response.destroyed
}

function sendJson(response, status, payload) {
  if (!alive(response)) return
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * 启动 mock 服务器。
 *
 * @param {{ host?: string, port?: number, path?: string, mode?: 'json'|'sse' }} [options]
 * @returns {Promise<{ host: string, port: number, url: string, path: string, mode: string,
 *   urlFor: (switches?: Record<string, string|number>) => string,
 *   requests: Array<object>, calls: Array<{name: string, args: object}>, sessions: Set<string>,
 *   close: () => Promise<void> }>}
 */
export async function startMockMcpServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const path = options.path ?? '/mcp'
  const defaultMode = options.mode ?? 'json'

  const sessions = new Set()
  /** 收到的每个请求都记一笔：测试要断言客户端到底发了什么头、什么方法、什么工具名。 */
  const requests = []
  /** tools/call 的入参流水，用来验证客户端发的是**原始**工具名而不是 mcp__ 前缀名。 */
  const calls = []

  const server = createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      sendJson(response, 500, { mock: `mock 服务器内部异常：${error instanceof Error ? error.message : String(error)}` })
    })
  })

  /** 按 SSE 事件框回一串 JSON-RPC 消息（客户端要能跳过通知、按 id 挑出真响应）。 */
  function sendSse(response, messages, extraHeaders = {}, multiline = false) {
    if (!alive(response)) return
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...extraHeaders })
    // 注释行是合法的心跳，客户端必须忽略它
    response.write(': mock 心跳\n\n')
    for (const message of messages) {
      const serialized = JSON.stringify(message)
      if (!multiline || message.id === undefined) {
        response.write(`event: message\ndata: ${serialized}\n\n`)
        continue
      }
      // 把一个 JSON-RPC 消息拆成两行 data（切在顶层逗号处，不会切坏字符串字面量）：
      // SSE 规范要求同一事件的多行 data 用换行拼回来，第二行还刻意不带空格。
      const head = `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)}`
      response.write(`event: message\ndata: ${head}\ndata:${serialized.slice(head.length)}\n\n`)
    }
    response.end()
  }

  /** 统一的响应出口：形态（json/sse）、会话头、以及那批坏天气开关都在这里落地。 */
  function sendRpcResponse(response, query, message, payload, extra = {}) {
    const mode = query.get('mode') ?? defaultMode
    const sse = mode === 'sse'
    const override = query.get('body')

    if (override === 'empty') {
      if (!alive(response)) return
      response.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' })
      return response.end('')
    }
    if (override === 'garbage') {
      if (!alive(response)) return
      if (sse) return sendSseRaw(response, 'event: message\ndata: {这不是 JSON\n\n')
      const body = '<html><body>上游代理插了一页 HTML</body></html>'
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      return response.end(body)
    }

    const extraHeaders = extra.sessionId === undefined ? {} : { 'mcp-session-id': extra.sessionId }
    if (!sse) {
      if (!alive(response)) return
      const body = JSON.stringify(payload)
      response.writeHead(200, { 'content-type': 'application/json', ...extraHeaders, 'content-length': Buffer.byteLength(body) })
      return response.end(body)
    }

    const messages = []
    if (query.get('noise') !== '0') {
      messages.push({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'mock 服务器先喷一条通知' } })
    }
    if (query.get('mismatched') === '1') {
      const decoyId = typeof message.id === 'number' ? message.id + 9001 : 9001
      messages.push({ jsonrpc: '2.0', id: decoyId, result: { tools: [], decoy: true, note: '这条的 id 不匹配，客户端不该采用它' } })
    }
    messages.push(payload)
    return sendSse(response, messages, extraHeaders, query.get('multiline') === '1')
  }

  function sendSseRaw(response, raw) {
    if (!alive(response)) return
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.end(raw)
  }

  async function handlePost(request, response, query, entry) {
    // 非 2xx 开关：整条连接提前失败，验证客户端的 HTTP 错误分支
    const status = Number(query.get('status') ?? 0)
    if (Number.isFinite(status) && status >= 400) {
      return sendJson(response, status, { mock: `按 ?status=${status} 要求直接拒绝` })
    }

    const accept = String(request.headers.accept ?? '')
    if (!accept.includes('application/json')) {
      // 规范要求客户端同时声明两种可接受形态；缺了就别怪服务端不客气
      return sendJson(response, 406, { mock: `Accept 头必须同时包含 application/json 与 text/event-stream，收到：${accept}` })
    }

    const raw = await readBody(request)
    entry.body = raw
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return sendJson(response, 400, jsonRpcError(null, -32700, '请求体不是合法 JSON'))
    }
    entry.rpc = message
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return sendJson(response, 400, jsonRpcError(message?.id, -32600, 'Invalid Request：jsonrpc 必须是 2.0 且 method 必须存在'))
    }

    if (query.get('forget') === '1') sessions.clear()

    const sessionId = request.headers['mcp-session-id']
    if (message.method !== 'initialize') {
      // 规范：需要会话却没带 → 400；带了但服务端不认识 → 404
      if (sessionId === undefined || sessionId === '') {
        return sendJson(response, 400, jsonRpcError(message.id, -32000, '缺少 Mcp-Session-Id 头'))
      }
      if (!sessions.has(sessionId)) {
        return sendJson(response, 404, jsonRpcError(message.id, -32000, `未知会话 ${sessionId}`))
      }
    }

    const delay = Number(query.get('delay') ?? 0)
    if (Number.isFinite(delay) && delay > 0) await sleep(delay)

    if (message.method === 'initialize') {
      const created = randomUUID()
      sessions.add(created)
      return sendRpcResponse(response, query, message, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: MOCK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MOCK_SERVER_INFO,
        },
      }, { sessionId: created })
    }

    // 通知（没有 id）：规范要求回 202 且不带 body
    if (message.id === undefined || message.id === null) {
      if (!alive(response)) return
      response.writeHead(202)
      return response.end()
    }

    if (message.method === 'tools/list') {
      return sendRpcResponse(response, query, message, {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: MOCK_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
      })
    }

    if (message.method === 'tools/call') {
      const params = message.params ?? {}
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
      calls.push({ name, args })
      const outcome = callMockTool(name, args)
      return sendRpcResponse(response, query, message, outcome.error !== undefined
        ? jsonRpcError(message.id, outcome.error.code, outcome.error.message)
        : { jsonrpc: '2.0', id: message.id, result: outcome.result })
    }

    // 其余方法（prompts/list、resources/list、工具订阅……）这个 mock 都不支持
    return sendRpcResponse(response, query, message,
      jsonRpcError(message.id, -32601, `Method not found: ${message.method}`))
  }

  function handleDelete(request, response) {
    const sessionId = request.headers['mcp-session-id']
    if (sessionId === undefined || sessionId === '') return sendJson(response, 400, { mock: '缺少 Mcp-Session-Id 头' })
    if (!sessions.has(sessionId)) return sendJson(response, 404, { mock: `未知会话 ${sessionId}` })
    sessions.delete(sessionId)
    if (!alive(response)) return
    response.writeHead(204)
    response.end()
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', `http://${host}`)
    const query = url.searchParams
    const entry = {
      httpMethod: request.method,
      path: url.pathname,
      search: url.search,
      headers: request.headers,
      body: null,
      rpc: null,
    }
    requests.push(entry)

    if (url.pathname !== path) return sendJson(response, 404, { mock: `mock 服务器只挂在 ${path} 上` })
    if (request.method === 'GET') {
      // 独立 SSE 流（GET）本 mock 不提供
      return sendJson(response, 405, { mock: '这个 mock 不提供 GET 的 SSE 流' })
    }
    if (request.method === 'DELETE') return handleDelete(request, response)
    if (request.method !== 'POST') return sendJson(response, 405, { mock: `${String(request.method)} 不支持` })
    return handlePost(request, response, query, entry)
  }

  const listening = Promise.withResolvers()
  server.listen(port, host, () => listening.resolve())
  await listening.promise

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock MCP 服务器没拿到 TCP 地址')
  const base = `http://${host}:${address.port}${path}`

  return {
    host,
    port: address.port,
    path,
    mode: defaultMode,
    url: base,
    /** 带开关的 URL：urlFor({ mode: 'sse', mismatched: 1 })。 */
    urlFor(switches = {}) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(switches)) query.set(key, String(value))
      const search = query.toString()
      return search === '' ? base : `${base}?${search}`
    },
    requests,
    calls,
    sessions,
    close: () => new Promise((resolve, reject) => {
      // keep-alive 连接会拖着 close 不回调，先掐断再看
      server.closeAllConnections?.()
      server.close(error => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

// 直接 node 跑时给一个能手动 curl 的实例；被 import 时不启动任何东西。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const instance = await startMockMcpServer({
    port: Number(process.env.PORT ?? 8787),
    mode: process.env.MODE === 'sse' ? 'sse' : 'json',
  })
  console.log(`mock MCP 服务器：${instance.url}`)
  console.log(`工具：${MOCK_TOOLS.map(tool => tool.name).join(', ')}`)
  console.log('坏天气开关：')
  for (const line of QUERY_SWITCHES) console.log(`  ?${line}`)
}
