/**
 * 第三方搜索 provider（Exa / Perplexity）。
 *
 * 为什么要有这两个：桌面版 DSH 的 `web_search` 背后是四个 provider ——
 * deepseek（服务端工具）/ exa / google / perplexity。我们既然要对齐原版，
 * 就不能只有自己造的那一个；接口形状照原版来，用户手里有哪家的 key 就用哪家。
 *
 * 两家的线格式都是从 DSH 源码里读出来的，不是猜的：
 *   · Exa：`POST {base}/search`，头 `x-api-key`，体 `{query, type, contents:{highlights:{highlightsPerUrl}}}`
 *     → 结果取 `results[].highlights` 里第一条非空高亮当摘要（原版就是这么映射的）
 *   · Perplexity：`POST {base}/chat/completions`（OpenAI 兼容），体 `{model, max_tokens, messages}`
 *     → 来源优先取结构化的 `search_results[]`，没有才退回只有 url 的 `citations[]`
 *
 * 不 import expo：这两个要能在 Node 里对着 mock 端点跑通。
 */
import { WebSearchError } from './webSearch'
import type { SearchProvider, SearchResult } from './webSearch'

export const EXA_DEFAULTS = {
  baseUrl: 'https://api.exa.ai',
  searchType: 'auto',
  highlightsPerResult: 1,
  timeoutMs: 30_000,
} as const

export const PERPLEXITY_DEFAULTS = {
  baseUrl: 'https://api.perplexity.ai',
  model: 'sonar',
  maxTokens: 1024,
  timeoutMs: 45_000,
} as const

/** 两个 provider 共用的 POST：超时、取消、错误翻译都在这里收口。 */
async function postJson(url: string, headers: Record<string, string>, body: unknown, options: {
  timeoutMs: number
  signal?: AbortSignal
  providerName: string
}): Promise<{ status: number, payload: Record<string, unknown>, text: string }> {
  if (options.signal?.aborted === true) throw new WebSearchError('搜索已取消')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let callerAborted = false
  const onAbort = (): void => { callerAborted = true; controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new WebSearchError(callerAborted ? '搜索已取消' : `搜索超时（${options.timeoutMs / 1000}s）`)
    }
    throw new WebSearchError(`连不上 ${options.providerName}：${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text !== '') {
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new WebSearchError(`${options.providerName} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
  }

  if (!response.ok) {
    if (response.status === 401) throw new WebSearchError(`${options.providerName} 鉴权失败（401）：API Key 不对`)
    if (response.status === 402) throw new WebSearchError(`${options.providerName} 余额不足（402）`)
    if (response.status === 429) throw new WebSearchError(`${options.providerName} 太频繁（429），等一会儿再试`)
    const detail = typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string' ? payload.message : text.slice(0, 200)
    throw new WebSearchError(`${options.providerName} 返回 ${response.status}：${detail}`)
  }

  return { status: response.status, payload, text }
}

// ─────────────────────────────────────────────── Exa

export type ExaSearchConfig = {
  apiKey: string
  baseUrl?: string
  searchType?: 'auto' | 'keyword' | 'neural'
  /** 每条结果要几句高亮（Exa 的 highlightsPerUrl）；摘要取第一条非空的 */
  highlightsPerResult?: number
  maxResults?: number
  timeoutMs?: number
}

export function buildExaBody(query: string, options: {
  searchType: string
  highlightsPerResult: number
  numResults?: number
}): Record<string, unknown> {
  return {
    query,
    type: options.searchType,
    contents: { highlights: { highlightsPerUrl: options.highlightsPerResult } },
    ...(options.numResults === undefined ? {} : { numResults: options.numResults }),
  }
}

export function parseExaResponse(payload: unknown): SearchResult[] {
  if (typeof payload !== 'object' || payload === null) throw new WebSearchError('Exa 响应不是对象')
  const raw = (payload as { results?: unknown }).results
  if (!Array.isArray(raw)) throw new WebSearchError('Exa 响应里没有 results 数组')
  const results: SearchResult[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : ''
    if (url === '') continue
    const title = typeof record.title === 'string' && record.title !== '' ? record.title : url
    const highlights = Array.isArray(record.highlights) ? record.highlights : []
    // 原版就是取第一条非空高亮当摘要 —— 高亮是 Exa 已经替你定位好的相关句，比整页正文有用。
    const snippet = highlights.find(highlight => typeof highlight === 'string' && highlight.trim() !== '')
    const published = typeof record.publishedDate === 'string' && record.publishedDate !== '' ? record.publishedDate : undefined
    results.push({
      title,
      url,
      ...(typeof snippet === 'string' ? { snippet: snippet.trim() } : {}),
      ...(published === undefined ? {} : { publishedAt: published }),
    })
  }
  return results
}

