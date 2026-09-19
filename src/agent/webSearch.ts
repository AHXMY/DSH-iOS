/**
 * 联网搜索。
 *
 * 这是 iOS 版最缺的一块能力：本机能 fetch 一个**已知**网址，但没法"去找"。
 * DeepSeek 没有独立的搜索端点 —— 它的原生搜索是服务端的 `web_search` 工具，
 * 走 Anthropic 格式的 Messages API（`/anthropic/v1/messages`），一次搜索 = 一次模型回合，
 * 所以它比普通工具慢、也贵，但**用现有 key 就能用**，不用再接第三家服务。
 *
 * 结果不是从回复文本里抠出来的：服务端会回结构化的 `web_search_tool_result` 块，
 * 正文片段在 `text` 块的 `citations[]` 里（`web_search_result` 项本身通常不带摘要）。
 * 这一点很关键 —— 从自然语言回复里正则抠链接是另一种做法，但那等于让模型编来源。
 *
 * 这一层刻意不 import expo：它要能在 Node 里被完整验证（用 mock 服务器对打）。
 */
import type { ToolRisk } from './types'

export type SearchResult = {
  title: string
  url: string
  /** 引用片段：来自 text 块的 citations，而不是猜测 */
  snippet?: string
  /** 页面时间（Anthropic 叫 page_age） */
  publishedAt?: string
}

/** 换供应商只需要实现这个接口：Exa / Brave / 自建都能接。 */
export type SearchProvider = {
  id: string
  label: string
  search: (query: string, options?: { signal?: AbortSignal, maxResults?: number }) => Promise<SearchResult[]>
}

export type DeepSeekSearchConfig = {
  apiKey: string
  /** Anthropic 兼容端点根；`/messages` 由这里拼 */
  baseUrl?: string
  /** Anthropic 格式的模型名 */
  model?: string
  /** 一次请求里最多搜几次 */
  maxUses?: number
  maxTokens?: number
  apiVersion?: string
  timeoutMs?: number
}

export const DEEPSEEK_SEARCH_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/anthropic/v1',
  model: 'deepseek-v4-flash',
  maxUses: 5,
  maxTokens: 4096,
  apiVersion: '2023-06-01',
  timeoutMs: 60_000,
} as const

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebSearchError'
  }
}

type Block = Record<string, unknown>

/** 从 text 块的 citations 里抽 url → 片段；同一个 url 只取第一次。 */
export function citationSnippets(blocks: readonly Block[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const citations = Array.isArray(block.citations) ? block.citations : []
    for (const raw of citations) {
      if (typeof raw !== 'object' || raw === null) continue
      const citation = raw as Record<string, unknown>
      const url = typeof citation.url === 'string' ? citation.url : ''
      const text = typeof citation.cited_text === 'string' ? citation.cited_text : ''
      if (url === '' || text === '' || map.has(url)) continue
      map.set(url, text)
    }
  }
  return map
}

/**
 * 把响应里的搜索块摊成结果列表。
 *
 * 一个也没有时**报错而不是返回空**：那说明这次请求根本没触发搜索
 * （模型没搜，或者端点不对），静默返回空会让模型以为"网上没有"，进而编内容。
 */
export function parseSearchResponse(payload: unknown): SearchResult[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new WebSearchError('搜索响应不是对象')
  }
  const blocks = Array.isArray((payload as { content?: unknown }).content)
    ? ((payload as { content: unknown[] }).content.filter(item => typeof item === 'object' && item !== null) as Block[])
    : []

  const resultBlocks = blocks.filter(block => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    const errorBlock = blocks.find(block => block.type === 'web_search_tool_result_error')
    const detail = errorBlock === undefined ? '' : `（服务端报错：${String(errorBlock.error_code ?? '未知')}）`
    throw new WebSearchError(`这次请求没有触发联网搜索${detail}。换个说法再试，或检查搜索端点与模型名。`)
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const results: SearchResult[] = []

  for (const block of resultBlocks) {
    // 服务端可能用 error 形态的块表达"搜索失败"。
    if (typeof block.content === 'string') {
      throw new WebSearchError(`搜索失败：${block.content}`)
    }
    const items = Array.isArray(block.content) ? block.content : []
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      if (item.type !== 'web_search_result') continue
      const url = typeof item.url === 'string' ? item.url : ''
      if (url === '' || seen.has(url)) continue
      seen.add(url)
      const title = typeof item.title === 'string' && item.title !== '' ? item.title : url
      const snippet = snippets.get(url)
      const pageAge = typeof item.page_age === 'string' && item.page_age !== '' ? item.page_age : undefined
      results.push({
        title,
        url,
        ...(snippet === undefined ? {} : { snippet }),
        ...(pageAge === undefined ? {} : { publishedAt: pageAge }),
      })
    }
  }

  return results
}

