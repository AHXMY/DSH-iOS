/**
 * 自建搜索代理的真实验证。
 *
 * 关键点：**解析器是对着真实抓下来的页面验的**，不是对着我编的样本。
 * `server/fixtures/` 里三份文件都是真响应：
 *   · bing-search.rss   —— cn.bing.com 的 RSS 输出（10 条，真 URL）
 *   · sogou-search.html —— 搜狗结果页（截了 3 个结果块，结构原样）
 *   · sogou-link.html   —— 搜狗跳转页（210 字节，目标地址写在里面）
 *
 * 端到端那一组：起一个 mock 引擎喂 fixture，再让搜索代理去打它，
 * 于是"URL 怎么拼、鉴权、去重、limit、上游挂了怎么报"全都能真跑一遍。
 *
 *   npm test
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSearchAgent, extractSogouTarget, parseBingRss, parseSogouHtml, runSearch } from '../server/search-agent.mjs'
import { createSelfHostedSearchProvider } from '../src/agent/searchSelfHosted.ts'
import { createExaSearchProvider, createPerplexitySearchProvider } from '../src/agent/searchProviders.ts'
import { explainFailure, runConnectivityChecks, summarize } from '../src/agent/connectivity.ts'

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

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(here, '..', 'server', 'fixtures', name), 'utf8')

// ═══════════════════════════════════════════════ 解析真实页面

section('解析真实页面（fixture 是真响应）')

const bingHtml = fixture('bing-search.rss')
const bingResults = parseBingRss(bingHtml, 10)

check('Bing RSS 解析出多条结果', bingResults.length >= 5, `${bingResults.length}`)
check('结果带真实 URL（不是跳转链接）',
  bingResults.every(item => /^https?:\/\//i.test(item.url) && !item.url.includes('bing.com/search?')),
  JSON.stringify(bingResults.slice(0, 2).map(item => item.url)))
check('标题非空且没有 HTML 残留', bingResults.every(item => item.title !== '' && !item.title.includes('<')), bingResults[0]?.title ?? '')
check('摘要非空', (bingResults[0]?.snippet ?? '').length > 10, bingResults[0]?.snippet ?? '')
check('limit 生效', parseBingRss(bingHtml, 2).length === 2)
check('Bing 结果带发布时间', typeof bingResults[0]?.publishedAt === 'string', bingResults[0]?.publishedAt ?? '')
check('乱 HTML 不会崩，只是没有结果', parseBingRss('<html>没有 item</html>').length === 0)
check('空字符串不会崩', parseBingRss('').length === 0)

const sogouHtml = fixture('sogou-search.html')
const sogouResults = parseSogouHtml(sogouHtml, 5)

check('搜狗解析出结果', sogouResults.length >= 2, `${sogouResults.length}`)
check('搜狗标题非空且去掉了 <em> 标记', sogouResults.every(item => item.title !== '' && !item.title.includes('<')), sogouResults[0]?.title ?? '')
check('搜狗链接被拼成绝对地址', sogouResults.every(item => /^https:\/\//.test(item.url)), sogouResults[0]?.url ?? '')
check('搜狗摘要非空', (sogouResults[0]?.snippet ?? '').length > 10, sogouResults[0]?.snippet ?? '')
check('跳转链接被标出来（好让代理去还原）', sogouResults[0]?.wrapped === true, JSON.stringify(sogouResults[0]?.wrapped))

const linkPage = fixture('sogou-link.html')
equal('从跳转页里抠出真实地址', extractSogouTarget(linkPage), 'https://platform.deepseek.com/')
equal('没有目标地址时返回 null', extractSogouTarget('<html>啥也没有</html>'), null)

// ═══════════════════════════════════════════════ 端到端（代理 → mock 引擎）

section('端到端：搜索代理打 mock 引擎')

// mock 引擎：按路径吐出真 fixture，可切换成故障模式
let engineMode = 'ok'
/** 让测试能在"引擎真的收到请求"这一刻做动作（用它替掉 setTimeout 抢时间）。 */
const engineHooks: { onRequest: (() => void) | null } = { onRequest: null }
const mockEngine = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  engineHooks.onRequest?.()
  const send = (status: number, body: string, type = 'text/html; charset=utf-8'): void => {
    response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }
  if (engineMode === 'down') { send(500, '上游挂了'); return }
  if (engineMode === 'empty') { send(200, '<html>这个页面里没有任何结果块</html>'); return }
  if (url.pathname.startsWith('/link')) { send(200, linkPage); return }
  if (url.pathname === '/search') { send(200, bingHtml, 'application/rss+xml; charset=utf-8'); return }
  if (url.pathname === '/web') { send(200, sogouHtml); return }
  send(404, '没有这个路径')
})
await new Promise(resolvePromise => mockEngine.listen(0, '127.0.0.1', resolvePromise))
const engineAddress = mockEngine.address()
const enginePort = typeof engineAddress === 'object' && engineAddress !== null ? engineAddress.port : 0
const engineBase = { bing: `http://127.0.0.1:${enginePort}`, sogou: `http://127.0.0.1:${enginePort}` }

