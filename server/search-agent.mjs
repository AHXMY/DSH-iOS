#!/usr/bin/env node
/**
 * dsh-search-agent —— 自建搜索代理（零依赖，一个文件）。
 *
 * 为什么需要它：模型自己的"联网搜索"要靠服务端工具（DeepSeek 那套走 Anthropic 兼容端点），
 * 未必人人可用、也未必在这张网络里通。这个代理把搜索搬到你自己的机器上，
 * 不依赖任何第三方搜索 API key，只要那台机器能上网就行。
 *
 * 引擎选择是**按实测网络挑的**，不是按名气：
 *   · bing（默认）：走 Bing 的 **RSS 输出**（`?format=rss`）——服务端渲染的纯 XML，
 *     返回**真实 URL**，不怕前端改版。这是这台机器上最稳的一条。
 *   · sogou（备用）：抓搜索结果页，链接是 `/link?url=` 跳转页（210 字节），
 *     里面写着目标地址，所以能还原成真实 URL；多花一条小请求。
 *   · duckduckgo / brave / 360：在中国大陆网络里实测**直接超时**，所以不做。
 *
 * 协议：
 *   GET /health                                  → { ok, version, engines, defaultEngine }
 *   GET /search?q=…&limit=8&engine=bing&resolve=1 → { query, engine, results:[{title,url,snippet,publishedAt?}] }
 *   鉴权：authorization: Bearer <token>（所有端点）
 *
 * 安全：默认只绑 127.0.0.1；要暴露就套 nginx 门禁或 Tailscale（见 server/README.md）。
 *
 * 用法：
 *   DSH_SEARCH_TOKEN=xxx node server/search-agent.mjs
 *   node server/search-agent.mjs --token xxx --port 7718 --engine bing
 */
import { createServer } from 'node:http'

const VERSION = '1.0.0'
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const UPSTREAM_TIMEOUT = 12_000
const MAX_BODY = 2 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export const DEFAULT_ENGINE_BASE = {
  bing: 'https://cn.bing.com',
  sogou: 'https://www.sogou.com',
}

export const ENGINES = ['bing', 'sogou']

/** 恒定时间比较，避免 token 比对泄漏长度信息。 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function tagOf(block, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return match === null ? '' : match[1].trim()
}

/**
 * 解析 Bing 的 RSS 输出。
 *
 * 选 RSS 而不是 HTML 是有理由的：RSS 是给聚合器用的稳定契约，
 * HTML 是给浏览器用的，随时可能因为前端改版而失效。
 */
export function parseBingRss(xml, limit = DEFAULT_LIMIT) {
  const results = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? ''
    const url = decodeEntities(tagOf(block, 'link')).trim()
    if (!/^https?:\/\//i.test(url)) continue
    const title = decodeEntities(stripTags(tagOf(block, 'title'))) || url
    const snippet = decodeEntities(stripTags(tagOf(block, 'description')))
    const publishedAt = decodeEntities(stripTags(tagOf(block, 'pubDate')))
    results.push({
      title,
      url,
      ...(snippet === '' ? {} : { snippet }),
      ...(publishedAt === '' ? {} : { publishedAt }),
    })
    if (results.length >= limit) break
  }
  return results
}

/**
 * 解析搜狗结果页：每个结果是一个 `div.vrwrap`，标题在 `h3.vr-title` 里，摘要在紧跟的 div 里。
 *
 * 链接是 `/link?url=…` 跳转页，这里先拼成绝对地址，真实地址由 extractSogouTarget 还原。
 */
export function parseSogouHtml(html, limit = DEFAULT_LIMIT, base = DEFAULT_ENGINE_BASE.sogou) {
  const results = []
  const chunks = html.split(/<div[^>]*class="vrwrap"/i).slice(1)
  for (const chunk of chunks) {
    const titleBlock = /<h3[^>]*class="vr-title"[^>]*>([\s\S]*?)<\/h3>/i.exec(chunk)?.[1] ?? ''
    const anchor = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(titleBlock)
    if (anchor === null) continue
    const href = decodeEntities(anchor[1] ?? '').trim()
    if (href === '' || href.startsWith('#')) continue
    const url = /^https?:\/\//i.test(href) ? href : new URL(href, base).toString()
    const title = decodeEntities(stripTags(anchor[2] ?? '')) || url
    const snippetBlock = /<div[^>]*class="[^"]*(?:fz-mid|space-txt|text-layout|clamp2)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk)?.[1] ?? ''
    const snippet = decodeEntities(stripTags(snippetBlock))
    results.push({ title, url, ...(snippet === '' ? {} : { snippet }), wrapped: url.includes('/link?url=') })
    if (results.length >= limit) break
  }
  return results
}

