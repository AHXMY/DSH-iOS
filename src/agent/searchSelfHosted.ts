/**
 * 自建搜索代理的客户端。
 *
 * 为什么要这条：模型自己的联网搜索依赖服务端工具（DeepSeek 那套走 Anthropic 兼容端点），
 * 未必人人可用。而"抓搜索页"这件事很挑网络——实测在这张网络里
 * **DuckDuckGo / Brave / 360 全部直接超时**，能通的是 Bing 的 RSS 输出与搜狗。
 * 所以把搜索放到一台自己能控制的机器上（`server/search-agent.mjs`），
 * 引擎按"实测能通"挑，而不是按名气挑。
 *
 * 这一层同样不 import expo：它要能在 Node 里对着真 fixture 与 mock 引擎跑通。
 */
import type { SearchProvider, SearchResult } from './webSearch'
import { WebSearchError } from './webSearch'

export type SelfHostedSearchConfig = {
  /** 代理地址，例如 http://127.0.0.1:7718 或 https://box.example.com/search-agent */
  url: string
  token: string
  /** 默认引擎 */
  engine?: 'bing' | 'sogou'
  label?: string
  timeoutMs?: number
}

export const SELF_HOSTED_SEARCH_DEFAULTS = {
  engine: 'bing' as const,
  timeoutMs: 30_000,
}

type AgentResponse = {
  query?: string
  engine?: string
  took?: number
  results?: { title?: unknown, url?: unknown, snippet?: unknown, publishedAt?: unknown }[]
  error?: string
}

function normalize(raw: AgentResponse): SearchResult[] {
  const items = Array.isArray(raw.results) ? raw.results : []
  const results: SearchResult[] = []
  for (const item of items) {
    const url = typeof item.url === 'string' ? item.url : ''
    if (!/^https?:\/\//i.test(url)) continue
    const title = typeof item.title === 'string' && item.title !== '' ? item.title : url
    results.push({
      title,
      url,
      ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
      ...(typeof item.publishedAt === 'string' && item.publishedAt !== '' ? { publishedAt: item.publishedAt } : {}),
    })
  }
  return results
}

export function createSelfHostedSearchProvider(config: SelfHostedSearchConfig): SearchProvider {
  const base = config.url.replace(/\/+$/, '')
  const engine = config.engine ?? SELF_HOSTED_SEARCH_DEFAULTS.engine
  const timeoutMs = config.timeoutMs ?? SELF_HOSTED_SEARCH_DEFAULTS.timeoutMs

  return {
    id: 'self-hosted',
    label: config.label ?? `自建搜索（${engine}）`,
    async search(query, options = {}) {
      const trimmed = query.trim()
      if (trimmed === '') throw new WebSearchError('搜索词不能为空')
      if (base === '') throw new WebSearchError('没有配置搜索代理地址')
      if (config.token.trim() === '') throw new WebSearchError('没有配置搜索代理 token')
      // 已经取消的调用不能再发请求（addEventListener 对早已中止的 signal 不触发）。
      if (options.signal?.aborted === true) throw new WebSearchError('搜索已取消')

      const params = new URLSearchParams({ q: trimmed, engine })
      if (options.maxResults !== undefined) params.set('limit', String(options.maxResults))

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let callerAborted = false
      const onAbort = (): void => { callerAborted = true; controller.abort() }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      let response: Response
      try {
        response = await fetch(`${base}/search?${params.toString()}`, {
          headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
          signal: controller.signal,
        })
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new WebSearchError(callerAborted ? '搜索已取消' : `搜索代理超时（${timeoutMs / 1000}s）`)
        }
        throw new WebSearchError(`连不上搜索代理（${base}）：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      const text = await response.text()
      let payload: AgentResponse = {}
      try {
        payload = text === '' ? {} : JSON.parse(text) as AgentResponse
      } catch {
        throw new WebSearchError(`搜索代理返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
      }

      if (!response.ok) {
        const detail = typeof payload.error === 'string' ? payload.error : text.slice(0, 200)
        if (response.status === 401) throw new WebSearchError('搜索代理拒绝了这次请求（token 不对）')
        if (response.status === 404) throw new WebSearchError(`搜索代理没有这个端点：${base}/search`)
        // 502/504 是代理自己的上游出问题：把它的原话带出来，那是唯一有诊断价值的线索。
        throw new WebSearchError(`搜索代理出错（HTTP ${response.status}）：${detail}`)
      }

      const results = normalize(payload)
      if (results.length === 0) {
        throw new WebSearchError('搜索代理没有返回任何结果（引擎可能被限流或改版了）')
      }
      return options.maxResults === undefined ? results : results.slice(0, options.maxResults)
    },
  }
}
