/**
 * 子代理：把一件独立的事丢给一个"干净上下文"的自己去做，只把结论带回来。
 *
 * 为什么值得：主上下文是稀缺资源。让子代理去啃一堆工具输出（读十个文件、翻一个页面），
 * 只回一段结论，主循环的上下文就省下来了 —— 这也是桌面 DSH 里 subagent 的核心价值。
 *
 * 与桌面版的差别只有一点：这里没有进程可开，所以子代理就是**同进程内的一次嵌套循环**。
 * 代价是它们不能真并行（JS 单线程，但两次模型调用本来就在等 IO，所以并发是有效的），
 * 好处是共享同一套工具与审批，用户不需要额外信任别的东西。
 *
 * 边界（都是刻意的）：
 * · 子代理不能自己再起子代理（防递归放大）；
 * · 子代理不能直接问用户（问题要带回主循环问）；
 * · 子代理不能用 exit_plan_mode 改计划模式（那是主循环的事）；
 * · 写操作照样走用户的审批 —— 而且审批框上会标明"来自子代理"。
 */
import { runAgent } from './loop'
import type { ApprovalGate, AgentEvent } from './loop'
import { SessionLog } from './sessionLog'
import { appendMessageEvent, deriveMessages } from './surface'
import type { LlmConfig, SessionState, StreamFn, SubagentReport, ToolSpec } from './types'

export type SubagentDeps = {
  stream: StreamFn
  config: LlmConfig
  /** 已经排除 `subagent` 本身的工具面。 */
  tools: ToolSpec[]
  /** 子代理的系统提示词底座（通常是一句"你负责一件事"）。 */
  persona: string
  /** 主会话状态：只用来继承白名单，子代理自己的状态是独立的。 */
  state: SessionState
  approval: ApprovalGate
  signal?: AbortSignal
  contextBudget?: number
  /** 显示用：第几号子代理 */
  label?: string
}

/** 子代理看到的系统提示词：明确它是一次性的、只有一个任务。 */
const SUBAGENT_NOTE = [
  '你是一个子代理：为了省主上下文的开销，被派来专门做一件事。',
  '· 只做这一件事，做完就收，不要扩展任务、不要顺手做别的。',
  '· 你能用的工具和主循环一样，但你没有会话历史 —— 需要什么自己去取。',
  '· 你无法直接向用户提问：真卡住了就把问题写清楚带回去，由主循环问。',
  '· 最终回答要能独立看懂：结论、关键数据、路径，不要"如上所述"。',
].join('\n')

export function createSubagentSpawner(deps: SubagentDeps): (task: string, options?: { maxSteps?: number }) => Promise<SubagentReport> {
  return async (task, options) => {
    const trimmed = task.trim()
    if (trimmed === '') return { ok: false, text: '', steps: 0, toolCalls: 0, error: '子代理任务不能为空' }

    // 子代理有**自己的事件日志**：它的历史不混进主会话，主会话只收到一份报告。
    // （原版也是这样隔离的：子是独立会话，父子之间只走 inbox 传消息。）
    const log = new SessionLog()
    const events: AgentEvent[] = []
    let steps = 0
    let toolCalls = 0

    try {
      appendMessageEvent(log, { id: `sub-${Date.now().toString(36)}`, role: 'user', text: trimmed, createdAt: Date.now() })
      await runAgent({
        log,
        stream: deps.stream,
        persona: `${deps.persona}\n\n${SUBAGENT_NOTE}`,
        config: deps.config,
        tools: deps.tools,
        skills: [],
        // 独立状态：待办与计划模式不污染主会话；白名单只继承一份拷贝。
        state: { todos: [], planMode: false, allowlist: [...deps.state.allowlist] },
        approval: {
          mode: deps.approval.mode,
          request: request => deps.approval.request({
            ...request,
            origin: deps.label ?? '子代理',
          }),
        },
        ask: async () => '（子代理不能直接问用户：把这个问题写进结论带回主循环）',
        approvePlan: async () => false,
        contextBudget: deps.contextBudget ?? 24_000,
        maxSteps: options?.maxSteps ?? 6,
        signal: deps.signal,
        initialRequest: true,
        emit: event => {
          events.push(event)
          if (event.type === 'step-start') steps += 1
          if (event.type === 'tool-call') toolCalls += 1
        },
      })
    } catch (cause) {
      return {
        ok: false,
        text: '',
        steps,
        toolCalls,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    const errorEvent = events.find(event => event.type === 'error')
    // 结论从子代理自己的日志里派生 —— 与主会话用的是同一套机制，不额外维护一份数组。
    const messages = deriveMessages(log.all())
    const final = [...messages].reverse().find(message => message.role === 'assistant' && message.text.trim() !== '')
    const text = final?.text.trim() ?? ''

    if (errorEvent !== undefined && errorEvent.type === 'error') {
      return { ok: false, text, steps, toolCalls, error: errorEvent.message }
    }
    if (text === '') {
      return { ok: false, text: '', steps, toolCalls, error: '子代理没有产出结论' }
    }
    return { ok: true, text, steps, toolCalls }
  }
}
