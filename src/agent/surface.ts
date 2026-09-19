/**
 * Surface 折叠（对应原版 `packages/core/session/src/surface.ts`）。
 *
 * 这是事件日志最值钱的一层：**模型看到的消息列表是从日志"折叠"出来的**，而不是存下来的。
 * 于是"压缩"就变成了往日志里再写一条带 `replace` 的节点去**遮蔽**一段旧节点 ——
 * 旧事件仍然在日志里（能查、能解释、能回看），只是不再出现在模型看得见的那份列表里。
 *
 * 我们之前是直接把消息数组截掉：被压缩的内容永久消失。这不是"实现细节不同"，
 * 是能力差别 —— 原版能回答"这段历史当时是什么"，我们只能回答"现在是这些"。
 *
 * 不变量（照抄原版，都是血泪）：
 *   · 只有 surface 事件能进折叠；
 *   · 替换必须**列全**被遮蔽的 seq，列错就报错（宁可当场炸，也不要让"遮蔽集"和事实对不上）；
 *   · `replaceGeneration` 每次替换自增，供压缩/裁剪判断自己的判断是否已经过期；
 *   · 折叠是纯函数：同样的日志一定得到同样的消息列表（replay = 重新派生）。
 */
import {
  SessionLog, SessionLogError, SURFACE_EVENT_TYPES, isReplacement, isSurfaceEvent, messageFromEvent,
} from './sessionLog'
import type { SessionEvent, SessionSeq } from './sessionLog'
import type { ChatMessage } from './types'

export type SurfaceNode = {
  /** 这条节点自己的事件 seq */
  seq: SessionSeq
  event: SessionEvent
  /** 它遮蔽掉的旧节点（压缩替换时会非空） */
  shadowed: SessionSeq[]
}

export type SurfaceFold = {
  /** 模型可见的、按顺序排列的节点 */
  nodes: SurfaceNode[]
  /** 发生过多少次替换 —— 供压缩/裁剪判断自己的旧判断是否已过期 */
  replaceGeneration: number
  /** 折叠出来的消息（界面与循环直接可用） */
  messages: ChatMessage[]
}

export function foldSurface(events: readonly SessionEvent[]): SurfaceFold {
  let nodes: SurfaceNode[] = []
  let replaceGeneration = 0

  for (const event of events) {
    if (!isSurfaceEvent(event)) continue

    if (!isReplacement(event)) {
      nodes.push({ seq: event.seq, event, shadowed: [] })
      continue
    }

    const op = event.surfaceOp as { op: 'replace', start: SessionSeq, end: SessionSeq }
    const hit = nodes.filter(node => node.seq >= op.start && node.seq <= op.end)
    const declared = [...(event.sourceEventSeqs ?? [])].sort((left, right) => left - right)
    const actual = hit.map(node => node.seq).sort((left, right) => left - right)

    // 两道闸，守的是"遮蔽集必须说实话"：
    //   ① 声明的 seq 不能跑到区间之外（那说明这条事件和自己的区间对不上）；
    //   ② **区间里活着的节点一个都不能漏**（漏了就是"静默遮蔽"：历史被吃掉却没人知道）。
    // 允许声明里包含"已经被遮蔽过的" seq —— 二次压缩时区间会横跨上一次的摘要节点，
    // 把它一并列出来是自然的写法，而且无害（它本来就不在 surface 上）。
    // 这道闸只能在这里守：追加时日志还不知道 surface 长什么样，只有折叠起来才谈得上"实际遮蔽了谁"。
    const outside = declared.filter(seq => seq < op.start || seq > op.end)
    if (outside.length > 0) {
      throw new SessionLogError(`surface 替换声明了区间之外的 seq：${outside.join(',')}（区间 ${op.start}..${op.end}）`)
    }
    // ③ 声明的 seq 必须真的是 **surface 事件**。
    // 否则会出现这种很难查的情形：调用方把"请求信封"或"日志边界"的 seq 当成消息 seq 报上来，
    // 表面上"声明覆盖了实际"通过校验，实际却少遮了一条消息 —— 消息数对不上，还找不到原因。
    const notSurface = declared.filter(seq => {
      const target = events[seq]
      return target === undefined || !(SURFACE_EVENT_TYPES as readonly string[]).includes(target.type)
    })
    if (notSurface.length > 0) {
      throw new SessionLogError(`surface 替换声明的 seq 不是消息事件：${notSurface.join(',')}（只有 ${SURFACE_EVENT_TYPES.join(' / ')} 会产生消息）`)
    }
    const missing = actual.filter(seq => !declared.includes(seq))
    if (missing.length > 0) {
      throw new SessionLogError(`surface 替换漏报了被遮蔽的节点：${missing.join(',')}（声明 [${declared.join(',')}]，实际 [${actual.join(',')}]）`)
    }
    if (actual.length === 0) {
      throw new SessionLogError(`surface 替换没有命中任何节点（区间 ${op.start}..${op.end}）`)
    }

    const insertAt = nodes.findIndex(node => node.seq === actual[0])
    const replacement: SurfaceNode = { seq: event.seq, event, shadowed: actual }
    // 遮蔽集**不一定连续**（上一次的摘要节点可能坐在被遮蔽区间中间），
    // 所以不能按"从插入点起删 hit.length 个"来切 —— 那是错的，会在二次压缩时漏掉节点。
    // 正确做法：把这几个节点整批摘掉，再把替换节点插在"第一个被摘节点的原位置"。
    const hitSeqs = new Set(actual)
    const kept = nodes.filter(node => !hitSeqs.has(node.seq))
    const keptBefore = nodes.slice(0, insertAt).filter(node => !hitSeqs.has(node.seq)).length
    nodes = [...kept.slice(0, keptBefore), replacement, ...kept.slice(keptBefore)]
    replaceGeneration += 1
  }

  const messages: ChatMessage[] = []
  for (const node of nodes) {
    const message = messageFromEvent(node.event)
    if (message !== null) messages.push(message)
  }

  return { nodes, replaceGeneration, messages }
}

