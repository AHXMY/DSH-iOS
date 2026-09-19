/**
 * Agent 循环（事件日志驱动）。
 *
 * 与上一版的根本区别：**上下文不再是被循环持有的数组，而是从日志派生出来的**。
 * 循环只做三件事——往日志里写事件、按需派生、把派生结果发给模型。
 * 换来的是原先拿不到的四件事：
 *
 *   · 崩溃恢复：任何一步被杀，日志里都留着"做到了哪、哪个工具调了还没结果"；
 *   · 压缩可回溯：压缩写的是 `replace` 遮蔽事件，旧事件一条不删，随时能回看；
 *   · 请求可重建：每次模型请求前把渲染好的系统提示词与工具清单记进 `request/header`；
 *   · 失败即停（fail-closed）：事件写不进磁盘就中止这一轮，而不是"先干了再说"。
 *
 * 三条对齐原版的纪律，写在最前面免得以后被"优化"掉：
 *   1. **工具调用在执行前就入日志**（`tool/call`）——崩在工具中间时，这次调用是"结果未知"，
 *      而不是"从未发生"。这是能不能安全恢复的分水岭。
 *   2. **审批决定也入日志**（`approval/decided`，log-only）——"谁批的、批了什么"必须可审计。
 *   3. **写盘失败就中止**。手机上磁盘满、沙盒权限变化都会真实发生；
 *      继续跑下去只会产生一份"日志里没有、现实里发生了"的副作用。
 */
import { compactMessages, findCutIndex } from './compaction'
import { estimateContext, formatTokens } from './tokens'
import { composeSystemPrompt } from './systemPrompt'
import { BOOKKEEPING_TOOLS, needsApproval, planModeBlock } from './policy'
import { SessionLog, messageFromEvent } from './sessionLog'
import type { SessionEvent, SessionSeq } from './sessionLog'
import { appendCompaction, appendMessageEvent, appendToolResultPrune, deriveMessages, foldRequestHeader, foldSurface } from './surface'
import type {
  ApprovalDecision, ApprovalMode, ApprovalRequest, AskRequest, ChatMessage, LlmConfig,
  SessionState, StreamFn, SubagentReport, ToolCall, ToolContext, ToolSpec,
} from './types'

export type AgentEvent =
  | { type: 'step-start', step: number }
  | { type: 'reasoning-delta', messageId: string, text: string }
  | { type: 'text-delta', messageId: string, text: string }
  | { type: 'tool-call', messageId: string, name: string }
  | { type: 'tool-result', toolCallId: string, name: string, result: string, failed: boolean }
  | { type: 'assistant-done', message: ChatMessage }
  | { type: 'approval-request', request: ApprovalRequest }
  | { type: 'approval-result', request: ApprovalRequest, decision: ApprovalDecision }
  | { type: 'context', tokens: number, budget: number }
  | { type: 'compaction-start', tokens: number }
  | { type: 'compaction-done', summary: string | null, replacedCount: number, tokensAfter: number, reason: string }
  /** 日志变了（裁剪或压缩）：界面应当把会话换成这一份派生结果 */
  | { type: 'context-rewritten', messages: ChatMessage[] }
  | { type: 'state-changed' }
  | { type: 'error', message: string }
  | { type: 'done', reason: 'completed' | 'step-limit' | 'aborted' | 'error' }

export type ApprovalGate = {
  mode: ApprovalMode
  request: (request: ApprovalRequest) => Promise<ApprovalDecision>
}

export type RunAgentOptions = {
  /** 事件日志：唯一真相。历史上下文由它派生，不再单独传。 */
  log: SessionLog
  /** 把新事件持久化。**抛错即中止本轮**（fail-closed）。 */
  commit?: (events: SessionEvent[]) => void
  /** 流式补全实现（App 传真实客户端，测试传假流）。 */
  stream: StreamFn
  /** 人设：系统提示词的底座。 */
  persona: string
  config: LlmConfig
  tools: ToolSpec[]
  skills: { name: string, description: string }[]
  /** 会话可变状态：待办、计划模式、白名单。工具直接改它。 */
  state: SessionState
  approval: ApprovalGate
  ask: (request: AskRequest) => Promise<string>
  approvePlan: (plan: string) => Promise<boolean>
  /** 子代理入口；不传则 subagent 工具会明确报错而不是静默失败。 */
  spawnSubagent?: (task: string, options?: { maxSteps?: number }) => Promise<SubagentReport>
  /** 配了远程执行代理时，在提示词里说明"你不是只有这台手机"。 */
  sandboxLabel?: string
  /** 上下文预算（估算 token）；超过就压缩。 */
  contextBudget: number
  maxSteps?: number
  signal?: AbortSignal
  /** 全新会话的第一轮：请求信封的原因记成 initial 而不是 resume */
  initialRequest?: boolean
  emit: (event: AgentEvent) => void
  /** 会话状态（待办/计划模式/白名单）变了，请落盘并刷新界面。 */
  onStateChange?: (state: SessionState) => void
}

