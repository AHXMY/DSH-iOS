/**
 * MCP streamable-http 客户端的离线验证。
 *
 * 手机上没法自动化测试一个网络客户端，所以把 mock 服务器和客户端都拉进同一个 Node 进程里对打：
 * mock 用 node:http 现场 listen 随机端口（不 spawn 子进程，免得进程间时序把结论搅浑），
 * 客户端用全局 fetch 连上去。覆盖的几条路都是"写错了会很难查"的：
 *   · 工具名的规范化与反解（模型侧的工具名全靠它拼）
 *   · 握手 / 工具清单 / 调用工具的正常链路
 *   · SSE 形态（响应是流、流里还夹着通知和 id 不匹配的假响应）
 *   · 会话校验（缺 session id 服务端必须拒绝；客户端必须带上它）
 *   · 坏数据、非 2xx、JSON-RPC error、超时与取消
 *
 *   npx tsx scripts/test-mcp.mts
 */
import { MCP_DEFAULTS, McpClient, mcpToolName, parseMcpToolName } from '../src/agent/mcp.ts'
import { MOCK_PROTOCOL_VERSION, MOCK_SERVER_INFO, MOCK_TOOLS, startMockMcpServer } from './mock-mcp-server.mjs'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail === '' ? '' : `  —  ${detail}`}`)
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, same, same ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

/** 期望抛错，并且错误信息里带上关键片段——只判"抛了没抛"会把错误的原因漏掉。 */
async function rejects(name: string, run: () => Promise<unknown>, expectIncludes: string): Promise<void> {
  let message: string | null = null
  try {
    await run()
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause)
  }
  if (message === null) {
    check(name, false, '本该抛错却成功了')
    return
  }
  check(name, message.includes(expectIncludes), `期望错误信息含「${expectIncludes}」，实际「${message}」`)
}

const server = await startMockMcpServer()
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

try {
  // ═══════════════════════════════════════════════════ 工具名规范化

  section('工具名规范化')

  equal('标准形态', mcpToolName('fs', 'read_file'), 'mcp__fs__read-file')
  equal('大写与空格也被规范化', mcpToolName('Git Hub', 'Read File'), 'mcp__git-hub__read-file')
  equal('点号/斜杠这类字符换成一个 -', mcpToolName('a.b/c', 'x.y'), 'mcp__a-b-c__x-y')
  equal('反解回两段', parseMcpToolName('mcp__fs__read-file'), { server: 'fs', tool: 'read-file' })
  equal('规范化后往返一致（含 __ 的工具名）', parseMcpToolName(mcpToolName('my-server', 'do__stuff')),
    { server: 'my-server', tool: 'do--stuff' })
  equal('没有 mcp__ 前缀的返回 null', parseMcpToolName('read_file'), null)
  equal('前缀不完整（mcp_）也返回 null', parseMcpToolName('mcp_fs__read'), null)
  equal('server 段为空返回 null', parseMcpToolName('mcp____tool'), null)
  equal('tool 段为空返回 null', parseMcpToolName('mcp__fs__'), null)
  equal('没有分隔符返回 null', parseMcpToolName('mcp__fsonly'), null)
  // 手工拼的、未经规范化的名字（server 段带 __）：退回用第一个分隔符切，让 tool 段保留 __
  equal('server 段含 __ 时退回按第一个分隔符切', parseMcpToolName('mcp__fs__a__b'), { server: 'fs', tool: 'a__b' })

  // ═══════════════════════════════════════════════════ 握手与工具清单

  section('握手与工具清单（application/json 形态）')

  const client = new McpClient({ name: 'fs', url: server.url, headers: { 'x-mock-token': 'token-123' } })
  const connected = await client.connect()

  equal('协议版本', connected.protocolVersion, MOCK_PROTOCOL_VERSION)
  equal('serverName', connected.serverName, MOCK_SERVER_INFO.name)
  equal('serverVersion', connected.serverVersion, MOCK_SERVER_INFO.version)
  equal('工具清单齐全', connected.tools.map(tool => tool.name), MOCK_TOOLS.map(tool => tool.name))
  equal('工具名不带前缀', connected.tools[0]?.name, 'echo')
  check('描述被透传', (connected.tools[0]?.description ?? '') === MOCK_TOOLS[0].description)
  check('inputSchema 被透传', JSON.stringify(connected.tools[0]?.inputSchema).includes('"required":["text"]'))
  check('没有描述的工具有空描述兜底',
    connected.tools.every(tool => typeof tool.description === 'string' && typeof tool.inputSchema === 'object'))

  const initializeEntry = server.requests.find(entry => entry.rpc?.method === 'initialize')
  const listEntry = server.requests.find(entry => entry.rpc?.method === 'tools/list')
  const initializedEntry = server.requests.find(entry => entry.rpc?.method === 'notifications/initialized')

  check('握手请求带 protocolVersion', initializeEntry?.rpc?.params?.protocolVersion === MCP_DEFAULTS.protocolVersion)
  check('握手请求带 clientInfo', typeof initializeEntry?.rpc?.params?.clientInfo?.name === 'string')
  check('握手请求不带 session 头', initializeEntry?.headers['mcp-session-id'] === undefined)
  equal('Accept 同时声明两种形态', initializeEntry?.headers.accept, 'application/json, text/event-stream')
  check('自定义 header 被发出', initializeEntry?.headers['x-mock-token'] === 'token-123')
  check('initialized 是通知（没有 id）', initializedEntry !== undefined && initializedEntry.rpc.id === undefined)
  check('握手后每个请求都带上 session 头',
    typeof listEntry?.headers['mcp-session-id'] === 'string' && (listEntry?.headers['mcp-session-id'] ?? '').length > 0)
  check('握手后才带 MCP-Protocol-Version 头', listEntry?.headers['mcp-protocol-version'] === MOCK_PROTOCOL_VERSION)

  const initializeCount = server.requests.filter(entry => entry.rpc?.method === 'initialize').length
  const twice = new McpClient({ name: 'fs', url: server.url })
  await twice.connect()
  const again = await twice.connect()
  equal('重复 connect 会重新握手', again.tools.length, MOCK_TOOLS.length)
  equal('重复 connect 真的又握了两次手',
    server.requests.filter(entry => entry.rpc?.method === 'initialize').length - initializeCount, 2)
  twice.close()

  // ═══════════════════════════════════════════════════ 调用工具

  section('调用工具')

  const echoed = await client.callTool('echo', { text: '你好' })
  equal('文本结果', echoed.text, 'echo: 你好')
  equal('正常调用不是错误', echoed.isError, false)
  equal('发出去的是原始工具名（不带 mcp__ 前缀）', server.calls.at(-1)?.name, 'echo')
  equal('参数被透传', server.calls.at(-1)?.args?.text, '你好')

  const blocks = await client.callTool('multi_block', {})
  equal('多内容块按顺序拼接、非文本块给占位', blocks.text, '第一块\n[image]\n第二块')
  equal('多内容块不算错误', blocks.isError, false)

  const failedCall = await client.callTool('boom', { reason: '校验没过' })
  equal('isError 如实上报', failedCall.isError, true)
  check('失败时仍然带回文本', failedCall.text.includes('校验没过'), failedCall.text)

  const unknown = await client.callTool('no_such_tool', {})
  equal('未知工具按 isError 结果回答', unknown.isError, true)

  await rejects('JSON-RPC error 抛带中文的 Error', () => client.callTool('explode', {}),
    'MCP 服务器 fs 报错（-32603）')

  // ═══════════════════════════════════════════════════ SSE 形态

  section('SSE 形态（text/event-stream）')

  const sseClient = new McpClient({ name: 'sse', url: server.urlFor({ mode: 'sse' }) })
  const sseConnected = await sseClient.connect()
  equal('SSE 形态也能握手', sseConnected.serverName, MOCK_SERVER_INFO.name)
  equal('流里的通知被跳过，工具清单完整', sseConnected.tools.length, MOCK_TOOLS.length)
  equal('SSE 形态能调工具', (await sseClient.callTool('echo', { text: 'sse' })).text, 'echo: sse')
  sseClient.close()

  const decoyClient = new McpClient({ name: 'sse-decoy', url: server.urlFor({ mode: 'sse', mismatched: 1 }) })
  const decoyConnected = await decoyClient.connect()
  // 假响应里塞的是空工具清单：只有按 id 匹配才拿得到真清单
  equal('流里先来一条 id 不匹配的响应也能挑对', decoyConnected.tools.length, MOCK_TOOLS.length)
  decoyClient.close()

  const multilineClient = new McpClient({
    name: 'sse-multiline',
    url: server.urlFor({ mode: 'sse', multiline: 1, mismatched: 1 }),
  })
  equal('一条事件拆成多行 data 也能拼回来', (await multilineClient.connect()).tools.length, MOCK_TOOLS.length)
  equal('多行 data 时也能调工具', (await multilineClient.callTool('echo', { text: '多行' })).text, 'echo: 多行')
  multilineClient.close()

  // ═══════════════════════════════════════════════════ 会话校验

  section('会话校验')

  const withoutSession = await fetch(server.url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} }),
  })
  equal('缺 session id → 服务端 400', withoutSession.status, 400)
  const withoutSessionBody = await withoutSession.json()
  check('拒绝理由点名了会话头',
    String(withoutSessionBody.error?.message ?? '').includes('Mcp-Session-Id'),
    JSON.stringify(withoutSessionBody))

  const bogusSession = await fetch(server.url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-session-id': 'bogus-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} }),
  })
  equal('未知 session → 服务端 404', bogusSession.status, 404)

  const rawInit = await fetch(server.url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 103, method: 'initialize',
      params: { protocolVersion: MOCK_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }),
  })
  const rawSession = rawInit.headers.get('mcp-session-id')
  check('initialize 响应下发 Mcp-Session-Id', typeof rawSession === 'string' && rawSession.length > 0)

  const rawList = await fetch(server.url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-session-id': String(rawSession) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 104, method: 'tools/list', params: {} }),
  })
  equal('带上正确 session 就放行', rawList.status, 200)

  const unsupported = await fetch(server.url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-session-id': String(rawSession) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 105, method: 'prompts/list', params: {} }),
  })
  const unsupportedBody = await unsupported.json()
  equal('不支持的方法回 -32601', unsupportedBody.error?.code, -32601)
  check('错误信息点名了方法', String(unsupportedBody.error?.message ?? '').includes('prompts/list'))

  const forgetting = new McpClient({ name: 'fs', url: server.urlFor({ forget: 1 }) })
  await rejects('服务端会话失效时抛带状态码的错误', () => forgetting.connect(), '返回 404')
  forgetting.close()

  const unauthorized = new McpClient({ name: 'fs', url: server.urlFor({ status: 401 }) })
  await rejects('非 2xx 抛「MCP 服务器 fs 返回 401」', () => unauthorized.connect(), 'MCP 服务器 fs 返回 401')

  // ═══════════════════════════════════════════════════ 坏数据

  section('坏数据')

  await rejects('响应体不是合法 JSON 时报错',
    () => new McpClient({ name: 'fs', url: server.urlFor({ body: 'garbage' }) }).connect(), '不是合法 JSON')
  await rejects('SSE 流里的坏数据同样报错',
    () => new McpClient({ name: 'fs', url: server.urlFor({ body: 'garbage', mode: 'sse' }) }).connect(), '不是合法 JSON')
  await rejects('空响应体报错',
    () => new McpClient({ name: 'fs', url: server.urlFor({ body: 'empty' }) }).connect(), '响应体是空的')

  // ═══════════════════════════════════════════════════ 超时与取消

  section('超时与取消')

  const defaultTimeout = MCP_DEFAULTS.requestTimeoutMs
  MCP_DEFAULTS.requestTimeoutMs = 250
  try {
    await rejects('超时抛可读错误',
      () => new McpClient({ name: 'fs', url: server.urlFor({ delay: 800 }) }).connect(),
      '请求超时（250 毫秒）')
  } finally {
    MCP_DEFAULTS.requestTimeoutMs = defaultTimeout
  }
  equal('默认超时是 20 秒', defaultTimeout, 20_000)

  const controller = new AbortController()
  const aborting = new McpClient({ name: 'fs', url: server.urlFor({ delay: 800 }) })
  setTimeout(() => controller.abort(), 120)
  await rejects('外部 AbortSignal 能打断在途请求', () => aborting.connect(controller.signal), '已取消')

  const preAborted = new AbortController()
  preAborted.abort()
  await rejects('已取消的信号立刻失败（不必等超时）',
    () => new McpClient({ name: 'fs', url: server.urlFor({ delay: 800 }) }).connect(preAborted.signal), '已取消')

  // ═══════════════════════════════════════════════════ 关闭

  section('关闭')

  client.close()
  await rejects('关闭后调用直接报错', () => client.callTool('echo', { text: 'x' }), '连接已关闭')

  let closeThrew = false
  try {
    client.close()
  } catch {
    closeThrew = true
  }
  check('重复 close 不炸', closeThrew === false)
} finally {
  await server.close()
}

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