const TOKEN = 'search-token-abcdef'
const agent = createSearchAgent({ token: TOKEN, engine: 'bing', engineBase })
await new Promise(resolvePromise => agent.listen(0, '127.0.0.1', resolvePromise))
const agentAddress = agent.address()
const agentPort = typeof agentAddress === 'object' && agentAddress !== null ? agentAddress.port : 0
const agentUrl = `http://127.0.0.1:${agentPort}`

const get = async (path: string, token = TOKEN): Promise<{ status: number, body: any }> => {
  const response = await fetch(`${agentUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch { /* 保留原文 */ }
  return { status: response.status, body }
}

const health = await get('/health')
equal('健康检查通', health.status, 200)
equal('健康检查报出可用引擎', health.body.engines, ['bing', 'sogou'])

const unauthorized = await get('/health', 'wrong-token')
equal('token 不对被拒', unauthorized.status, 401)

const search = await get('/search?q=deepseek&limit=5')
equal('搜索返回 200', search.status, 200)
equal('limit 生效', search.body.results.length, 5)
check('结果是真实 URL', search.body.results.every((item: { url: string }) => /^https?:\/\//.test(item.url)), JSON.stringify(search.body.results[0]))
check('结果带摘要', (search.body.results[0].snippet ?? '').length > 5)
check('报告了耗时', typeof search.body.took === 'number')

const sogouSearch = await get('/search?q=deepseek&engine=sogou&limit=3')
equal('搜狗引擎也能用', sogouSearch.status, 200)
check('搜狗结果里的跳转链接被还原成真实地址',
  sogouSearch.body.results[0].url === 'https://platform.deepseek.com/',
  sogouSearch.body.results[0].url)
check('还原后不再带 /link?url=', sogouSearch.body.results.every((item: { url: string }) => !item.url.includes('/link?url=')))

const noResolve = await get('/search?q=deepseek&engine=sogou&resolve=0&limit=2')
check('关掉还原时保留跳转链接（可选行为）', noResolve.body.results.some((item: { url: string }) => item.url.includes('/link?url=')))

const badEngine = await get('/search?q=x&engine=google')
equal('不支持的引擎给出 400', badEngine.status, 400)
check('并说明可选值', String(badEngine.body.error).includes('bing'), String(badEngine.body.error))

const emptyQuery = await get('/search?q=')
equal('空搜索词给出 400', emptyQuery.status, 400)

engineMode = 'down'
const upstreamDown = await get('/search?q=x')
equal('上游挂了返回 502', upstreamDown.status, 502)
check('错误里带出上游状态', String(upstreamDown.body.error).includes('500'), String(upstreamDown.body.error))

engineMode = 'empty'
const noResults = await get('/search?q=x')
equal('解析不出结果返回 502', noResults.status, 502)
check('提示是"改版或限流"这类可行动信息', String(noResults.body.error).includes('没有解析出任何结果'), String(noResults.body.error))

engineMode = 'ok'

// ═══════════════════════════════════════════════ App 侧客户端

section('App 侧客户端（自建搜索 provider）')

const provider = createSelfHostedSearchProvider({ url: agentUrl, token: TOKEN })

const providerResults = await provider.search('deepseek api', { maxResults: 3 })
equal('provider 拿到结果', providerResults.length, 3)
check('provider 结果结构完整', providerResults.every(item => item.title !== '' && item.url !== ''))
check('provider 的标签能说明用的是哪条路', provider.label.includes('bing'), provider.label)

const sogouProvider = createSelfHostedSearchProvider({ url: agentUrl, token: TOKEN, engine: 'sogou' })
const sogouProviderResults = await sogouProvider.search('deepseek', { maxResults: 2 })
check('换引擎也能用', sogouProviderResults.length >= 1 && (sogouProviderResults[0]?.url ?? '').startsWith('https://'), JSON.stringify(sogouProviderResults))
// mock 里每条搜狗跳转都指向同一个地址，所以还原之后会塌成一条 ——
// 这正是"先还原再按 URL 去重"该有的行为：同一个页面不该在结果里出现两次。
equal('多条结果还原到同一地址时会被去重', sogouProviderResults.length, 1)

async function providerError(test: () => Promise<unknown>): Promise<string> {
  try {
    await test()
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

const wrongTokenError = await providerError(() => createSelfHostedSearchProvider({ url: agentUrl, token: 'nope!' }).search('x'))
check('token 不对时给出可读原因', wrongTokenError.includes('token'), wrongTokenError)

const noTokenError = await providerError(() => createSelfHostedSearchProvider({ url: agentUrl, token: '' }).search('x'))
check('没配 token 时客户端自己拦住', noTokenError.includes('token'), noTokenError)

const emptyQueryError = await providerError(() => provider.search('   '))
check('空搜索词被驳回', emptyQueryError.includes('不能为空'), emptyQueryError)

const unreachableError = await providerError(() => createSelfHostedSearchProvider({ url: 'http://127.0.0.1:1', token: 'x' }).search('x'))
check('连不上代理时给出可读原因', unreachableError.includes('连不上'), unreachableError)

const notFoundResponse = await fetch(`${agentUrl}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })
equal('未知端点返回 404', notFoundResponse.status, 404)