/** 派生模型可见的消息列表（replay 就是重新跑这一句）。 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  return foldSurface(events).messages
}

/** 最新一份请求信封：把"当时发的系统提示词与工具清单"捞出来。 */
export function foldRequestHeader(events: readonly SessionEvent[]): (SessionEvent & { type: 'request/header' }) | null {
  let latest: (SessionEvent & { type: 'request/header' }) | null = null
  for (const event of events) {
    if (event.type === 'request/header') latest = event as SessionEvent & { type: 'request/header' }
  }
  return latest
}

/** 把一条消息追加成 surface 事件（迁移期的桥：现有循环产出 ChatMessage，这里转成事件）。 */
export function appendMessageEvent(log: SessionLog, message: ChatMessage): SessionEvent {
  switch (message.role) {
    case 'user':
      return log.append({
        type: 'user/message',
        time: message.createdAt,
        surfaceOp: 'append',
        data: {
          text: message.text,
          ...(message.summary === true ? { synthetic: 'summary' as const } : {}),
        },
      } as Omit<SessionEvent, 'seq'>)
    case 'assistant':
      return log.append({
        type: 'assistant/message',
        time: message.createdAt,
        surfaceOp: 'append',
        data: {
          text: message.text,
          ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
          ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
        },
      } as Omit<SessionEvent, 'seq'>)
    case 'tool':
      return log.append({
        type: 'tool/result',
        time: message.createdAt,
        surfaceOp: 'append',
        data: {
          callId: message.toolCallId ?? '',
          name: message.toolName ?? '',
          text: message.text,
          ...(message.failed === true ? { failed: true } : {}),
          ...(message.pruned === true ? { pruned: true } : {}),
        },
      } as Omit<SessionEvent, 'seq'>)
    case 'system':
      // 系统提示词不进 surface（原版也一样：它走 request/header 这条 log-only 路径）。
      return log.append({
        type: 'request/header',
        time: message.createdAt,
        data: { system: message.text, tools: [], model: '', reason: 'change' },
      } as Omit<SessionEvent, 'seq'>)
  }
}

/**
 * 压缩：往日志里写一段"遮蔽 + 一条摘要"。
 *
 * 顺序与原版一致：先记 `compaction/applied`（log-only，说明这次压缩遮蔽了哪些 seq），
 * 再写那条带 `replace` 的摘要消息。旧事件**一个都不删**。
 */
export function appendCompaction(log: SessionLog, options: {
  summary: string
  /** 要遮蔽的 surface 节点 seq（必须与折叠出来的事实一致） */
  shadowedSeqs: SessionSeq[]
  replacedCount: number
  tokensBefore: number
  tokensAfter: number
  now?: number
}): { summarySeq: SessionSeq, appliedSeq: SessionSeq } {
  const { shadowedSeqs } = options
  if (shadowedSeqs.length === 0) throw new SessionLogError('压缩至少要遮蔽一个节点')
  const sorted = [...shadowedSeqs].sort((left, right) => left - right)
  const start = sorted[0] as SessionSeq
  const end = sorted[sorted.length - 1] as SessionSeq

  const applied = log.append({
    type: 'compaction/applied',
    time: options.now ?? Date.now(),
    data: {
      shadowedSeqs: sorted,
      // 摘要事件的 seq 就是"下一条"，这里先占位、append 后再由调用方读取真实值
      summarySeq: log.length + 1,
      replacedCount: options.replacedCount,
      tokensBefore: options.tokensBefore,
      tokensAfter: options.tokensAfter,
    },
  } as Omit<SessionEvent, 'seq'>)

  const summary = log.append({
    type: 'user/message',
    time: options.now ?? Date.now(),
    data: { text: options.summary, synthetic: 'summary' as const },
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: sorted,
  } as unknown as Omit<SessionEvent, 'seq'>)

  return { summarySeq: summary.seq, appliedSeq: applied.seq }
}

/** 裁剪单条超大工具结果：同样用 replace，只遮蔽它自己（原版 compaction-tool-result-pruner 的做法）。 */
export function appendToolResultPrune(log: SessionLog, options: {
  targetSeq: SessionSeq
  callId: string
  name: string
  preview: string
  originalChars: number
  now?: number
}): SessionSeq {
  const event = log.append({
    type: 'tool/result',
    time: options.now ?? Date.now(),
    data: {
      callId: options.callId,
      name: options.name,
      text: `${options.preview}\n…（这条工具输出在历史里已被裁剪，原 ${options.originalChars} 字符）`,
      pruned: true,
    },
    surfaceOp: { op: 'replace', start: options.targetSeq, end: options.targetSeq },
    sourceEventSeqs: [options.targetSeq],
  } as unknown as Omit<SessionEvent, 'seq'>)
  return event.seq
}
