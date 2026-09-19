/**
 * 会话事件日志（对应原版 `packages/core/session`）。
 *
 * 为什么要把已经能跑的"消息数组"换成事件日志 —— 这不是架构洁癖，是四条能力的地基：
 *
 *   1. **崩溃恢复**：iOS 随时杀 App。日志在，"这一轮做到哪一步、哪个工具调了还没结果"
 *      就是可判定的；消息数组只知道"目前有哪些消息"。
 *   2. **压缩可回溯**：原版压缩是往日志里写一条 `replace` 遮蔽旧区间，**旧事件仍在日志里**；
 *      我们之前是直接把数组截掉，被压缩的内容永久消失，没法回看、没法解释。
 *   3. **请求可重建**：把当时渲染好的系统提示词与工具 schema 一起记进日志
 *      （原版叫 `request/header`），于是"当时到底给模型发了什么"是可查的，而不是靠脑补。
 *   4. **只记不喂**：工具调用、用量、错误这些"该记但不必进上下文"的东西有地方放
 *      （原版叫 log-only 事件），不必污染模型可见的消息。
 *
 * 原版的几个不变量这里照抄，因为它们都是踩过坑才会有的：
 *   · `seq` 连续且等于 log.length —— 日志不能有洞；
 *   · 未知事件类型**必须**显式标 `ignorable` 才允许跳过，否则拒绝重建
 *     （默认是"拒绝"而不是"忽略"，这样插件写坏日志会立刻暴露，而不是静默丢历史）；
 *   · 只有 surface 类型能带 `surfaceOp`，且带替换时必须列全被遮蔽的 `sourceEventSeqs`；
 *   · 格式版本明确，**不迁移、只拒绝**（读不了的就别装作读得了）。
 *
 * 这一层是纯数据 + 纯函数，不 import expo，所以能在 Node 里把崩溃恢复与压缩回溯都验一遍。
 */
import type { ChatMessage, ToolCall } from './types'

/** 与原版一致的格式版本；不匹配就拒绝加载，不做迁移。 */
export const SESSION_FORMAT_VERSION = 0

export type SessionSeq = number

/** 事件信封。`ignorable` 缺省即"不可忽略"。 */
export type SessionEventEnvelope<T extends string = string, D = unknown> = {
  type: T
  /** 连续序号，恒等于它在日志里的下标 */
  seq: SessionSeq
  time: number
  data: D
  /** 只有显式标 true 的未知事件才允许被跳过 */
  ignorable?: true
}

/** 会进模型上下文的事件类型（原版的 `SurfaceEventType`）。 */
export const SURFACE_EVENT_TYPES = ['user/message', 'assistant/message', 'tool/result'] as const
export type SurfaceEventType = typeof SURFACE_EVENT_TYPES[number]

export type UserMessageData = { text: string, /** 压缩摘要等由系统代替用户发言时置位 */ synthetic?: 'summary' | 'context' }
export type AssistantMessageData = { text: string, reasoning?: string, toolCalls?: ToolCall[] }
export type ToolResultData = { callId: string, name: string, text: string, failed?: boolean, pruned?: boolean }