engineMode = 'down'
const upstreamFailure = await providerError(() => provider.search('x'))
check('上游故障时把代理的原话带出来', upstreamFailure.includes('500') || upstreamFailure.includes('上游'), upstreamFailure)
engineMode = 'ok'

const cancelled = new AbortController()
cancelled.abort()
const cancelError = await providerError(() => provider.search('x', { signal: cancelled.signal }))
check('已取消的调用不再发请求', cancelError.includes('取消'), cancelError)

// 取消发生在飞行中 —— 这里刻意不用 setTimeout 抢时间：
// 本地 mock 快的时候请求会在 5ms 内跑完，取消就落空了（这条曾经偶发失败）。
// 改成"引擎收到请求时再取消"：顺序由事件保证，不靠时序，是确定性的。
const abortMidFlight = new AbortController()
const midFlight = createSelfHostedSearchProvider({ url: agentUrl, token: TOKEN, timeoutMs: 5000 })
let cancelledMidFlight = false
engineHooks.onRequest = () => {
  if (cancelledMidFlight) return
  cancelledMidFlight = true
  abortMidFlight.abort()
}
const midFlightError = await providerError(() => midFlight.search('x', { signal: abortMidFlight.signal }))
engineHooks.onRequest = null
check('请求已经发出后再取消，也能收住', midFlightError !== '', midFlightError)
check('取消确实发生在飞行中（引擎收到了请求）', cancelledMidFlight)

// ═══════════════════════════════════════════════ 直接调用（不经 HTTP）

section('runSearch 直调')

const direct = await runSearch({ query: 'deepseek', engine: 'bing', limit: 4 }, { engineBase })
equal('直调也能拿到结果', direct.length, 4)
const dedupCheck = await runSearch({ query: 'deepseek', engine: 'bing', limit: 20 }, { engineBase })
const urls = dedupCheck.map(item => item.url)
equal('结果按 URL 去重', urls.length, new Set(urls).size)