/** 请求体：Anthropic Messages + 服务端搜索工具。单独导出是为了能对请求形状做断言。 */
export function buildSearchBody(query: string, config: { model: string, maxUses: number, maxTokens: number }): Record<string, unknown> {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config.maxUses }],
  }
}

export function createDeepSeekSearchProvider(config: DeepSeekSearchConfig): SearchProvider {
  const baseUrl = (config.baseUrl ?? DEEPSEEK_SEARCH_DEFAULTS.baseUrl).replace(/\/+$/, '')
  const model = config.model ?? DEEPSEEK_SEARCH_DEFAULTS.model
  const maxUses = config.maxUses ?? DEEPSEEK_SEARCH_DEFAULTS.maxUses
  const maxTokens = config.maxTokens ?? DEEPSEEK_SEARCH_DEFAULTS.maxTokens
  const apiVersion = config.apiVersion ?? DEEPSEEK_SEARCH_DEFAULTS.apiVersion
  const timeoutMs = config.timeoutMs ?? DEEPSEEK_SEARCH_DEFAULTS.timeoutMs

  return {
    id: 'deepseek',
    label: 'DeepSeek 原生搜索',
    async search(query, options = {}) {
      const trimmed = query.trim()
      if (trimmed === '') throw new WebSearchError('搜索词不能为空')
      if (config.apiKey.trim() === '') throw new WebSearchError('没有配置 API Key，搜索不可用')
      // 已经取消的调用不能再发请求：addEventListener('abort') 对"早就中止"的 signal 不会触发，
      // 所以必须在这里先看一眼，否则用户已经按了停止，搜索还会照发。
      let callerAborted = options.signal?.aborted === true
      if (callerAborted) throw new WebSearchError('搜索已取消')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      // 调用方的取消要能传导进来（用户按停止时不该还挂着一次搜索）。
      const onAbort = (): void => {
        callerAborted = true
        controller.abort()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      let response: Response
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            // 官方端点认 x-api-key，Anthropic 兼容的代理认 Bearer —— 两个都发，谁认都行。
            'x-api-key': config.apiKey,
            authorization: `Bearer ${config.apiKey}`,
            'anthropic-version': apiVersion,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': 'DSH-iOS/0.1',
          },
          body: JSON.stringify(buildSearchBody(trimmed, { model, maxUses, maxTokens })),
          signal: controller.signal,
        })
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new WebSearchError(callerAborted ? '搜索已取消' : `搜索超时（${timeoutMs / 1000}s）`)
        }
        throw new WebSearchError(`连不上搜索端点：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        if (response.status === 401) throw new WebSearchError('搜索被拒（401）：API Key 不对，或者这个 key 没有搜索权限')
        if (response.status === 404) throw new WebSearchError(`搜索端点不存在（404）：${baseUrl}/messages`)
        if (response.status === 429) throw new WebSearchError('搜索太频繁（429），等一会儿再试')
        throw new WebSearchError(`搜索端点返回 ${response.status}：${detail}`)
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new WebSearchError('搜索返回的不是 JSON')
      }

      const results = parseSearchResponse(payload)
      const limit = options.maxResults ?? 8
      return results.slice(0, limit)
    },
  }
}

/** 工具面向模型时的文本形态：编号 + 标题 + 链接 + 片段，一行一条，别让模型自己对齐格式。 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `搜索「${query}」没有返回结果。`
  const lines = results.map((result, index) => {
    const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`]
    if (result.snippet !== undefined) parts.push(`   ${result.snippet.replace(/\s+/g, ' ').slice(0, 300)}`)
    if (result.publishedAt !== undefined) parts.push(`   （页面时间：${result.publishedAt}）`)
    return parts.join('\n')
  })
  return `搜索「${query}」的结果：\n\n${lines.join('\n\n')}\n\n需要正文就再用 web_fetch 抓具体某个链接。`
}

/** 搜索工具的影响面：只读（它只看网上已有的东西，不改任何数据）。 */
export const WEB_SEARCH_RISK: ToolRisk = 'read'