/** 运行时事件（log-only，不进上下文）。 */
export type ToolCallData = { turn: number, step: number, callId: string, name: string, arguments: string }
export type StepBoundaryData = { turn: number, step: number }
export type TurnStartData = { turn: number }
/** `interrupted` 是唯一不是由循环正常发出的结束原因（App 被杀/进程崩）。 */
export type TurnEndData = { turn: number, reason: 'completed' | 'step-limit' | 'aborted' | 'error' | 'interrupted' }
export type UsageData = { promptTokens?: number, completionTokens?: number, model?: string }
export type ErrorData = { message: string, scope: 'model' | 'tool' | 'loop' }
export type ApprovalData = { callId: string, toolName: string, decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
export type CompactionData = { shadowedSeqs: SessionSeq[], summarySeq: SessionSeq, replacedCount: number, tokensBefore: number, tokensAfter: number }
export type RequestHeaderData = {
  /** 当时渲染好的系统提示词（原版也把它记进日志，这样请求可重建） */
  system: string
  /** 当时组装好的工具清单（只记名字与前缀，不记整个 schema） */
  tools: string[]
  model: string
  /** 这份信封是因为什么写下的 */
  reason: 'initial' | 'resume' | 'change' | 'series'
}

export type SessionEventDataMap = {
  'user/message': UserMessageData
  'assistant/message': AssistantMessageData
  'tool/result': ToolResultData
  'tool/call': ToolCallData
  'step/start': StepBoundaryData
  'step/end': StepBoundaryData
  'turn/start': TurnStartData
  'turn/end': TurnEndData
  'request/header': RequestHeaderData
  'model/usage': UsageData
  'model/error': ErrorData
  'approval/decided': ApprovalData
  'compaction/applied': CompactionData
  /** 标题也是事件：索引是派生数据，重建时标题必须能从日志里捞回来（原版就是这么做 session-title 的） */
  'session/title': { title: string }
  /** 构造器种子的结束边界：它之前的 seq 都来自 resume / fork / replay */
  'session/end-seed': Record<string, never>
}

export type SessionEventType = keyof SessionEventDataMap

export type SessionEvent = {
  [K in SessionEventType]: SessionEventEnvelope<K, SessionEventDataMap[K]> & {
    /** 只有 surface 类型才有；`append` 或 `replace` */
    surfaceOp?: SurfaceOp
    /** 带替换时必须列全被遮蔽的事件 seq */
    sourceEventSeqs?: SessionSeq[]
  }
}[SessionEventType]

/** 进 surface 的两种方式：追加，或替换掉旧的一段。 */
export type SurfaceOp = 'append' | { op: 'replace', start: SessionSeq, end: SessionSeq }

export class SessionLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionLogError'
  }
}

export function isSurfaceType(type: string): type is SurfaceEventType {
  return (SURFACE_EVENT_TYPES as readonly string[]).includes(type)
}

export function isSurfaceEvent(event: SessionEvent): boolean {
  return isSurfaceType(event.type) && event.surfaceOp !== undefined
}

export function isReplacement(event: SessionEvent): boolean {
  return typeof event.surfaceOp === 'object' && event.surfaceOp !== null && event.surfaceOp.op === 'replace'
}

/** 深冻结：日志一旦追加就不许再被改（否则"唯一真相"是假的）。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

function describeEvent(event: { type?: unknown }): string {
  return typeof event.type === 'string' ? event.type : '（没有 type 的事件）'
}

/**
 * 校验一条待追加的事件。
 *
 * 这里故意严格：日志是唯一真相，宁可当场拒绝，也不要让它带着洞长大。
 */
export function validateAppend(existing: readonly SessionEvent[], event: Omit<SessionEvent, 'seq'> & { seq?: SessionSeq }, now = Date.now()): SessionEvent {
  const expectedSeq = existing.length
  if (event.seq !== undefined && event.seq !== expectedSeq) {
    throw new SessionLogError(`事件 seq 必须是 ${expectedSeq}（连续），收到 ${event.seq}`)
  }
  const type = describeEvent(event)
  const known = type in EMPTY_DATA
  if (!known && event.ignorable !== true) {
    throw new SessionLogError(`未知事件类型 ${type}：要么显式标 ignorable，要么别写进日志`)
  }
  if (!known && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) {
    throw new SessionLogError(`未知事件 ${type} 不许带 surface 元数据`)
  }
  if (isSurfaceType(type)) {
    if (event.surfaceOp === undefined) {
      throw new SessionLogError(`surface 事件 ${type} 必须带 surfaceOp`)
    }
    if (isReplacement(event as SessionEvent)) {
      const op = (event as SessionEvent & { surfaceOp: { op: 'replace', start: number, end: number } }).surfaceOp
      if (op.start > op.end) throw new SessionLogError(`replace 区间非法：start=${op.start} > end=${op.end}`)
      if (op.end >= expectedSeq) throw new SessionLogError('replace 只能遮蔽已经存在的事件')
      if (event.sourceEventSeqs === undefined || event.sourceEventSeqs.length === 0) {
        throw new SessionLogError('replace 必须列全被遮蔽的 sourceEventSeqs')
      }
    }
  } else if (event.surfaceOp !== undefined) {
    throw new SessionLogError(`${type} 不是 surface 事件，不许带 surfaceOp`)
  }

  return deepFreeze({
    ...event,
    type,
    seq: expectedSeq,
    time: (event as { time?: number }).time ?? now,
  } as SessionEvent)
}