/** 从搜狗跳转页里抠出真实地址：页面只有 200 来字节，目标写在 window.location.replace 或 meta refresh 里。 */
export function extractSogouTarget(html) {
  const js = /window\.location\.replace\(\s*["']([^"']+)["']/i.exec(html)?.[1]
  if (js !== undefined && js !== '') return decodeEntities(js)
  const meta = /http-equiv=["']?refresh["']?[^>]*content=["'][^"']*URL=['"]?([^"'>\s]+)/i.exec(html)?.[1]
  if (meta !== undefined && meta !== '') return decodeEntities(meta)
  return null
}

async function fetchText(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? UPSTREAM_TIMEOUT)
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(options.headers ?? {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw Object.assign(new Error(`上游返回 ${response.status}`), { status: 502, upstream: response.status })
    }
    return text
  } catch (cause) {
    if (cause && cause.status) throw cause
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw Object.assign(new Error(`上游超时（${(options.timeoutMs ?? UPSTREAM_TIMEOUT) / 1000}s）`), { status: 504 })
    }
    throw Object.assign(new Error(`连不上上游：${cause instanceof Error ? cause.message : String(cause)}`), { status: 502 })
  } finally {
    clearTimeout(timer)
  }
}

/** 还原搜狗跳转链接（并发，带上限；失败就保留原链接，不让一条结果拖死整次搜索）。 */
async function resolveSogouLinks(results, options = {}) {
  const cap = options.cap ?? 8
  const timeoutMs = options.timeoutMs ?? 6_000
  const targets = results.slice(0, cap).filter(item => item.wrapped === true)
  await Promise.all(targets.map(async item => {
    try {
      const page = await fetchText(item.url, { timeoutMs, accept: 'text/html' })
      const real = extractSogouTarget(page)
      if (real !== null && /^https?:\/\//i.test(real)) {
        item.url = real
        item.wrapped = false
      }
    } catch {
      // 还原失败就保留跳转链接：宁可给个能用的链接，也不要整条结果消失。
    }
  }))
  return results
}

/** 真正干活的一层：拿 query 去引擎要结果，统一成 {title,url,snippet}。 */
export async function runSearch(request, options = {}) {
  const query = String(request.query ?? '').trim()
  if (query === '') throw Object.assign(new Error('q 不能为空'), { status: 400 })
  const engine = String(request.engine ?? 'bing').toLowerCase()
  if (!ENGINES.includes(engine)) {
    throw Object.assign(new Error(`不支持的引擎：${engine}（可选 ${ENGINES.join(' / ')}）`), { status: 400 })
  }
  const limit = Math.min(Math.max(Number(request.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const base = { ...DEFAULT_ENGINE_BASE, ...(options.engineBase ?? {}) }

  let results = []
  if (engine === 'bing') {
    const url = `${base.bing}/search?q=${encodeURIComponent(query)}&format=rss&count=${limit}`
    results = parseBingRss(await fetchText(url, { accept: 'application/rss+xml,application/xml,text/xml' }), limit)
  } else {
    const url = `${base.sogou}/web?query=${encodeURIComponent(query)}`
    const html = await fetchText(url)
    results = parseSogouHtml(html, limit, base.sogou)
    if (request.resolve !== false) results = await resolveSogouLinks(results, options)
  }

  // 去重：同一个 URL 只留第一条。
  const seen = new Set()
  const deduped = []
  for (const item of results) {
    const key = item.url.replace(/[#?].*$/, '').replace(/\/+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ title: item.title, url: item.url, ...(item.snippet === undefined ? {} : { snippet: item.snippet }), ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }) })
  }

  if (deduped.length === 0) {
    throw Object.assign(new Error(`引擎 ${engine} 没有解析出任何结果（可能改版或被限流），换 engine=sogou 或稍后再试`), { status: 502 })
  }
  return deduped
}

export function createSearchAgent(options) {
  const token = options.token
  if (!token) throw new Error('必须配置 token：搜索代理不允许无鉴权启动')

  return createServer(async (request, response) => {
    const send = (status, payload, contentType = 'application/json; charset=utf-8') => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) })
      response.end(body)
    }

    try {
      if (!sameToken(request.headers.authorization ?? '', `Bearer ${token}`)) {
        send(401, { error: 'unauthorized' })
        return
      }

      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/health') {
        send(200, { ok: true, version: VERSION, engines: ENGINES, defaultEngine: options.engine ?? 'bing' })
        return
      }
      if (url.pathname !== '/search') {
        send(404, { error: `没有这个端点：${url.pathname}` })
        return
      }

      const started = Date.now()
      const results = await runSearch({
        query: url.searchParams.get('q'),
        engine: url.searchParams.get('engine') ?? options.engine,
        limit: url.searchParams.get('limit'),
        resolve: url.searchParams.get('resolve') !== '0',
      }, { engineBase: options.engineBase })
      send(200, {
        query: url.searchParams.get('q'),
        engine: url.searchParams.get('engine') ?? options.engine ?? 'bing',
        took: Date.now() - started,
        results,
      })
    } catch (cause) {
      const status = cause && typeof cause.status === 'number' ? cause.status : 500
      send(status, { error: String(cause?.message ?? cause) })
    }
  })
}

// 直接运行时才启动；被 import 时不启动（测试要 import 它拿 createSearchAgent / 解析函数）。
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
if (isMain) {
  const args = process.argv.slice(2)
  const argOf = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : args[index + 1]
  }
  const port = Number(argOf('port', process.env.DSH_SEARCH_PORT ?? 7718))
  const host = argOf('host', process.env.DSH_SEARCH_HOST ?? '127.0.0.1')
  const token = argOf('token', process.env.DSH_SEARCH_TOKEN ?? '')
  const engine = argOf('engine', process.env.DSH_SEARCH_ENGINE ?? 'bing')

  const server = createSearchAgent({ token, engine })
  server.listen(port, host, () => {
    console.log(`dsh-search-agent ${VERSION} 监听 http://${host}:${port}`)
    console.log(`默认引擎 ${engine}（可选 ${ENGINES.join(' / ')}）`)
    console.log(token === '' ? '警告：没有 token，任何请求都会 401' : '鉴权：Bearer token 已启用')
  })
}
