/**
 * 连通性自检。
 *
 * 这个 App 有四条"要联网才能用"的链路：模型、搜索、远程执行、MCP。
 * 任何一条断了，用户看到的都只是一句底层报错（"Network request failed" 之类），
 * 根本不知道是哪一层、更不知道下一步做什么。所以这里把诊断做成一件产品功能：
 * 一次跑完四条链路，每条给"通/不通 + 为什么 + 怎么办"。
 *
 * 顺带解决一个常见误判：**"没网"和"服务没起"看起来是一模一样的报错**。
 * 这里用"模型端点都连不上"作为设备无网的判据 —— 它是最基础的一条。
 *
 * 这一层只依赖各客户端的纯模块（它们都用 fetch），不 import expo，所以能在 Node 里验。
 */
import { createSelfHostedSearchProvider } from './searchSelfHosted'
import { createExaSearchProvider, createPerplexitySearchProvider } from './searchProviders'
import { connectMcpServers } from './mcpTools'
import { SandboxClient } from './sandbox'
import { createDeepSeekSearchProvider } from './webSearch'
import type { SearchProvider } from './webSearch'

export type CheckId = 'model' | 'search' | 'sandbox' | 'mcp'

export type CheckStatus = 'ok' | 'fail' | 'skipped'

export type CheckResult = {
  id: CheckId
  label: string
  status: CheckStatus
  detail: string
  /** 下一步做什么 */
  hint?: string
}

export type CheckConfig = {
  apiKey: string
  baseUrl: string
  model: string
  searchProvider: 'off' | 'deepseek' | 'self' | 'exa' | 'perplexity'
  searchBaseUrl: string
  searchModel: string
  searchAgentUrl: string
  searchAgentToken: string
  searchEngine: 'bing' | 'sogou'
  exaApiKey: string
  perplexityApiKey: string
  sandboxUrl: string
  sandboxToken: string
  mcpLines: string
}

/** 把底层报错翻成"人该做什么"。这是整个自检最有价值的部分。 */
export function explainFailure(raw: string): { detail: string, hint?: string } {
  const text = raw.toLowerCase()

  if (text.includes('network request failed') || text.includes('fetch failed') || text.includes('enotfound') || text.includes('econnrefused') || text.includes('getaddrinfo')) {
    return {
      detail: '连不上（DNS 或连接被拒）',
      hint: '先确认设备有网；如果只有这一条不通，说明是这个服务的地址或端口不对，或者那台机器没起。',
    }
  }
  if (text.includes('timeout') || text.includes('超时') || text.includes('abort')) {
    return { detail: '超时', hint: '地址通但对方不响应。可能是服务没起、被墙，或者网络太慢。' }
  }
  if (text.includes('401') || text.includes('unauthor')) {
    return { detail: '鉴权失败（401）', hint: 'Key 或 token 不对；也可能是这个 Key 没有该服务的权限。' }
  }
  if (text.includes('402')) {
    return { detail: '余额不足（402）', hint: '去账户充值。' }
  }
  if (text.includes('403')) {
    return { detail: '被拒绝（403）', hint: '地址对了但对方不允许你访问，检查 IP 白名单或地区限制。' }
  }
  if (text.includes('404')) {
    return { detail: '端点不存在（404）', hint: '地址大概率写错了：注意有的服务路径里带 /v1，有的不带。' }
  }
  if (text.includes('429')) {
    return { detail: '太频繁（429）', hint: '等一会儿再试，或者降并发。' }
  }
  if (text.includes('certificate') || text.includes('ssl') || text.includes('tls')) {
    return { detail: '证书问题', hint: '自签证书 iOS 会拒绝。换正式证书（Tailscale 自带），或在手机上装信任描述文件。' }
  }
  return { detail: raw }
}

const TIMEOUT_MS = 15_000

/** 拉模型清单是最轻的"模型链路是否通"的证明：不花 token，只验地址与鉴权。 */
async function checkModel(config: CheckConfig): Promise<CheckResult> {
  const label = '模型端点'
  if (config.apiKey.trim() === '') {
    return { id: 'model', label, status: 'skipped', detail: '没有填 API Key' }
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      const explained = explainFailure(`HTTP ${response.status}`)
      return { id: 'model', label, status: 'fail', detail: `${url} → ${explained.detail}`, hint: explained.hint }
    }
    const payload = await response.json() as { data?: unknown[] }
    const count = Array.isArray(payload.data) ? payload.data.length : 0
    return { id: 'model', label, status: 'ok', detail: `通了，可用模型 ${count} 个` }
  } catch (cause) {
    const explained = explainFailure(cause instanceof Error ? cause.message : String(cause))
    return { id: 'model', label, status: 'fail', detail: `${url} → ${explained.detail}`, hint: explained.hint }
  } finally {
    clearTimeout(timer)
  }
}

function buildSearchProvider(config: CheckConfig): SearchProvider | null {
  if (config.searchProvider === 'deepseek' && config.apiKey.trim() !== '') {
    return createDeepSeekSearchProvider({
      apiKey: config.apiKey,
      baseUrl: config.searchBaseUrl,
      model: config.searchModel,
    })
  }
  if (config.searchProvider === 'self' && config.searchAgentUrl.trim() !== '') {
    return createSelfHostedSearchProvider({
      url: config.searchAgentUrl,
      token: config.searchAgentToken,
      engine: config.searchEngine,
    })
  }
  if (config.searchProvider === 'exa' && config.exaApiKey.trim() !== '') {
    return createExaSearchProvider({ apiKey: config.exaApiKey })
  }
  if (config.searchProvider === 'perplexity' && config.perplexityApiKey.trim() !== '') {
    return createPerplexitySearchProvider({ apiKey: config.perplexityApiKey })
  }
  return null
}