await new Promise(resolvePromise => agent.close(resolvePromise))
await new Promise(resolvePromise => mockEngine.close(resolvePromise))
check('两个服务都能干净关掉', true)

// ═══════════════════════════════════════════════ 连通性自检

section('连通性自检')

check('DNS 失败被认出来', explainFailure('getaddrinfo ENOTFOUND api.example.com').detail.includes('连不上'))
check('连接被拒也算连不上', explainFailure('Network request failed').detail.includes('连不上'))
check('401 给出鉴权提示', explainFailure('HTTP 401').hint !== undefined && explainFailure('HTTP 401').detail.includes('401'))
check('402 提示充值', explainFailure('HTTP 402').hint.includes('充值'))
check('404 提示地址可能写错', explainFailure('HTTP 404').hint.includes('地址'))
check('429 提示等待', explainFailure('HTTP 429').hint.includes('等'))
check('超时有专门提示', explainFailure('请求超时（15s）').detail.includes('超时'))
check('证书问题指向描述文件/换证书', explainFailure('certificate is invalid').hint.includes('证书'))
equal('认不出来的错误原样带出', explainFailure('莫名其妙的一句话').detail, '莫名其妙的一句话')

equal('总结：全通', summarize([{ id: 'model', label: 'a', status: 'ok', detail: '' }]), '1 条链路正常')
equal('总结：有不通', summarize([
  { id: 'model', label: 'a', status: 'ok', detail: '' },
  { id: 'search', label: 'b', status: 'fail', detail: '' },
]), '1 条正常，1 条不通')
equal('总结：未启用也报出来', summarize([
  { id: 'model', label: 'a', status: 'ok', detail: '' },
  { id: 'mcp', label: 'b', status: 'skipped', detail: '' },
]), '1 条链路正常，1 条未启用')

// 模型端点的 mock：既验证"通了"，也验证鉴权与故障两种失败
let modelMode = 'ok'
const mockModel = createServer((request, response) => {
  const send = (status: number, payload: unknown): void => {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }
  if (modelMode === 'unauthorized') { send(401, { error: 'bad key' }); return }
  if (modelMode === 'down') { send(500, { error: 'boom' }); return }
  send(200, { data: [{ id: 'model-a' }, { id: 'model-b' }] })
})
await new Promise(resolvePromise => mockModel.listen(0, '127.0.0.1', resolvePromise))
const modelAddress = mockModel.address()
const modelPort = typeof modelAddress === 'object' && modelAddress !== null ? modelAddress.port : 0
const modelBase = `http://127.0.0.1:${modelPort}`

const baseConfig = {
  apiKey: 'k',
  baseUrl: modelBase,
  model: 'model-a',
  searchProvider: 'off' as const,
  searchBaseUrl: '',
  searchModel: '',
  searchAgentUrl: '',
  searchAgentToken: '',
  searchEngine: 'bing' as const,
  sandboxUrl: '',
  sandboxToken: '',
  mcpLines: '',
}

const healthy = await runConnectivityChecks(baseConfig)
equal('四条链路都有结论', healthy.length, 4)
equal('模型链路通', healthy[0]?.status, 'ok')
check('报出可用模型数', healthy[0]?.detail.includes('2 个'), healthy[0]?.detail ?? '')
equal('没配搜索就标未启用', healthy[1]?.status, 'skipped')
equal('没配执行代理就标未启用', healthy[2]?.status, 'skipped')
equal('没配 MCP 就标未启用', healthy[3]?.status, 'skipped')

modelMode = 'unauthorized'
const badKey = await runConnectivityChecks(baseConfig)
equal('Key 不对时模型链路报失败', badKey[0]?.status, 'fail')
check('失败原因指向 401', (badKey[0]?.detail ?? '').includes('401'), badKey[0]?.detail ?? '')
check('给出了下一步', badKey[0]?.hint !== undefined)