export function createExaSearchProvider(config: ExaSearchConfig): SearchProvider {
  const baseUrl = (config.baseUrl ?? EXA_DEFAULTS.baseUrl).replace(/\/+$/, '')
  const searchType = config.searchType ?? EXA_DEFAULTS.searchType
  const highlightsPerResult = config.highlightsPerResult ?? EXA_DEFAULTS.highlightsPerResult
  const timeoutMs = config.timeoutMs ?? EXA_DEFAULTS.timeoutMs

  return {
    id: 'exa',
    label: 'Exa',
    async search(query, options = {}) {
      const trimmed = query.trim()
      if (trimmed === '') throw new WebSearchError('搜索词不能为空')
      if (config.apiKey.trim() === '') throw new WebSearchError('没有配置 Exa API Key')

      const numResults = options.maxResults ?? config.maxResults
      const { payload } = await postJson(
        `${baseUrl}/search`,
        { 'x-api-key': config.apiKey },
        buildExaBody(trimmed, { searchType, highlightsPerResult, ...(numResults === undefined ? {} : { numResults }) }),
        { timeoutMs, signal: options.signal, providerName: 'Exa' },
      )

      const results = parseExaResponse(payload)
      if (results.length === 0) throw new WebSearchError('Exa 没有返回任何结果')
      return options.maxResults === undefined ? results : results.slice(0, options.maxResults)
    },
  }
}

// ─────────────────────────────────────────────── Perplexity

export type PerplexitySearchConfig = {
  apiKey: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
}

export function buildPerplexityBody(query: string, options: { model: string, maxTokens: number }): Record<string, unknown> {
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: query }],
  }
}

/**
 * Perplexity 的来源解析：优先 `search_results[]`（带标题），
 * 没有才退回 `citations[]`（只有 URL）—— 这个优先级是原版定的，照抄是为了行为一致。
 */
export function parsePerplexityResponse(payload: unknown): SearchResult[] {
  if (typeof payload !== 'object' || payload === null) throw new WebSearchError('Perplexity 响应不是对象')
  const record = payload as Record<string, unknown>

  if (Array.isArray(record.search_results)) {
    const results: SearchResult[] = []
    for (const item of record.search_results) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const url = typeof entry.url === 'string' ? entry.url : ''
      if (url === '') continue
      const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : url
      const date = typeof entry.date === 'string' && entry.date !== '' ? entry.date : undefined
      results.push({ title, url, ...(date === undefined ? {} : { publishedAt: date }) })
    }
    if (results.length > 0) return results
  }

  if (Array.isArray(record.citations)) {
    return record.citations
      .filter((url): url is string => typeof url === 'string' && url !== '')
      .map(url => ({ title: url, url }))
  }

  return []
}

export function createPerplexitySearchProvider(config: PerplexitySearchConfig): SearchProvider {
  const baseUrl = (config.baseUrl ?? PERPLEXITY_DEFAULTS.baseUrl).replace(/\/+$/, '')
  const model = config.model ?? PERPLEXITY_DEFAULTS.model
  const maxTokens = config.maxTokens ?? PERPLEXITY_DEFAULTS.maxTokens
  const timeoutMs = config.timeoutMs ?? PERPLEXITY_DEFAULTS.timeoutMs

  return {
    id: 'perplexity',
    label: 'Perplexity',
    async search(query, options = {}) {
      const trimmed = query.trim()
      if (trimmed === '') throw new WebSearchError('搜索词不能为空')
      if (config.apiKey.trim() === '') throw new WebSearchError('没有配置 Perplexity API Key')

      const { payload } = await postJson(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${config.apiKey}` },
        buildPerplexityBody(trimmed, { model, maxTokens }),
        { timeoutMs, signal: options.signal, providerName: 'Perplexity' },
      )

      const results = parsePerplexityResponse(payload)
      if (results.length === 0) throw new WebSearchError('Perplexity 没有返回来源（search_results 与 citations 都为空）')
      return options.maxResults === undefined ? results : results.slice(0, options.maxResults)
    },
  }
}
