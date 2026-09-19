#!/usr/bin/env node
/**
 * DeepSeek 原生搜索的 mock 端点。
 *
 * 为什么要有它：搜索走的是 Anthropic 兼容的 Messages API，而真实调用要花一次模型回合的钱、
 * 还要有 key。这里把服务端形状固定下来（含 `web_search_tool_result` 块与 citations），
 * 让客户端能真跑：请求体对不对、结构化结果提不提得出来、没触发搜索时会不会报错，
 * 全都在本地验得干干净净。
 *
 * 单独跑： node scripts/mock-search-server.mjs
 * 被 import： startMockSearchServer() 在同一进程内 listen 随机端口
 */
import { createServer } from 'node:http'

export const MOCK_SEARCH_URLS = [
  'https://example.com/a',
  'https://example.com/b',
  'https://example.com/c',
]

/** 默认响应：两个搜索块 + 一个带 citations 的 text 块（片段来源）。 */
export function defaultSearchResponse() {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4-flash',
    content: [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          { type: 'web_search_result', url: MOCK_SEARCH_URLS[0], title: '第一篇', page_age: '2026-09-01' },
          { type: 'web_search_result', url: MOCK_SEARCH_URLS[1], title: '第二篇' },
        ],
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: [
          // 与第一次重复的 URL：客户端应当按 url 去重
          { type: 'web_search_result', url: MOCK_SEARCH_URLS[1], title: '第二篇（重复）' },
          { type: 'web_search_result', url: MOCK_SEARCH_URLS[2], title: '第三篇' },
        ],
      },
      {
        type: 'text',
        text: '根据搜索结果……',
        citations: [
          { type: 'web_search_result_location', url: MOCK_SEARCH_URLS[0], cited_text: '第一段的引用内容' },
          { type: 'web_search_result_location', url: MOCK_SEARCH_URLS[2], cited_text: '第三段的引用内容' },
          // 重复的 citation：应当只取第一次
          { type: 'web_search_result_location', url: MOCK_SEARCH_URLS[0], cited_text: '不该覆盖前面那条' },
        ],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

/** 没有搜索块（模型没触发搜索）—— 客户端必须报错而不是静默返回空。 */
export function noSearchResponse() {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '我不需要搜索就能回答。' }],
  }
}

/** 服务端明确说搜索失败。 */
export function searchErrorResponse() {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: '搜索服务暂时不可用' },
      { type: 'text', text: '搜索失败了。' },
    ],
  }
}

export async function startMockSearchServer(options = {}) {
  const requests = []
  // 也可以在起服务时就把行为钉死（客户端只会往 /messages 打，没机会带查询串）
  const forcedMode = options.mode ?? null
  const forcedStatus = Number(options.status ?? 500)
  const forcedDelayMs = Number(options.delayMs ?? 500)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    const send = (status, payload) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
    }

    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      let parsedBody = null
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsedBody = null
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: parsedBody,
      })

      // 关键路径：只认 POST /messages
      if (request.method !== 'POST' || url.pathname !== '/messages') {
        send(404, { error: 'mock 只有 POST /messages' })
        return
      }

      const mode = url.searchParams.get('mode') ?? forcedMode
      if (mode === 'status') {
        send(Number(url.searchParams.get('code') ?? forcedStatus), { error: 'mock 故障' })
        return
      }
      if (mode === 'garbage') { send(200, '这不是 JSON'); return }
      if (mode === 'nosearch') { send(200, noSearchResponse()); return }
      if (mode === 'searcherr') { send(200, searchErrorResponse()); return }
      if (mode === 'delay') {
        const ms = Number(url.searchParams.get('ms') ?? forcedDelayMs)
        setTimeout(() => send(200, defaultSearchResponse()), ms)
        return
      }
      send(200, defaultSearchResponse())
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
if (isMain) {
  const { url } = await startMockSearchServer()
  console.log(`mock 搜索端点在 ${url}`)
  console.log('用它做客户端自测：POST ' + url + '/messages')
  console.log('开关：?mode=nosearch | ?mode=searcherr | ?mode=garbage | ?mode=status&code=401 | ?mode=delay&ms=3000')
}