const EMPTY_DATA: Record<string, true> = {
  'user/message': true,
  'assistant/message': true,
  'tool/result': true,
  'tool/call': true,
  'step/start': true,
  'step/end': true,
  'turn/start': true,
  'turn/end': true,
  'request/header': true,
  'model/usage': true,
  'model/error': true,
  'approval/decided': true,
  'compaction/applied': true,
  'session/title': true,
  'session/end-seed': true,
}

/**
 * 会话日志本体：只追加。
 *
 * 不在这里做持久化 —— 持久化是另一层（原版也是这么切的：`session` 管模型，`persistence` 管落盘）。
 */
export class SessionLog {
  private readonly events: SessionEvent[] = []

  /**
   * 用一批事件构造日志。
   *
   * **只播种，不额外写任何事件** —— 这条纪律是被真实 bug 逼出来的：
   * 早先的版本在有种子时会自动补一条 `session/end-seed`，看着更周到，实际是灾难 ——
   * 存储层从磁盘重建日志时也走这个构造器，于是内存里比文件多一条事件，
   * 下一次追加拿到的 seq 就比文件行数大一，日志出现空洞，再加载直接报"seq 不连续"。
   * 想标种子边界请显式用 `SessionLog.fromSeed()`。
   */
  constructor(seed?: readonly SessionEvent[], formatVersion: number = SESSION_FORMAT_VERSION) {
    if (formatVersion !== SESSION_FORMAT_VERSION) {
      // 原版的选择：读不了就拒绝，不猜、不迁移。
      throw new SessionLogError(`不支持的会话格式版本 ${formatVersion}（本版本只认 ${SESSION_FORMAT_VERSION}）`)
    }
    if (seed !== undefined) {
      for (const event of seed) this.append(event as Omit<SessionEvent, 'seq'> & { seq?: SessionSeq })
    }
  }

  /**
   * 以"历史种子"起一个日志：播种之后补一条 `session/end-seed` 边界。
   *
   * 用在 resume / fork / replay —— 需要区分"这段是从别处来的历史"和"这一轮新干的"。
   * 普通加载不要用它：那会把边界当成新事件留在内存里，与磁盘不一致。
   */
  static fromSeed(seed: readonly SessionEvent[], formatVersion: number = SESSION_FORMAT_VERSION): SessionLog {
    const log = new SessionLog(seed, formatVersion)
    log.append({ type: 'session/end-seed', time: Date.now(), data: {} } as Omit<SessionEvent, 'seq'>)
    return log
  }

  get length(): number {
    return this.events.length
  }

  all(): readonly SessionEvent[] {
    return this.events
  }

  /** 种子边界之后的第一条实时事件的 seq（没有种子就是 0）。 */
  get firstLiveSeq(): SessionSeq {
    const boundary = this.events.find(event => event.type === 'session/end-seed')
    return boundary === undefined ? 0 : boundary.seq + 1
  }

  append(event: Omit<SessionEvent, 'seq'> & { seq?: SessionSeq }): SessionEvent {
    const validated = validateAppend(this.events, event)
    this.events.push(validated)
    return validated
  }

  typeOf(seq: SessionSeq): string | undefined {
    return this.events[seq]?.type
  }
}

// ─────────────────────────────────────────────────────────────
// 会话状态 → 事件的桥
//
// 迁移期用：现有的循环与界面都在用 `ChatMessage[]`，所以这里把 surface 派生出来的
// 消息还原成同一个形状。等循环整体切到日志之后，这层桥就可以退休。