modelMode = 'ok'
const offline = await runConnectivityChecks({
  ...baseConfig,
  baseUrl: 'http://127.0.0.1:1',
  sandboxUrl: 'http://127.0.0.1:1',
  sandboxToken: 'x',
})
equal('连不上时模型链路报失败', offline[0]?.status, 'fail')
check('失败的条目都指向"设备可能没网"', offline.filter(r => r.status === 'fail').every(r => (r.hint ?? '').includes('没有网络')), JSON.stringify(offline.map(r => r.hint)))
equal('成功/未启用的条目仍然列出来（不藏）', offline.filter(r => r.status !== 'fail').length + offline.filter(r => r.status === 'fail').length, 4)

await new Promise(resolvePromise => mockModel.close(resolvePromise))

// ═══════════════════════════════════════════════ 原版那两家 provider（Exa / Perplexity）

section('Exa / Perplexity（对齐桌面版的 provider 家族）')

const exaRequests: Record<string, unknown>[] = []
const mockExa = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    exaRequests.push({ path: request.url, headers: request.headers, body })
    const send = (status: number, payload: unknown): void => {
      const text = JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (request.headers['x-api-key'] === 'bad-key') { send(401, { error: 'invalid api key' }); return }
    if (body.query === '空结果') { send(200, { results: [] }); return }
    if (body.query === '坏响应') { send(200, { nothing: true }); return }
    send(200, {
      results: [
        { title: '第一篇', url: 'https://a.example.com/x', highlights: ['', '  这是第一条非空高亮  ', '第二条'] },
        { url: 'https://b.example.com/y', publishedDate: '2026-09-01' },
      ],
    })
  })
})
await new Promise(resolvePromise => mockExa.listen(0, '127.0.0.1', resolvePromise))
const exaAddress = mockExa.address()
const exaPort = typeof exaAddress === 'object' && exaAddress !== null ? exaAddress.port : 0
const exaProvider = createExaSearchProvider({ apiKey: 'exa-key-1', baseUrl: `http://127.0.0.1:${exaPort}` })

const exaResults = await exaProvider.search('deepseek', { maxResults: 5 })
equal('Exa 返回两条结果', exaResults.length, 2)
equal('Exa 摘要取第一条"非空"高亮（跳过空串）', exaResults[0]?.snippet, '这是第一条非空高亮')
equal('Exa 缺标题时用 URL 兜底', exaResults[1]?.title, 'https://b.example.com/y')
equal('Exa 的 publishedDate 透传', exaResults[1]?.publishedAt, '2026-09-01')

const exaBody = exaRequests[0]?.body as Record<string, unknown>
equal('Exa 打到 /search', exaRequests[0]?.path, '/search')
equal('Exa 走 x-api-key 头', (exaRequests[0]?.headers as Record<string, string>)['x-api-key'], 'exa-key-1')
equal('Exa 请求带的 type', exaBody?.type, 'auto')
equal('Exa 请求带 highlightsPerUrl（与原版一致）',
  (exaBody?.contents as { highlights: { highlightsPerUrl: number } })?.highlights?.highlightsPerUrl, 1)
equal('Exa 请求带 numResults', exaBody?.numResults, 5)