const MAX_TOOL_RESULT = 8000
/** 旧工具结果裁剪：只动"最近 8 条"之外、且超过 600 字符的那些。 */
const PRUNE_KEEP_RECENT = 8
const PRUNE_MAX_CHARS = 600
const COMPACT_KEEP_RECENT = 8

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 流式的 tool_calls 是按 index 分片的，这里按 index 归并成完整调用。 */
function mergeToolCall(accumulator: ToolCall[], index: number, id?: string, name?: string, argsDelta?: string): void {
  while (accumulator.length <= index) {
    accumulator.push({ id: '', name: '', arguments: '' })
  }
  const target = accumulator[index] as ToolCall
  if (id !== undefined && id !== '') target.id = id
  if (name !== undefined && name !== '') target.name = target.name + name
  if (argsDelta !== undefined) target.arguments += argsDelta
}

function safeParseArguments(raw: string): { ok: true, value: Record<string, unknown> } | { ok: false, message: string } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: '工具参数必须是一个 JSON 对象' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (cause) {
    return { ok: false, message: `工具参数的 JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

/** 能进模型可见列表的 surface 节点，按顺序取其事件 seq（与 deriveMessages 一一对应）。 */
function surfaceNodeSeqs(log: SessionLog): SessionSeq[] {
  return foldSurface(log.all()).nodes
    .filter(node => messageFromEvent(node.event) !== null)
    .map(node => node.seq)
}

/** 需要裁剪的旧工具结果（对应原版 compaction-tool-result-pruner）。 */
function prunableToolEvents(log: SessionLog): Array<{ seq: SessionSeq, callId: string, name: string, text: string }> {
  const fold = foldSurface(log.all())
  const boundary = Math.max(0, fold.nodes.length - PRUNE_KEEP_RECENT)
  const targets: Array<{ seq: SessionSeq, callId: string, name: string, text: string }> = []
  for (const node of fold.nodes.slice(0, boundary)) {
    if (node.event.type !== 'tool/result') continue
    const data = node.event.data as { callId: string, name: string, text: string, pruned?: boolean }
    if (data.pruned === true) continue
    if (data.text.length <= PRUNE_MAX_CHARS) continue
    targets.push({ seq: node.seq, callId: data.callId, name: data.name, text: data.text })
  }
  return targets
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const {
    log, stream, persona, config, tools, skills, state, approval, ask, approvePlan,
    contextBudget, signal, emit, onStateChange,
  } = options
  const maxSteps = options.maxSteps ?? 8
  const commit = options.commit ?? ((): void => {})

  const isAborted = (): boolean => signal?.aborted === true
  const history = (): ChatMessage[] => deriveMessages(log.all())

  /**
   * 落盘游标：日志里 [0, committed) 是已经写进磁盘的。
   *
   * 用游标而不是"每次手动传事件"是为了收口——压缩、裁剪这些辅助函数会自己往日志里写，
   * 漏掉一次提交就等于"内存里有、磁盘上没有"，而这正是最危险的状态。
   */
  let committed = log.length
  const flush = (): void => {
    if (log.length === committed) return
    const pending = log.all().slice(committed)
    try {
      commit(pending)
    } catch (cause) {
      throw new Error(`事件没能落盘，已中止本轮：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    committed = log.length
  }

  const record = (event: Omit<SessionEvent, 'seq'>): SessionEvent => {
    const appended = log.append(event)
    flush()
    return appended
  }

  const systemTextFor = (): string => composeSystemPrompt({
    persona,
    tools,
    state,
    skills,
    sandboxLabel: options.sandboxLabel,
    now: new Date(),
  })

  /**
   * 请求信封：只在变化时记一条（原版的 initial / resume / change）。
   * 记它的意义是"请求可重建"——以后能回答"当时到底给模型发了什么提示词、挂了哪些工具"。
   */
  let headerLogged = false
  const recordRequestHeader = (system: string): void => {
    const toolNames = tools.map(tool => tool.name)
    const latest = foldRequestHeader(log.all())
    const latestData = latest === null ? null : latest.data as { system: string, tools: string[], model: string }
    const unchanged = latestData !== null
      && latestData.system === system
      && JSON.stringify(latestData.tools) === JSON.stringify(toolNames)
      && latestData.model === config.model
    if (unchanged && headerLogged) return
    record({
      type: 'request/header',
      time: Date.now(),
      data: {
        system,
        tools: toolNames,
        model: config.model,
        reason: !headerLogged && options.initialRequest === true ? 'initial' : headerLogged ? 'change' : 'resume',
      },
    } as Omit<SessionEvent, 'seq'>)
    headerLogged = true
  }

  const turn = log.all().filter(event => event.type === 'turn/start').length + 1
  // 开头这一条也要守住：写盘失败必须走"报错 + 收尾"，不能把异常抛给调用方
  //（抛出去的话，界面连"为什么没动静"都不知道）。
  try {
    record({ type: 'turn/start', time: Date.now(), data: { turn } } as Omit<SessionEvent, 'seq'>)
  } catch (cause) {
    emit({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    emit({ type: 'done', reason: 'error' })
    return
  }

  const finish = (reason: 'completed' | 'step-limit' | 'aborted' | 'error'): void => {
    try {
      record({ type: 'turn/end', time: Date.now(), data: { turn, reason } } as Omit<SessionEvent, 'seq'>)
    } catch {
      // 收尾事件写不进去不能再抛：这一轮已经结束了，抛出去只会盖掉真正的原因。
    }
    emit({ type: 'done', reason })
  }

  /** 把一条消息写成 surface 事件并落盘。 */
  const recordMessage = (message: ChatMessage): SessionEvent => {
    const event = appendMessageEvent(log, message)
    flush()
    return event
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (isAborted()) { finish('aborted'); return }

    try {
      // ── 上下文治理之一：把过大的旧工具结果换成裁剪版（写 replace 事件，不删数据）
      let pruned = 0
      for (const target of prunableToolEvents(log)) {
        appendToolResultPrune(log, {
          targetSeq: target.seq,
          callId: target.callId,
          name: target.name,
          preview: target.text.slice(0, PRUNE_MAX_CHARS),
          originalChars: target.text.length,
        })
        pruned += 1
      }
      if (pruned > 0) {
        flush()
        emit({ type: 'context-rewritten', messages: history() })
      }

      const system = systemTextFor()
      recordRequestHeader(system)
      record({ type: 'step/start', time: Date.now(), data: { turn, step } } as Omit<SessionEvent, 'seq'>)
      // 界面靠这个事件重置"正在流式的那条"；漏掉它，跨步的文本会累积到同一个气泡里。
      emit({ type: 'step-start', step })

      const systemMessage = (): ChatMessage => ({ id: 'sys', role: 'system', text: system, createdAt: Date.now() })
      let messages = history()
      let tokens = estimateContext([systemMessage(), ...messages], tools)
      emit({ type: 'context', tokens, budget: contextBudget })

      // ── 上下文治理之二：超预算就压缩（同样是"遮蔽"，不是删除）
      if (tokens > contextBudget) {
        emit({ type: 'compaction-start', tokens })
        const nodeSeqs = surfaceNodeSeqs(log)
        const cut = findCutIndex(messages, COMPACT_KEEP_RECENT)
        const outcome = cut >= 4
          ? await compactMessages({ stream, config, messages, tools, keepRecent: COMPACT_KEEP_RECENT, signal })
          : { summary: null, replacedCount: 0, tokensAfter: tokens, tokensBefore: tokens, reason: 'skipped' as const }

        if (outcome.summary !== null && cut >= 4) {
          // 遮蔽集必须与摘要覆盖的区间一致：用同一个 cut 算出来，才不会"摘要说的"和"实际遮的"对不上。
          const shadowedSeqs = nodeSeqs.slice(0, cut)
          appendCompaction(log, {
            summary: `【对话摘要】${outcome.summary}`,
            shadowedSeqs,
            replacedCount: shadowedSeqs.length,
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
          })
          flush()
        }

        messages = history()
        tokens = estimateContext([systemMessage(), ...messages], tools)
        emit({
          type: 'compaction-done',
          summary: outcome.summary,
          replacedCount: outcome.replacedCount,
          tokensAfter: tokens,
          reason: outcome.reason,
        })
        emit({ type: 'context', tokens, budget: contextBudget })
        emit({ type: 'context-rewritten', messages })
      }

      // ── 一次模型调用
      const messageId = newId('a')
      const accumulator: ToolCall[] = []
      let text = ''
      let reasoning = ''

      try {
        for await (const chunk of stream({ config, messages: [systemMessage(), ...messages], tools, signal })) {
          if (chunk.type === 'text') {
            text += chunk.text
            emit({ type: 'text-delta', messageId, text: chunk.text })
          } else if (chunk.type === 'reasoning') {
            reasoning += chunk.text
            emit({ type: 'reasoning-delta', messageId, text: chunk.text })
          } else if (chunk.type === 'tool-call') {
            mergeToolCall(accumulator, chunk.index, chunk.id, chunk.name, chunk.argsDelta)
          }
        }
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') {
          if (text !== '' || reasoning !== '') {
            const partial = recordMessage({
              id: messageId, role: 'assistant', text,
              ...(reasoning === '' ? {} : { reasoning }),
              ...(accumulator.length === 0 ? {} : { toolCalls: accumulator }),
              createdAt: Date.now(),
            })
            const derived = messageFromEvent(partial)
            if (derived !== null) emit({ type: 'assistant-done', message: derived })
          }
          finish('aborted')
          return
        }
        const message = cause instanceof Error ? cause.message : String(cause)
        emit({ type: 'error', message })
        record({ type: 'model/error', time: Date.now(), data: { message, scope: 'model' } } as Omit<SessionEvent, 'seq'>)
        finish('error')
        return
      }

      const assistantEvent = recordMessage({
        id: messageId,
        role: 'assistant',
        text,
        ...(reasoning === '' ? {} : { reasoning }),
        ...(accumulator.length === 0 ? {} : { toolCalls: accumulator }),
        createdAt: Date.now(),
      })
      const derivedAssistant = messageFromEvent(assistantEvent)
      if (derivedAssistant !== null) emit({ type: 'assistant-done', message: derivedAssistant })

      if (accumulator.length === 0) { finish('completed'); return }

      // 工具调用**在执行前**就入日志：崩在工具中间时它是"结果未知"，而不是"没发生"。
      for (const call of accumulator) {
        record({
          type: 'tool/call',
          time: Date.now(),
          data: {
            turn,
            step,
            callId: call.id === '' ? newId('call') : call.id,
            name: call.name,
            arguments: call.arguments,
          },
        } as Omit<SessionEvent, 'seq'>)
      }

      const toolContext: ToolContext = {
        ask,
        state,
        approvePlan,
        spawnSubagent: options.spawnSubagent ?? (async (): Promise<SubagentReport> => {
          throw new Error('这个部署没有启用子代理')
        }),
      }

      for (const [index, call] of accumulator.entries()) {
        if (isAborted()) { finish('aborted'); return }
        const callId = call.id === '' ? newId(`call-${index}`) : call.id
        emit({ type: 'tool-call', messageId, name: call.name })

        const parsed = safeParseArguments(call.arguments)
        const tool = tools.find(item => item.name === call.name)
        const blocked = tool === undefined ? null : planModeBlock(tool, state.planMode)
        let result = ''
        let failed = false

        if (!parsed.ok) {
          result = `参数错误：${parsed.message}`
          failed = true
        } else if (tool === undefined) {
          result = `没有名为 ${call.name} 的工具。可用工具：${tools.map(item => item.name).join('、')}`
          failed = true
        } else if (blocked !== null) {
          result = blocked
          failed = true
        } else {
          let allowed = true
          if (needsApproval(tool, approval.mode, state.allowlist)) {
            const request: ApprovalRequest = { toolName: tool.name, risk: tool.risk, detail: parsed.ok ? call.arguments : '' }
            emit({ type: 'approval-request', request })
            const decision = await approval.request(request)
            emit({ type: 'approval-result', request, decision })
            // 审批决定入日志：谁批的、批了什么，必须可审计（原版同样是 log-only 事件）。
            record({
              type: 'approval/decided',
              time: Date.now(),
              data: { callId, toolName: tool.name, decision },
            } as Omit<SessionEvent, 'seq'>)
            if (decision === 'deny') {
              allowed = false
              result = '用户拒绝了这次操作。换个做法，或者先问清楚用户想要什么。'
              failed = true
            } else if (decision === 'always') {
              state.allowlist = [...state.allowlist, tool.name]
              onStateChange?.(state)
            }
          }

          if (allowed) {
            try {
              result = await tool.run(parsed.value, toolContext)
              if (BOOKKEEPING_TOOLS.has(tool.name)) {
                onStateChange?.(state)
                emit({ type: 'state-changed' })
              }
            } catch (cause) {
              result = `执行失败：${cause instanceof Error ? cause.message : String(cause)}`
              failed = true
            }
          }
        }

        if (result.length > MAX_TOOL_RESULT) result = `${result.slice(0, MAX_TOOL_RESULT)}\n…（结果过长已截断）`

        recordMessage({
          id: newId('t'),
          role: 'tool',
          text: result,
          toolCallId: callId,
          toolName: call.name,
          failed,
          createdAt: Date.now(),
        })
        emit({ type: 'tool-result', toolCallId: callId, name: call.name, result, failed })
      }

      record({ type: 'step/end', time: Date.now(), data: { turn, step } } as Omit<SessionEvent, 'seq'>)
    } catch (cause) {
      // record()/flush() 抛出的都是"落盘失败"这类致命问题：中止，不装作没事。
      emit({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      finish('error')
      return
    }
  }

  finish('step-limit')
}

/** 上下文压力的可读读数（界面用；与循环内部同一套估算）。 */
export function describePressure(tokens: number, budget: number): string {
  return `${formatTokens(tokens)}/${formatTokens(budget)}`
}
