/**
 * 上下文压缩（对应 DSH 的 compaction）。
 *
 * 手机上没有"窗口还够用"这回事：几轮工具调用就能把上下文顶满，顶满的直接后果不是变慢，
 * 是整轮无法继续。所以压缩在这里是**正确性问题，不是优化**。
 *
 * 做法和 DSH 一致：把较早的一段交给模型总结成一条摘要消息，替换掉那段区间，
 * 最近的消息原样保留。区别是这边没有事件日志，摘要直接以一条 user 消息进历史。
 *
 * 兜底原则：**压缩失败绝不能让这一轮失败** —— 总结调用出错就退化成裁剪。
 */
import { serializeForSummary, estimateContext, pruneToolResults } from './tokens'
import { SUMMARY_INSTRUCTION } from './systemPrompt'
import type { ChatMessage, LlmConfig, StreamFn, ToolSpec } from './types'

export type CompactionOutcome = {
  messages: ChatMessage[]
  /** null 表示这次没压成，走的是裁剪兜底 */
  summary: string | null
  replacedCount: number
  tokensBefore: number
  tokensAfter: number
  reason: 'summarized' | 'pruned' | 'skipped' | 'failed'
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 切点：保留最后 keepRecent 条，但**不能把工具结果和它的调用切开** ——
 * 一条孤立的 role:tool 消息在协议上是非法的，服务端会直接报错。
 */
export function findCutIndex(messages: ChatMessage[], keepRecent: number): number {
  let cut = Math.max(0, messages.length - keepRecent)
  while (cut > 0 && messages[cut]?.role === 'tool') cut -= 1
  return cut
}

/** 用一条独立的模型调用把旧区间压成摘要。 */
export async function summarizeRange(options: {
  stream: StreamFn
  config: LlmConfig
  messages: ChatMessage[]
  signal?: AbortSignal
}): Promise<string> {
  const { stream, config, messages, signal } = options
  const transcript = serializeForSummary(messages)

  const request: ChatMessage[] = [
    { id: 'sum-sys', role: 'system', text: '你是对话压缩器，只输出摘要正文。', createdAt: Date.now() },
    { id: 'sum-user', role: 'user', text: `${SUMMARY_INSTRUCTION}\n\n===== 待压缩的对话 =====\n${transcript}`, createdAt: Date.now() },
  ]

  let summary = ''
  // tools 传空数组：压缩调用不该触发任何工具。
  for await (const chunk of stream({ config, messages: request, tools: [], signal })) {
    if (chunk.type === 'text') summary += chunk.text
  }

  const trimmed = summary.trim()
  if (trimmed === '') throw new Error('摘要为空')
  return trimmed
}

/**
 * 压不动的兜底：先裁旧工具输出，再把更早的消息整段丢掉，并留一行说明。
 *
 * 关键点：兜底**必须真的缩**。只裁工具输出来"兜底"是不够的 —— 纯对话的长历史里
 * 一条超长工具输出都没有，那样兜完还是溢出。所以最后一步必然按窗口切掉。
 * 用户会看到"历史被裁剪"，但对话能继续 —— 这比报错好。
 */
function fallbackShrink(messages: ChatMessage[], keepRecent: number): CompactionOutcome {
  const tokensBefore = estimateContext(messages)
  const cap = Math.max(keepRecent, 6)
  let next = pruneToolResults(messages, { keepRecent: cap, maxChars: 400 }).messages

  const cut = next.length > cap ? findCutIndex(next, cap) : 0
  let replacedCount = 0
  if (cut > 0) {
    const dropped = next.slice(0, cut)
    const stub: ChatMessage = {
      id: newId('sum'),
      role: 'user',
      summary: true,
      text: `【历史已裁剪】为腾出上下文，较早的 ${cut} 条消息已丢弃（压缩调用失败，未能生成摘要）。如果缺少关键信息，请让用户补充。`,
      createdAt: Date.now(),
    }
    // 说明本身也占 token。被丢掉的若全是短消息，加说明反而更大 —— 那种情况就别加。
    const worthExplaining = estimateContext([stub]) < estimateContext(dropped)
    next = worthExplaining ? [stub, ...next.slice(cut)] : next.slice(cut)
    replacedCount = cut
  }

  return {
    messages: next,
    summary: null,
    replacedCount,
    tokensBefore,
    tokensAfter: estimateContext(next),
    reason: 'pruned',
  }
}

export async function compactMessages(options: {
  stream: StreamFn
  config: LlmConfig
  messages: ChatMessage[]
  tools: ToolSpec[]
  keepRecent?: number
  signal?: AbortSignal
}): Promise<CompactionOutcome> {
  const { stream, config, messages, tools, signal } = options
  const keepRecent = options.keepRecent ?? 8
  const tokensBefore = estimateContext(messages, tools)
  const cut = findCutIndex(messages, keepRecent)

  // 没多少可压的时候别浪费一次模型调用。
  if (cut < 4) {
    return { messages, summary: null, replacedCount: 0, tokensBefore, tokensAfter: tokensBefore, reason: 'skipped' }
  }

  const older = messages.slice(0, cut)
  const kept = messages.slice(cut)

  try {
    const summary = await summarizeRange({ stream, config, messages: older, signal })
    const summaryMessage: ChatMessage = {
      id: newId('sum'),
      role: 'user',
      summary: true,
      text: `【对话摘要】${summary}`,
      createdAt: Date.now(),
    }
    const next = [summaryMessage, ...kept]
    return {
      messages: next,
      summary,
      replacedCount: older.length,
      tokensBefore,
      tokensAfter: estimateContext(next, tools),
      reason: 'summarized',
    }
  } catch {
    return fallbackShrink(messages, keepRecent)
  }
}