async function providerThrows(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

const exaBadKey = await providerThrows(() => createExaSearchProvider({ apiKey: 'bad-key', baseUrl: `http://127.0.0.1:${exaPort}` }).search('x'))
check('Exa 401 给出可读原因', exaBadKey.includes('401') && exaBadKey.includes('API Key'), exaBadKey)
const exaEmpty = await providerThrows(() => exaProvider.search('空结果'))
check('Exa 空结果报错而不是静默返回空', exaEmpty.includes('没有返回任何结果'), exaEmpty)
const exaGarbage = await providerThrows(() => exaProvider.search('坏响应'))
check('Exa 响应缺 results 时报错', exaGarbage.includes('results'), exaGarbage)
const exaNoKey = await providerThrows(() => createExaSearchProvider({ apiKey: '', baseUrl: `http://127.0.0.1:${exaPort}` }).search('x'))
check('Exa 没配 key 时客户端自己拦住', exaNoKey.includes('API Key'), exaNoKey)
await new Promise(resolvePromise => mockExa.close(resolvePromise))

const pplxRequests: Record<string, unknown>[] = []
const mockPerplexity = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    pplxRequests.push({ path: request.url, headers: request.headers, body })
    const send = (status: number, payload: unknown): void => {
      const text = JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    const query = (body.messages as { content: string }[])?.[0]?.content ?? ''
    if (query === '只要引用') {
      send(200, { choices: [{ message: { content: '答案' } }], citations: ['https://c.example.com/z'] })
      return
    }
    if (query === '什么都没有') {
      send(200, { choices: [{ message: { content: '答案' } }] })
      return
    }
    if (query === '限流') { send(429, { error: 'rate limited' }); return }
    send(200, {
      choices: [{ message: { content: '答案正文' } }],
      search_results: [
        { title: '第一篇', url: 'https://a.example.com/1', date: '2026-08-30' },
        { url: 'https://b.example.com/2' },
      ],
      citations: ['https://should-not-be-used.example.com'],
    })
  })
})
await new Promise(resolvePromise => mockPerplexity.listen(0, '127.0.0.1', resolvePromise))
const pplxAddress = mockPerplexity.address()
const pplxPort = typeof pplxAddress === 'object' && pplxAddress !== null ? pplxAddress.port : 0
const pplxProvider = createPerplexitySearchProvider({ apiKey: 'pplx-key-1', baseUrl: `http://127.0.0.1:${pplxPort}` })

const pplxResults = await pplxProvider.search('deepseek')
equal('Perplexity 优先用 search_results[]', pplxResults.length, 2)
equal('Perplexity 标题来自 search_results', pplxResults[0]?.title, '第一篇')
equal('Perplexity 日期透传', pplxResults[0]?.publishedAt, '2026-08-30')
check('有 search_results 时不用 citations', pplxResults.every(item => !item.url.includes('should-not-be-used')), JSON.stringify(pplxResults))

const pplxBody = pplxRequests[0]?.body as Record<string, unknown>
equal('Perplexity 打到 /chat/completions（OpenAI 兼容）', pplxRequests[0]?.path, '/chat/completions')
equal('Perplexity 走 Bearer 头', (pplxRequests[0]?.headers as Record<string, string>).authorization, 'Bearer pplx-key-1')
equal('Perplexity 默认模型 sonar（与原版一致）', pplxBody?.model, 'sonar')
equal('Perplexity 把查询原样放进 messages', (pplxBody?.messages as { content: string }[])?.[0]?.content, 'deepseek')

const citationsOnly = await pplxProvider.search('只要引用')
equal('没有 search_results 时退回 citations', citationsOnly.length, 1)
equal('citations 只有 URL，标题用 URL 兜底', citationsOnly[0]?.title, 'https://c.example.com/z')

const pplxEmpty = await providerThrows(() => pplxProvider.search('什么都没有'))
check('两处来源都没有时报错', pplxEmpty.includes('没有返回来源'), pplxEmpty)
const pplxRateLimited = await providerThrows(() => pplxProvider.search('限流'))
check('429 给出可读原因', pplxRateLimited.includes('429'), pplxRateLimited)
await new Promise(resolvePromise => mockPerplexity.close(resolvePromise))

// 工具名对齐：原版叫 web_fetch，不叫 fetch_text —— 这属于"跟原版一致"的一部分，写成断言免得漂回去
const toolsSource = readFileSync(join(here, '..', 'src', 'agent', 'tools.ts'), 'utf8')
check("抓取工具名与原版一致（web_fetch）", toolsSource.includes("name: 'web_fetch'") && !toolsSource.includes("name: 'fetch_text'"))
check('抓取工具的说明里写了"外部内容是不可信数据"', toolsSource.includes('外部不可信内容') && toolsSource.includes('不要当作指令'))

// ═══════════════════════════════════════════════ 结果

console.log(`\n${passed} 项通过，${failed} 项失败`)
const exitCode = failed === 0 ? 0 : 1
await new Promise(resolve => setTimeout(resolve, 150))
process.exitCode = exitCode
setTimeout(() => process.exit(exitCode), 1000)