async function checkSearch(config: CheckConfig): Promise<CheckResult> {
  const label = '联网搜索'
  const provider = buildSearchProvider(config)
  if (provider === null) {
    return { id: 'search', label, status: 'skipped', detail: '没有开启联网搜索' }
  }
  try {
    const results = await provider.search('test', { maxResults: 1 })
    return {
      id: 'search',
      label,
      status: 'ok',
      detail: `通了（${provider.label}），拿到 ${results.length} 条`,
    }
  } catch (cause) {
    const explained = explainFailure(cause instanceof Error ? cause.message : String(cause))
    const hint = config.searchProvider === 'self'
      ? '自建代理要先把 server/search-agent.mjs 跑起来，并在设置里填对地址与 token。'
      : config.searchProvider === 'exa' || config.searchProvider === 'perplexity'
        ? '检查 API Key 与余额；这两家按量计费。'
        : '这条走的是服务端的搜索工具：如果报"没有触发联网搜索"，说明这个 Key / 端点不支持，改成自建搜索代理。'
    return {
      id: 'search',
      label,
      status: 'fail',
      detail: `${provider.label} → ${explained.detail}`,
      hint: explained.hint ?? hint,
    }
  }
}

async function checkSandbox(config: CheckConfig): Promise<CheckResult> {
  const label = '远程执行'
  if (config.sandboxUrl.trim() === '' || config.sandboxToken.trim() === '') {
    return { id: 'sandbox', label, status: 'skipped', detail: '没有配置执行代理（手机本地跑不了 shell）' }
  }
  const client = new SandboxClient({ url: config.sandboxUrl, token: config.sandboxToken })
  try {
    const health = await client.health()
    return { id: 'sandbox', label, status: 'ok', detail: `通了（${health.platform}，工作目录 ${health.root}）` }
  } catch (cause) {
    const explained = explainFailure(cause instanceof Error ? cause.message : String(cause))
    return {
      id: 'sandbox',
      label,
      status: 'fail',
      detail: `${config.sandboxUrl} → ${explained.detail}`,
      hint: '部署见 server/README.md：先跑 server/exec-agent.mjs，再确认手机能访问到它的地址（Tailscale 或 nginx 门禁）。',
    }
  }
}

async function checkMcp(config: CheckConfig): Promise<CheckResult> {
  const label = 'MCP 服务器'
  if (config.mcpLines.trim() === '') {
    return { id: 'mcp', label, status: 'skipped', detail: '没有配置 MCP 服务器' }
  }
  try {
    const registration = await connectMcpServers(config.mcpLines)
    const detail = registration.connected.length === 0
      ? registration.failures.map(failure => `${failure.name}：${failure.message}`).join('；')
      : `已连上 ${registration.connected.map(server => `${server.name}(${server.toolCount})`).join('、')}`
    const failed = registration.failures.length > 0
    registration.close()
    return {
      id: 'mcp',
      label,
      status: failed && registration.connected.length === 0 ? 'fail' : 'ok',
      detail: failed && registration.connected.length > 0 ? `${detail}；连不上：${registration.failures.map(f => f.name).join('、')}` : detail,
      hint: failed ? 'iOS 只能连 streamable-http 的 MCP；stdio 的连不了。检查 url 是否以 /mcp 结尾、token 是否对。' : undefined,
    }
  } catch (cause) {
    const explained = explainFailure(cause instanceof Error ? cause.message : String(cause))
    return { id: 'mcp', label, status: 'fail', detail: explained.detail, hint: explained.hint }
  }
}

/**
 * 跑完四条链路。
 *
 * 并发跑：四条互相独立，串行跑只会让人等四次超时。
 * 顺序固定（模型 → 搜索 → 执行 → MCP），因为界面上按"从基础到附加"读最顺。
 */
export async function runConnectivityChecks(config: CheckConfig): Promise<CheckResult[]> {
  const [model, search, sandbox, mcp] = await Promise.all([
    checkModel(config),
    checkSearch(config),
    checkSandbox(config),
    checkMcp(config),
  ])

  // 模型链路都不通，多半是设备没网 —— 其余失败就都是它的后果，别让用户去查四条。
  // 注意：只给失败的条目换提示，成功与"未启用"的照旧列出来（藏起来反而让人以为没测）。
  if (model.status === 'fail' && model.detail.includes('连不上')) {
    return [model, search, sandbox, mcp].map(result => result.status === 'fail'
      ? { ...result, hint: '设备当前可能没有网络：模型端点都连不上，其余失败大概率是同一个原因。先确认网络，再重跑自检。' }
      : result)
  }

  return [model, search, sandbox, mcp]
}

/** 给界面用的一句话总结。 */
export function summarize(results: CheckResult[]): string {
  const failures = results.filter(result => result.status === 'fail').length
  const ok = results.filter(result => result.status === 'ok').length
  const skipped = results.filter(result => result.status === 'skipped').length
  if (failures === 0) return `${ok} 条链路正常${skipped > 0 ? `，${skipped} 条未启用` : ''}`
  return `${ok} 条正常，${failures} 条不通${skipped > 0 ? `，${skipped} 条未启用` : ''}`
}