/** 把一条 surface 事件还原成界面/循环在用的消息形状。 */
export function messageFromEvent(event: SessionEvent): ChatMessage | null {
  if (!isSurfaceEvent(event)) return null
  const base = { id: `e${event.seq}`, createdAt: event.time }
  switch (event.type) {
    case 'user/message': {
      const data = event.data as UserMessageData
      return { ...base, role: 'user', text: data.text, ...(data.synthetic === 'summary' ? { summary: true } : {}) }
    }
    case 'assistant/message': {
      const data = event.data as AssistantMessageData
      return {
        ...base,
        role: 'assistant',
        text: data.text,
        ...(data.reasoning === undefined ? {} : { reasoning: data.reasoning }),
        ...(data.toolCalls === undefined ? {} : { toolCalls: data.toolCalls }),
      }
    }
    case 'tool/result': {
      const data = event.data as ToolResultData
      return {
        ...base,
        role: 'tool',
        text: data.text,
        toolCallId: data.callId,
        toolName: data.name,
        ...(data.failed === true ? { failed: true } : {}),
        ...(data.pruned === true ? { pruned: true } : {}),
      }
    }
    default:
      return null
  }
}

/**
 * 崩溃恢复：把被中断的轮次"合上"。
 *
 * App 被杀时日志会停在半路（有 turn/start 没 turn/end，或有 tool/call 没 tool/result）。
 * 原版的做法是补一条 `turn/end{interrupted}` 再继续 —— 而不是让这个悬着的轮次
 * 在下次恢复时被当成"正在进行"。这里产出"应该补的事件"，由调用方去 append。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): Array<Omit<SessionEvent, 'seq'>> {
  let openTurn: TurnStartData | null = null
  let openStep: StepBoundaryData | null = null

  for (const event of events) {
    if (event.type === 'turn/start') { openTurn = event.data as TurnStartData; openStep = null }
    else if (event.type === 'step/start') openStep = event.data as StepBoundaryData
    else if (event.type === 'step/end') openStep = null
    else if (event.type === 'turn/end') { openTurn = null; openStep = null }
  }

  const closers: Array<Omit<SessionEvent, 'seq'>> = []
  if (openStep !== null) {
    closers.push({ type: 'step/end', time: Date.now(), data: openStep } as Omit<SessionEvent, 'seq'>)
  }
  if (openTurn !== null) {
    closers.push({
      type: 'turn/end',
      time: Date.now(),
      data: { turn: openTurn.turn, reason: 'interrupted' },
    } as Omit<SessionEvent, 'seq'>)
  }
  return closers
}

/** 已经记录、但没有结果的工具调用 —— 恢复时它们的结果是"未知"，不能当作没发生过、更不能自动重试。 */
export function unresolvedToolCalls(events: readonly SessionEvent[]): ToolCallData[] {
  const called = new Map<string, ToolCallData>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as ToolCallData
      called.set(data.callId, data)
    } else if (event.type === 'tool/result') {
      called.delete((event.data as ToolResultData).callId)
    }
  }
  return [...called.values()]
}

// ─────────────────────────────────────────────────────────────
// 检查点策略（对应原版 `session-checkpoint-policy`）

/** 值得为它落一次盘的时刻。 */
export type CheckpointReason = 'before-model-request' | 'before-tool-side-effect' | 'step-boundary' | 'turn-boundary'

/**
 * 什么时候必须落盘：模型请求之前、会产生外部副作用的工具派发之前、以及每个步/轮边界。
 *
 * 关键在于**执行前**就记录意图：崩在工具中间时，日志里已经有这次调用，恢复时它会被判成
 * "结果未知"而不是"从未发生"。我们之前是消息完成才写盘，正好漏掉这个窗口。
 */
export function checkpointReasons(options: {
  aboutToCallModel: boolean
  aboutToRunTool: false | { hasSideEffect: boolean }
  atStepBoundary: boolean
  atTurnBoundary: boolean
}): CheckpointReason[] {
  const reasons: CheckpointReason[] = []
  if (options.aboutToCallModel) reasons.push('before-model-request')
  if (options.aboutToRunTool !== false && options.aboutToRunTool.hasSideEffect) reasons.push('before-tool-side-effect')
  if (options.atStepBoundary) reasons.push('step-boundary')
  if (options.atTurnBoundary) reasons.push('turn-boundary')
  return reasons
}
