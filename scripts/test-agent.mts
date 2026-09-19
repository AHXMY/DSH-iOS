/**
 * Agent 核心的离线验证。
 *
 * 手机上跑不了自动化测试，所以把"错了会很难查"的部分全拿到 Node 里验：
 *   · 计算解析器（自己写的，边界必须对）
 *   · agent 循环（流式拼接、工具配对、取消、步数上限、失败路径）
 *   · 审批与计划模式（问错就会写坏用户数据）
 *   · 上下文治理（token 估算、裁剪、压缩，以及"压缩失败也必须能继续"）
 *   · 技能格式与系统提示词拼装（与桌面 DSH 的格式兼容性）
 *
 * 循环、策略、格式、提示词这几层刻意做成不依赖 expo 的纯逻辑，就是为了能这样验。
 *
 *   npm test
 */
import { evaluate } from '../src/agent/calc.ts'
import { compactMessages, findCutIndex } from '../src/agent/compaction.ts'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentEvent } from '../src/agent/loop.ts'
import { needsApproval, planModeBlock } from '../src/agent/policy.ts'
import { SessionLog } from '../src/agent/sessionLog.ts'
import type { SessionEvent } from '../src/agent/sessionLog.ts'
import { appendMessageEvent, deriveMessages, foldRequestHeader, foldSurface } from '../src/agent/surface.ts'
import { parseSkillMarkdown, renderSkillMarkdown, slugifySkillName } from '../src/agent/skillFormat.ts'
import { createSubagentSpawner } from '../src/agent/subagent.ts'
import { parseMcpEntries, formatMcpEntries } from '../src/agent/mcpConfig.ts'
import { classifyMcpRisk, connectMcpServers, describeMcpRegistration } from '../src/agent/mcpTools.ts'
import { parseMcpToolName } from '../src/agent/mcp.ts'
import { MOCK_TOOLS, startMockMcpServer } from './mock-mcp-server.mjs'
import { searchSessions, sessionToMarkdown, exportFileName } from '../src/agent/sessionExport.ts'
import { composeSystemPrompt } from '../src/agent/systemPrompt.ts'
import { buildSearchBody, createDeepSeekSearchProvider, formatSearchResults, parseSearchResponse } from '../src/agent/webSearch.ts'
import { defaultSearchResponse, noSearchResponse, searchErrorResponse, startMockSearchServer } from './mock-search-server.mjs'
import { estimateContext, estimateTokens, pruneToolResults, serializeForSummary } from '../src/agent/tokens.ts'
import type {
  ApprovalDecision, ApprovalMode, ApprovalRequest, AskRequest, ChatMessage, Session, SessionState,
  StreamChunk, StreamFn, SubagentReport, ToolSpec,
} from '../src/agent/types.ts'

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

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// ═══════════════════════════════════════════════════════ 计算工具

section('calc')

const calcCases: [string, number][] = [
  ['1+2*3', 7],
  ['(1+2)*3', 9],
  ['2^10', 1024],
  ['-3+1', -2],
  ['10%3', 1],
  ['sqrt(16)', 4],
  ['max(3,7,5)', 7],
  ['1_000+1', 1001],
  ['round(2.6)', 3],
  ['-2^2', -4],
]

for (const [expression, expected] of calcCases) {
  let actual: number | string
  try {
    actual = evaluate(expression)
  } catch (cause) {
    actual = `抛错：${cause instanceof Error ? cause.message : String(cause)}`
  }
  equal(`calc ${expression} = ${expected}`, actual, expected)
}

for (const bad of ['1/0', 'abc', '1+', '(1+2', '1++', 'sqrt()']) {
  let threw = false
  try {
    evaluate(bad)
  } catch {
    threw = true
  }
  check(`calc 拒绝非法表达式 "${bad}"`, threw)
}

// ═══════════════════════════════════════════════════════ token 估算与裁剪

section('token 估算与裁剪')

check('中文比等长英文更贵', estimateTokens('你好世界') > estimateTokens('abcdefgh'))
equal('空串估 0', estimateTokens(''), 0)
check('工具 schema 计入上下文', estimateContext([], [{
  name: 'x', description: 'y'.repeat(40), parameters: { type: 'object' }, risk: 'read', run: async () => '',
}]) > 10)

const bigToolMessage: ChatMessage = {
  id: 't1', role: 'tool', text: 'x'.repeat(3000), toolCallId: 'c1', toolName: 'fetch_text', createdAt: 1,
}
const filler = (index: number): ChatMessage => ({ id: `m${index}`, role: 'user', text: `第 ${index} 条`, createdAt: index })

const pruned = pruneToolResults(
  [bigToolMessage, ...Array.from({ length: 9 }, (_, index) => filler(index))],
  { keepRecent: 8, maxChars: 600 },
)
equal('旧工具输出被裁剪', pruned.prunedCount, 1)
check('裁剪后原文被缩短', (pruned.messages[0]?.text.length ?? 0) < 3000, `${pruned.messages[0]?.text.length}`)
check('裁剪有标注', pruned.messages[0]?.pruned === true)
check('裁剪省下了 token', pruned.savedTokens > 500, `${pruned.savedTokens}`)
equal('近处的大输出不动它', pruneToolResults(
  [...Array.from({ length: 3 }, (_, index) => filler(index)), bigToolMessage],
  { keepRecent: 8, maxChars: 600 },
).prunedCount, 0)

// ═══════════════════════════════════════════════════════ 技能格式

section('技能格式（与 DSH 兼容）')

const withFrontmatter = parseSkillMarkdown([
  '---',
  'name: weekly-report',
  'description: 把零散记录整理成周报',
  '---',
  '',
  '# 步骤',
  '1. 读记录',
].join('\n'), 'fallback')
equal('frontmatter 名字', withFrontmatter.name, 'weekly-report')
equal('frontmatter 说明', withFrontmatter.description, '把零散记录整理成周报')
check('正文不含 frontmatter', !withFrontmatter.body.includes('description:'))
equal('默认两项都开', [withFrontmatter.modelInvocable, withFrontmatter.userInvocable], [true, true])
equal('user-invocable: false 生效',
  parseSkillMarkdown('---\nname: hidden\ndescription: x\nuser-invocable: false\n---\n正文', 'x').userInvocable, false)
equal('disable-model-invocation: true 生效',
  parseSkillMarkdown('---\nname: manual\ndescription: y\ndisable-model-invocation: true\n---\n正文', 'y').modelInvocable, false)

const headingOnly = parseSkillMarkdown('# 会议纪要整理\n\n先看这段。', '')
check('没有 frontmatter 也能成技能（名字兜底为合法 slug）', KEBAB.test(headingOnly.name), headingOnly.name)
check('说明取正文首个非空行', headingOnly.description.includes('先看这段'), headingOnly.description)
check('中文名兜底为合法 slug', KEBAB.test(slugifySkillName('会议 纪要')), slugifySkillName('会议 纪要'))
equal('规范名原样保留', slugifySkillName('Weekly-Report'), 'weekly-report')

const roundTrip = parseSkillMarkdown(renderSkillMarkdown({ ...withFrontmatter, modelInvocable: false }), 'x')
equal('渲染再解析，名字不丢', roundTrip.name, 'weekly-report')
equal('渲染再解析，开关不丢', roundTrip.modelInvocable, false)

// ═══════════════════════════════════════════════════════ 审批与计划模式策略

section('审批与计划模式策略')

const readTool: ToolSpec = { name: 'read_thing', description: '读', parameters: { type: 'object', properties: {} }, risk: 'read', run: async () => 'read-ok' }
const writeTool: ToolSpec = { name: 'write_thing', description: '写', parameters: { type: 'object', properties: {} }, risk: 'write', run: async () => 'write-ok' }
const dangerTool: ToolSpec = { name: 'danger_thing', description: '删', parameters: { type: 'object', properties: {} }, risk: 'danger', run: async () => 'danger-ok' }
const todoTool: ToolSpec = {
  name: 'todo_write',
  description: '待办',
  parameters: { type: 'object', properties: {} },
  risk: 'write',
  run: async (_args, context) => {
    context.state.todos = [{ id: 'todo-1', text: '第一步', status: 'in_progress' }]
    return 'todos updated'
  },
}
const askTool: ToolSpec = {
  name: 'ask_user',
  description: '问',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async (args, context) => `用户回答：${await context.ask({ question: String(args.question ?? '') })}`,
}
const exitPlanTool: ToolSpec = {
  name: 'exit_plan_mode',
  description: '交计划',
  parameters: { type: 'object', properties: {} },
  risk: 'write',
  run: async (args, context) => {
    const approved = await context.approvePlan(String(args.plan ?? ''))
    context.state.plan = String(args.plan ?? '')
    if (approved) context.state.planMode = false
    return approved ? 'approved' : 'rejected'
  },
}

check('write 模式：只读不打扰', needsApproval(readTool, 'write', []) === false)
check('write 模式：写操作要问', needsApproval(writeTool, 'write', []) === true)
check('write 模式：不可逆要问', needsApproval(dangerTool, 'write', []) === true)
check('auto 模式：全放行', needsApproval(writeTool, 'auto', []) === false)
check('all 模式：连只读也问', needsApproval(readTool, 'all', []) === true)
check('白名单内的工具不再问', needsApproval(writeTool, 'write', ['write_thing']) === false)
check('会话簿记工具永不打扰', needsApproval(todoTool, 'all', []) === false)

check('计划模式不挡只读', planModeBlock(readTool, true) === null)
check('计划模式挡住写操作', planModeBlock(writeTool, true) !== null)
check('计划模式放行 exit_plan_mode', planModeBlock(exitPlanTool, true) === null)
check('非计划模式不挡', planModeBlock(writeTool, false) === null)

// ═══════════════════════════════════════════════════════ 系统提示词

section('系统提示词拼装')

const composed = composeSystemPrompt({
  persona: '你是一个测试助手。',
  tools: [readTool, writeTool],
  skills: [{ name: 'web-read', description: '读链接' }],
  state: {
    todos: [{ id: 'todo-1', text: '写验证', status: 'in_progress' }],
    planMode: true,
    allowlist: ['write_thing'],
  },
  now: new Date('2026-09-19T12:00:00+08:00'),
})

check('带上了人设', composed.includes('你是一个测试助手。'))
check('带上了运行环境事实', composed.includes('## 运行环境') && composed.includes('iPhone'))
check('说明了没有 shell 且不许假装有', composed.includes('shell') && composed.includes('不要假装有'))
check('列出了工具及其影响面', composed.includes('read_thing（只读）') && composed.includes('write_thing（会改动数据）'))
check('列出了技能目录', composed.includes('web-read：读链接'))
check('带上了待办进度', composed.includes('写验证'))
check('计划模式有专门段落', composed.includes('计划模式（已开启）'))
check('提到已获准的操作', composed.includes('write_thing'))
check('没有待办时给出提示',
  composeSystemPrompt({ persona: 'p', tools: [], skills: [], state: { todos: [], planMode: false, allowlist: [] } })
    .includes('超过两步的任务先写下来'))

// ═══════════════════════════════════════════════════════ 压缩

section('上下文压缩')

const toolPair: ChatMessage[] = [
  { id: 'a1', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }], createdAt: 1 },
  { id: 't1', role: 'tool', text: 'result', toolCallId: 'c1', toolName: 'x', createdAt: 2 },
  { id: 'u2', role: 'user', text: '继续', createdAt: 3 },
]
equal('切点不会切开工具结果', findCutIndex(toolPair, 2), 0)
equal('切点正常时按窗口走', findCutIndex(Array.from({ length: 20 }, (_, index) => filler(index)), 8), 12)

const longHistory: ChatMessage[] = [
  ...Array.from({ length: 10 }, (_, index) => ({ id: `h${index}`, role: 'user' as const, text: `历史 ${index}`, createdAt: index })),
  ...Array.from({ length: 3 }, (_, index) => ({ id: `k${index}`, role: 'user' as const, text: `近处 ${index}`, createdAt: 100 + index })),
]

const config = { apiKey: 'test', baseUrl: 'http://localhost', model: 'test-model', temperature: 0 }

const summaryStream: StreamFn = async function* () {
  yield { type: 'text', text: '用户想整理笔记；已确认日期；未完成：写入文件。' }
}

const compacted = await compactMessages({ stream: summaryStream, config, messages: longHistory, tools: [] })
equal('压缩方式是摘要', compacted.reason, 'summarized')
check('摘要消息排在前面且带标记', compacted.messages[0]?.summary === true)
check('摘要正文进了消息', (compacted.messages[0]?.text ?? '').includes('未完成'))
equal('替换条数正确', compacted.replacedCount, longHistory.length - compacted.messages.length + 1)
check('压缩后 token 下降', compacted.tokensAfter < compacted.tokensBefore, `${compacted.tokensBefore} → ${compacted.tokensAfter}`)
check('最近的消息原样保留', compacted.messages.some(message => message.text === '近处 2'))

const failingStream: StreamFn = async function* () { throw new Error('摘要服务挂了') }
const fallback = await compactMessages({ stream: failingStream, config, messages: longHistory, tools: [] })
equal('压缩失败退化为裁剪', fallback.reason, 'pruned')
check('压缩失败不抛异常（这一轮还能继续）', fallback.messages.length > 0)
check('兜底不会让上下文变大（说明本身也占 token）', fallback.tokensAfter <= fallback.tokensBefore, `${fallback.tokensBefore} → ${fallback.tokensAfter}`)
check('兜底真的缩小了条数', fallback.messages.length < longHistory.length, `${longHistory.length} → ${fallback.messages.length}`)

const fatHistory: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
  id: `f${index}`, role: 'user' as const,
  text: `第 ${index} 段旧内容：${'这是一段足够长的历史，用来把上下文顶起来。'.repeat(6)}`,
  createdAt: index,
}))
const fatFallback = await compactMessages({ stream: failingStream, config, messages: fatHistory, tools: [] })
check('真实长历史下兜底确实压缩', fatFallback.tokensAfter < fatFallback.tokensBefore, `${fatFallback.tokensBefore} → ${fatFallback.tokensAfter}`)
check('裁掉的是旧消息、留的是新消息', (fatFallback.messages.at(-1)?.text ?? '').includes('第 19 段'))

const tooShort = await compactMessages({ stream: summaryStream, config, messages: longHistory.slice(0, 3), tools: [] })
equal('历史太短就不浪费调用', tooShort.reason, 'skipped')
equal('跳过后原样返回', tooShort.messages.length, 3)

check('摘要输入会截断超长工具输出', serializeForSummary([bigToolMessage]).length < 2000, `${serializeForSummary([bigToolMessage]).length}`)

// ═══════════════════════════════════════════════════════ 循环

section('agent 循环')

function scriptedStream(turns: StreamChunk[][], seen: ChatMessage[][] = []): StreamFn {
  let index = 0
  return async function* stream(request) {
    seen.push(request.messages.map(message => ({ ...message })))
    const turn = turns[index]
    index += 1
    if (turn === undefined) throw new Error('假流没有更多脚本了（说明循环多跑了一轮）')
    for (const chunk of turn) {
      if (request.signal?.aborted === true) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      yield chunk
    }
  }
}

const toolCall = (name: string, args = '{}', id = 'call_1'): StreamChunk[] => [
  { type: 'tool-call', index: 0, id, name, argsDelta: args },
]

type RunResult = {
  /** 从事件日志**派生**出来的消息（不是另存的一份） */
  persisted: ChatMessage[]
  events: AgentEvent[]
  state: SessionState
  approvals: ApprovalRequest[]
  asks: AskRequest[]
  stateChanges: number
  /** 事件日志：唯一真相，测试直接检查它 */
  log: SessionLog
  /** 真正提交落盘的事件（应当与日志内容一致） */
  committed: SessionEvent[]
}

type RunInput = {
  stream: StreamFn
  history?: ChatMessage[]
  tools?: ToolSpec[]
  state?: Partial<SessionState>
  approvalMode?: ApprovalMode
  decide?: (request: ApprovalRequest) => ApprovalDecision
  answer?: string
  approvePlan?: boolean
  contextBudget?: number
  maxSteps?: number
  signal?: AbortSignal
  spawnSubagent?: (task: string, options?: { maxSteps?: number }) => Promise<SubagentReport>
  /** 注入"磁盘写不进去"，验证 fail-closed */
  commitFails?: boolean
  initialRequest?: boolean
}

async function run(input: RunInput): Promise<RunResult> {
  const events: AgentEvent[] = []
  const approvals: ApprovalRequest[] = []
  const asks: AskRequest[] = []
  const state: SessionState = { todos: [], planMode: false, allowlist: [], ...input.state }
  const committed: SessionEvent[] = []
  let stateChanges = 0

  // 测试台也走事件日志：会话历史是"派生物"，与真实运行时同一套机制。
  const log = new SessionLog()
  const seed = input.history ?? [{ id: 'u1', role: 'user' as const, text: '帮我干活', createdAt: 1 }]
  for (const message of seed) appendMessageEvent(log, message)

  const commit = (pending: SessionEvent[]): void => {
    committed.push(...pending)
    if (input.commitFails === true) throw new Error('磁盘写不进去（测试注入）')
  }

  await runAgent({
    log,
    commit,
    stream: input.stream,
    persona: '你是测试助手',
    config,
    tools: input.tools ?? [],
    skills: [],
    state,
    approval: {
      mode: input.approvalMode ?? 'auto',
      request: async request => {
        approvals.push(request)
        return input.decide?.(request) ?? 'allow'
      },
    },
    ask: async request => {
      asks.push(request)
      return input.answer ?? '用户说了 A'
    },
    approvePlan: async () => input.approvePlan ?? true,
    spawnSubagent: input.spawnSubagent,
    contextBudget: input.contextBudget ?? 24_000,
    maxSteps: input.maxSteps ?? 8,
    signal: input.signal,
    initialRequest: input.initialRequest ?? true,
    emit: event => events.push(event),
    onStateChange: () => { stateChanges += 1 },
  })

  return { persisted: deriveMessages(log.all()), events, state, approvals, asks, stateChanges, log, committed }
}

function toolsIn(result: RunResult): ChatMessage[] {
  return result.persisted.filter(message => message.role === 'tool')
}
function doneReasons(result: RunResult): string[] {
  return result.events.flatMap(event => (event.type === 'done' ? [event.reason] : []))
}

// —— 多步 + 工具分片
const splitTurn: StreamChunk[] = [
  { type: 'reasoning', text: '先想' },
  { type: 'reasoning', text: '一下' },
  { type: 'text', text: '算一下：' },
  { type: 'tool-call', index: 0, id: 'call_1', name: 'cal' },
  { type: 'tool-call', index: 0, name: 'c' },
  { type: 'tool-call', index: 0, argsDelta: '{"express' },
  { type: 'tool-call', index: 0, argsDelta: 'ion":"2+2"}' },
]

const calcTool: ToolSpec = {
  name: 'calc',
  description: '算数',
  parameters: { type: 'object', properties: { expression: { type: 'string' } } },
  risk: 'read',
  run: async args => `result=${evaluate(String(args.expression))}`,
}

const seen: ChatMessage[][] = []
const multi = await run({
  stream: scriptedStream([splitTurn, [{ type: 'text', text: '等于 4。' }]], seen),
  tools: [calcTool],
})

const firstAssistant = multi.persisted.find(message => message.role === 'assistant')
equal('分片拼出的工具名', firstAssistant?.toolCalls?.[0]?.name, 'calc')
equal('分片拼出的工具参数', firstAssistant?.toolCalls?.[0]?.arguments, '{"expression":"2+2"}')
equal('思考内容逐块累加', firstAssistant?.reasoning, '先想一下')
equal('工具结果按 id 配对', toolsIn(multi)[0]?.toolCallId, 'call_1')
equal('工具真被调用了', toolsIn(multi)[0]?.text, 'result=4')
equal('第二轮收尾', multi.persisted.filter(message => message.role === 'assistant').slice(-1)[0]?.text, '等于 4。')
equal('system 排在最前', seen[1]?.[0]?.role, 'system')
check('第二步把工具结果带回了上下文', (seen[1] ?? []).some(message => message.role === 'tool' && message.toolCallId === 'call_1'))
check('系统提示词含环境事实', (seen[0]?.[0]?.text ?? '').includes('## 运行环境'))
equal('整轮以 completed 结束', doneReasons(multi), ['completed'])

// —— 审批
const denied = await run({
  stream: scriptedStream([toolCall('write_thing'), [{ type: 'text', text: '那我换个方式' }]]),
  tools: [writeTool],
  approvalMode: 'write',
  decide: () => 'deny',
})
equal('审批被请求了一次', denied.approvals.length, 1)
equal('审批请求带上了工具名', denied.approvals[0]?.toolName, 'write_thing')
equal('审批请求带上了影响面', denied.approvals[0]?.risk, 'write')
check('拒绝后工具没执行', (toolsIn(denied)[0]?.text ?? '').includes('用户拒绝'))
equal('拒绝标记为失败', toolsIn(denied)[0]?.failed, true)
check('拒绝后循环继续（还能收尾）', denied.persisted.some(message => message.role === 'assistant' && message.text === '那我换个方式'))

const allowed = await run({
  stream: scriptedStream([toolCall('write_thing'), [{ type: 'text', text: '写好了' }]]),
  tools: [writeTool],
  approvalMode: 'write',
  decide: () => 'allow',
})
equal('允许后工具执行了', toolsIn(allowed)[0]?.text, 'write-ok')

const alwaysRun = await run({
  stream: scriptedStream([
    toolCall('write_thing', '{}', 'c1'),
    toolCall('write_thing', '{}', 'c2'),
    [{ type: 'text', text: '两次都写了' }],
  ]),
  tools: [writeTool],
  approvalMode: 'write',
  decide: () => 'always',
})
equal('"总是允许"只问一次', alwaysRun.approvals.length, 1)
check('"总是允许"记进了白名单', alwaysRun.state.allowlist.includes('write_thing'))
equal('两次都执行了', toolsIn(alwaysRun).filter(message => message.text === 'write-ok').length, 2)

const readNoAsk = await run({
  stream: scriptedStream([toolCall('read_thing'), [{ type: 'text', text: 'ok' }]]),
  tools: [readTool],
  approvalMode: 'write',
})
equal('只读工具不问', readNoAsk.approvals.length, 0)

// —— 计划模式
const blocked = await run({
  stream: scriptedStream([toolCall('write_thing'), [{ type: 'text', text: '先改计划' }]]),
  tools: [writeTool, exitPlanTool],
  state: { planMode: true },
  approvalMode: 'write',
})
check('计划模式挡住写操作', (toolsIn(blocked)[0]?.text ?? '').includes('计划模式'))
equal('挡住时标为失败', toolsIn(blocked)[0]?.failed, true)
equal('挡住时连审批都不问', blocked.approvals.length, 0)

const planApproved = await run({
  stream: scriptedStream([toolCall('exit_plan_mode', '{"plan":"先读再写"}'), [{ type: 'text', text: '开始执行' }]]),
  tools: [writeTool, exitPlanTool],
  state: { planMode: true },
  approvePlan: true,
})
equal('计划获批后解除计划模式', planApproved.state.planMode, false)
equal('计划被记了下来', planApproved.state.plan, '先读再写')

const writeWhilePlan = await run({
  stream: scriptedStream([toolCall('write_thing'), [{ type: 'text', text: 'done' }]]),
  tools: [writeTool],
  state: { planMode: true },
  approvalMode: 'auto',
})
check('计划模式下写操作始终被挡（连 auto 也不放）', (toolsIn(writeWhilePlan)[0]?.text ?? '').includes('计划模式'))

// —— 待办与提问
const todoRun = await run({ stream: scriptedStream([toolCall('todo_write'), [{ type: 'text', text: '记下了' }]]), tools: [todoTool] })
equal('待办写进了会话状态', todoRun.state.todos.length, 1)
check('状态变化有通知', todoRun.stateChanges >= 1, `${todoRun.stateChanges}`)
check('发出了 state-changed 事件', todoRun.events.some(event => event.type === 'state-changed'))
equal('待办工具不打扰用户', todoRun.approvals.length, 0)

const askRun = await run({
  stream: scriptedStream([toolCall('ask_user', '{"question":"要哪个？"}'), [{ type: 'text', text: '好的' }]]),
  tools: [askTool],
  answer: '要第二个',
})
equal('问题被送到界面', askRun.asks[0]?.question, '要哪个？')
check('回答进了工具结果', (toolsIn(askRun)[0]?.text ?? '').includes('要第二个'))

// —— 失败路径
const unknownTool = await run({ stream: scriptedStream([toolCall('nosuch')]), tools: [readTool] })
check('未知工具给出可用清单', (toolsIn(unknownTool)[0]?.text ?? '').includes('没有名为'))

const badArgs = await run({ stream: scriptedStream([toolCall('calc', '{oops')]), tools: [calcTool] })
check('参数 JSON 坏掉时把错误交回模型', (toolsIn(badArgs)[0]?.text ?? '').includes('参数错误'))

const throwing: ToolSpec = { ...readTool, name: 'boom', run: async () => { throw new Error('故意炸给你看') } }
const thrown = await run({ stream: scriptedStream([toolCall('boom')]), tools: [throwing] })
check('工具抛错不会打死循环', (toolsIn(thrown)[0]?.text ?? '').includes('故意炸给你看'))
equal('工具抛错标记为失败', toolsIn(thrown)[0]?.failed, true)

const apiError = await run({ stream: async function* () { throw new Error('API Key 不对（401）。') } })
check('模型报错会送到界面', apiError.events.some(event => event.type === 'error' && event.message.includes('401')))
equal('报错时不留下半条助手消息', apiError.persisted.filter(message => message.role === 'assistant').length, 0)

// —— 取消
const controller = new AbortController()
const abortStream: StreamFn = async function* (request) {
  yield { type: 'reasoning', text: '想' }
  yield { type: 'text', text: '半句' }
  controller.abort()
  if (request.signal?.aborted === true) {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  yield { type: 'text', text: '不该出现' }
}
const aborted = await run({ stream: abortStream, signal: controller.signal })
equal('取消后以 aborted 结束', doneReasons(aborted), ['aborted'])
equal('取消时保留已生成的部分', aborted.persisted.find(message => message.role === 'assistant')?.text, '半句')

// —— 步数上限
const alwaysTool: StreamChunk[] = toolCall('calc', '{"expression":"1+1"}')
const limited = await run({
  stream: scriptedStream([alwaysTool, alwaysTool, alwaysTool, alwaysTool]),
  tools: [calcTool],
  maxSteps: 2,
})
equal('步数用尽时明确收尾', doneReasons(limited), ['step-limit'])
equal('只跑了 2 步', limited.persisted.filter(message => message.role === 'assistant').length, 2)

// —— 循环内触发的压缩（真·长会话不炸）
const longHistoryInLoop: ChatMessage[] = [
  ...Array.from({ length: 14 }, (_, index) => ({
    id: `h${index}`, role: 'user' as const, text: `历史消息 ${index}：这是一段占地方的旧内容。`, createdAt: index,
  })),
]
const compactionRun = await run({
  stream: scriptedStream([[{ type: 'text', text: '这是摘要正文' }], [{ type: 'text', text: '好的，继续。' }]]),
  history: longHistoryInLoop,
  contextBudget: 200,
})
const rewrites = compactionRun.events.filter(event => event.type === 'context-rewritten')
check('超预算时触发了压缩', compactionRun.events.some(event => event.type === 'compaction-start'))
check('压缩完成事件带上了结果', compactionRun.events.some(event => event.type === 'compaction-done' && event.reason === 'summarized'))
check('改写后的上下文告知了界面（否则刷新又涨回去）', rewrites.length >= 1, `${rewrites.length}`)
check('改写后的历史首条是摘要',
  rewrites[0]?.type === 'context-rewritten' && rewrites[0].messages[0]?.summary === true)
check('压缩后仍然正常收尾', doneReasons(compactionRun).includes('completed'))
check('上下文读数有上报', compactionRun.events.some(event => event.type === 'context'))

// ═══════════════════════════════════════════════════════ 子代理

section('子代理')

const subTurns: StreamChunk[][] = [
  [{ type: 'tool-call', index: 0, id: 's1', name: 'read_thing', argsDelta: '{}' }],
  [{ type: 'text', text: '子代理结论：读到了 read-ok，事情办完。' }],
]
const subagentSpawner = createSubagentSpawner({
  stream: scriptedStream(subTurns.map(turn => [...turn])),
  config,
  tools: [readTool],            // 注意：不给它 subagent 自己
  persona: '你负责一件事',
  state: { todos: [], planMode: false, allowlist: [] },
  approval: { mode: 'auto', request: async () => 'allow' },
  label: '子代理',
})

const subTool: ToolSpec = {
  name: 'subagent',
  description: '派活',
  parameters: { type: 'object', properties: { task: { type: 'string' } } },
  risk: 'write',
  run: async (args, context) => {
    const report = await context.spawnSubagent(String(args.task ?? ''))
    return report.ok ? `子代理结论：${report.text}` : `子代理没能完成：${report.error ?? ''}`
  },
}

const subRun = await run({
  stream: scriptedStream([
    toolCall('subagent', '{"task":"读一下然后告诉我"}'),
    [{ type: 'text', text: '它说办完了。' }],
  ]),
  tools: [readTool, subTool],
  spawnSubagent: task => subagentSpawner(task),
})

check('子代理的结论回到了主循环', (toolsIn(subRun)[0]?.text ?? '').includes('子代理结论：读到了 read-ok'))
check('主会话只留工具结果，不留子代理的中间消息',
  subRun.persisted.every(message => message.role !== 'assistant' || !message.text.includes('读到了 read-ok') || message.text.includes('它说办完了')))
equal('主循环照常收尾', doneReasons(subRun), ['completed'])

// 子代理自己不能递归再起子代理：它的工具面里就没有 subagent
const recursive = await subagentSpawner('试着再派一个子代理')
check('子代理不能递归派活（工具面里没有 subagent）', recursive.ok === false || recursive.toolCalls === 0, JSON.stringify(recursive))

const failingSpawner = createSubagentSpawner({
  stream: async function* () { throw new Error('子代理的模型调用挂了') },
  config,
  tools: [readTool],
  persona: 'p',
  state: { todos: [], planMode: false, allowlist: [] },
  approval: { mode: 'auto', request: async () => 'allow' },
})
const failedSpawn = await failingSpawner('这活干不了')
equal('子代理失败会如实上报', failedSpawn.ok, false)
check('失败原因带回来了', (failedSpawn.error ?? '').includes('挂了'), failedSpawn.error ?? '')

const detailed = await createSubagentSpawner({
  stream: scriptedStream([[{ type: 'text', text: '只回一句话：办好了。' }]]),
  config,
  tools: [readTool],
  persona: 'p',
  state: { todos: [], planMode: false, allowlist: [] },
  approval: { mode: 'auto', request: async () => 'allow' },
})('只回一句话')
equal('子代理报告为成功', detailed.ok, true)
equal('子代理报告带步数', detailed.steps, 1)
equal('子代理报告带工具次数', detailed.toolCalls, 0)
check('子代理的结论就是它最后那段话', detailed.text.includes('办好了'), detailed.text)

// 子代理的写操作照样走用户的审批，并且标明来源
const approvalTrail: ApprovalRequest[] = []
const subWithWrite = createSubagentSpawner({
  stream: scriptedStream([[{ type: 'tool-call', index: 0, id: 'w1', name: 'write_thing', argsDelta: '{}' }], [{ type: 'text', text: '写完了' }]]),
  config,
  tools: [writeTool],
  persona: 'p',
  state: { todos: [], planMode: false, allowlist: [] },
  approval: {
    mode: 'write',
    request: async request => {
      approvalTrail.push(request)
      return 'allow'
    },
  },
  label: '子代理',
})
await subWithWrite('写个文件')
equal('子代理的写操作也要审批', approvalTrail.length, 1)
equal('审批框上标明了来源', approvalTrail[0]?.origin, '子代理')

// ═══════════════════════════════════════════════════════ MCP 配置解析

section('MCP 配置解析')

const parsed = parseMcpEntries([
  '# 注释行会被忽略',
  'fs https://mcp.example.com/mcp sk-abc',
  '',
  'docs http://127.0.0.1:3000/mcp',
].join('\n'))
equal('解析出两台服务器', parsed.length, 2)
equal('带 token 的那台', parsed[0], { name: 'fs', url: 'https://mcp.example.com/mcp', token: 'sk-abc' })
equal('不带 token 的那台', parsed[1], { name: 'docs', url: 'http://127.0.0.1:3000/mcp' })

function parseThrows(text: string): boolean {
  try {
    parseMcpEntries(text)
    return false
  } catch {
    return true
  }
}
check('缺 url 会报错', parseThrows('fs'))
check('名字不是 kebab-case 会报错', parseThrows('My Server https://x.com/mcp'))
check('url 不是 http(s) 会报错', parseThrows('fs ftp://x.com/mcp'))
check('重名会报错', parseThrows('fs https://a.com/mcp\nfs https://b.com/mcp'))
equal('格式化回文本可以再解析', parseMcpEntries(formatMcpEntries(parsed)), parsed)

// ═══════════════════════════════════════════════════════ 会话检索与导出

section('会话检索与导出')

const searchable: Session[] = [
  {
    id: 's1', title: '整理周报', createdAt: 1, updatedAt: 300, model: 'm', systemPrompt: 'p',
    todos: [], planMode: false, allowlist: [],
    messages: [
      { id: 'm1', role: 'user', text: '把这几天的记录整理成周报', createdAt: 10 },
      { id: 'm2', role: 'assistant', text: '已经写到 notes/周报.md 里了。', reasoning: '先看看现有记录在哪', createdAt: 20 },
      { id: 'm3', role: 'tool', text: '已写入 notes/周报.md（1.2 KB）', toolCallId: 'c1', toolName: 'write_file', createdAt: 21 },
      { id: 'm4', role: 'assistant', text: '', toolCalls: [{ id: 'c2', name: 'get_time', arguments: '{"x":1}' }], createdAt: 22 },
    ],
  },
  {
    id: 's2', title: '读文档', createdAt: 2, updatedAt: 900, model: 'm', systemPrompt: 'p',
    todos: [], planMode: false, allowlist: [],
    messages: [{ id: 'n1', role: 'user', text: '读一下这篇 ANTHROPIC 的说明', createdAt: 30 }],
  },
]

equal('空查询不返回结果', searchSessions(searchable, '   ').length, 0)

const weekHits = searchSessions(searchable, '周报')
check('中文子串能命中', weekHits.length >= 3, `${weekHits.length}`)
equal('标题命中排最前', weekHits[0]?.role, 'title')
equal('标题命中的会话正确', weekHits[0]?.sessionId, 's1')
check('命中工具结果', weekHits.some(hit => hit.role === 'tool'))
check('命中工具调用的参数', searchSessions(searchable, 'get_time').length >= 1)
check('片段带上下文', weekHits.some(hit => hit.snippet.includes('周报')), JSON.stringify(weekHits.map(hit => hit.snippet)))
check('大小写不敏感', searchSessions(searchable, 'anthropic').length === 1)
check('搜不到就是空', searchSessions(searchable, '这个词不存在').length === 0)
check('结果条数受限', searchSessions(searchable, '报', 1).length === 1)

const markdown = sessionToMarkdown(searchable[0] as Session)
check('导出带标题', markdown.startsWith('# 整理周报'))
check('导出带元信息', markdown.includes('模型：m') && markdown.includes('消息：4 条'))
check('导出保留工具结果', markdown.includes('工具结果 · write_file') && markdown.includes('已写入 notes/周报.md'))
check('导出保留工具调用参数', markdown.includes('调用工具 `get_time`') && markdown.includes('{"x":1}'))
check('导出把思考过程折叠起来', markdown.includes('<details><summary>思考过程</summary>'))
check('导出是合法 Markdown 结构', markdown.includes('### 用户 ·') && markdown.includes('---'))

const summarySession: Session = {
  ...(searchable[0] as Session),
  messages: [{ id: 'x1', role: 'user', summary: true, text: '【对话摘要】用户想写周报。', createdAt: 1 }],
}
check('导出标明这是压缩摘要', sessionToMarkdown(summarySession).includes('【历史摘要】'))

check('文件名不含路径分隔符', !/[\\/:*?"<>|]/.test(exportFileName(searchable[0] as Session)))
check('文件名带日期', /\d{8}\.md$/.test(exportFileName(searchable[0] as Session)), exportFileName(searchable[0] as Session))
check('空标题有兜底', exportFileName({ ...(searchable[0] as Session), title: '///' }).startsWith('session-'))

// ═══════════════════════════════════════════════════════ MCP 接入（对上 mock 服务器）

section('MCP 接入')

equal('只读动词判为 read', classifyMcpRisk('read_file'), 'read')
equal('list 判为 read', classifyMcpRisk('list_workspaces'), 'read')
equal('camelCase 也认得出来', classifyMcpRisk('getUserInfo'), 'read')
equal('写动词判为 write', classifyMcpRisk('create_issue'), 'write')
equal('删除判为 danger', classifyMcpRisk('delete_file'), 'danger')
equal('读+删不算只读', classifyMcpRisk('read_and_delete'), 'danger')
equal('看不出来的按最保守的算', classifyMcpRisk('foo_bar'), 'write')

const mockServer = await startMockMcpServer()
const registration = await connectMcpServers(`fs ${mockServer.url}`)

equal('MCP 服务器连上了', registration.connected.length, 1, JSON.stringify(registration.failures))
equal('连不上的服务器不阻断别人', registration.failures.length, 0)
equal('工具全注册进来了', registration.tools.length, MOCK_TOOLS.length)
check('工具名按 DSH 约定加前缀', registration.tools.every(tool => tool.name.startsWith('mcp__fs__')), JSON.stringify(registration.tools.map(tool => tool.name)))
check('说明里标明了来源', (registration.tools[0]?.description ?? '').startsWith('[MCP fs]'), registration.tools[0]?.description ?? '')
check('工具名能反解回服务器与原名', parseMcpToolName(registration.tools[0]?.name ?? '')?.server === 'fs')

const dummyContext = {
  ask: async () => '',
  state: { todos: [], planMode: false, allowlist: [] },
  approvePlan: async () => false,
  spawnSubagent: async () => ({ ok: false, text: '', steps: 0, toolCalls: 0 }),
}

const echoTool = registration.tools.find(tool => tool.name === 'mcp__fs__echo')
check('echo 工具在清单里', echoTool !== undefined)
// `echo` 不是我们认识的只读动词，于是按最保守的算成 write —— 多问用户一次，
// 总好过把"其实会写"的工具当成只读放过去。
equal('没见过的动词按保守算（write）', echoTool?.risk, 'write')
check('认识的名字会被判成只读', classifyMcpRisk('read_note') === 'read' && classifyMcpRisk('search_docs') === 'read')
const echoResult = await echoTool?.run({ text: '来自手机' }, dummyContext) ?? ''
check('真的调通了 MCP 工具', echoResult.includes('来自手机'), echoResult)

const boomTool = registration.tools.find(tool => tool.name === 'mcp__fs__boom')
let boomMessage = ''
try {
  await boomTool?.run({ reason: '演示失败' }, dummyContext)
} catch (cause) {
  boomMessage = cause instanceof Error ? cause.message : String(cause)
}
check('MCP 报错会变成工具失败（界面标红、模型能看到）', boomMessage.includes('演示失败'), boomMessage)

const badConfig = await connectMcpServers('写错了行')
equal('配置写错时如实报告', badConfig.failures[0]?.name, '配置')

const unreachable = await connectMcpServers('dead http://127.0.0.1:1/mcp')
equal('连不上的服务器记在 failures 里', unreachable.failures.length, 1)
equal('连不上时不注册任何工具', unreachable.tools.length, 0)
check('摘要能说清状态', describeMcpRegistration(registration).includes('已连上：fs'), describeMcpRegistration(registration))

registration.close()
await mockServer.close()
check('MCP 连接能干净关掉', true)

// ═══════════════════════════════════════════════════════ 联网搜索（对上 mock 端点）

section('联网搜索')

const parsedSearch = parseSearchResponse(defaultSearchResponse())
equal('按 url 去重后剩三条', parsedSearch.length, 3)
equal('第一条标题', parsedSearch[0]?.title, '第一篇')
equal('片段来自 citations 而不是猜的', parsedSearch[0]?.snippet, '第一段的引用内容')
equal('重复 citation 不覆盖第一次', parsedSearch[0]?.snippet === '不该覆盖前面那条' ? '覆盖了' : 'ok', 'ok')
equal('page_age 透传成页面时间', parsedSearch[0]?.publishedAt, '2026-09-01')
equal('没有片段的条目就不带 snippet', parsedSearch[1]?.snippet, undefined)

function searchThrows(payload: unknown): string {
  try {
    parseSearchResponse(payload)
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}
check('没触发搜索时报错而不是返回空', searchThrows(noSearchResponse()).includes('没有触发联网搜索'), searchThrows(noSearchResponse()))
check('服务端说搜索失败时如实报错', searchThrows(searchErrorResponse()).includes('搜索服务暂时不可用'), searchThrows(searchErrorResponse()))
check('响应不是对象也报错而不是崩', searchThrows(null).includes('不是对象'))

const searchBody = buildSearchBody('测试查询', { model: 'm', maxUses: 3, maxTokens: 99 })
equal('请求带上了服务端搜索工具', (searchBody.tools as { type: string }[])[0]?.type, 'web_search_20250305')
equal('max_uses 生效', (searchBody.tools as { max_uses: number }[])[0]?.max_uses, 3)
check('查询词进了提示', JSON.stringify(searchBody.messages).includes('测试查询'))

const searchServer = await startMockSearchServer()
const searchProvider = createDeepSeekSearchProvider({ apiKey: 'k-123', baseUrl: searchServer.url })

const searchResults = await searchProvider.search('DSH 是什么', { maxResults: 2 })
equal('maxResults 生效', searchResults.length, 2)

const searchRequest = searchServer.requests[0]
equal('打到 /messages', searchRequest?.path, '/messages')
equal('带上 x-api-key', searchRequest?.headers['x-api-key'], 'k-123')
equal('也带 Bearer（兼容代理）', searchRequest?.headers.authorization, 'Bearer k-123')
equal('带上 anthropic-version', searchRequest?.headers['anthropic-version'], '2023-06-01')
equal('请求体的模型', (searchRequest?.body as { model: string })?.model, 'deepseek-v4-flash')
check('请求体里查询词原样在', JSON.stringify(searchRequest?.body).includes('DSH 是什么'))

const formatted = formatSearchResults('DSH 是什么', searchResults)
check('工具输出是编号列表', formatted.includes('1. 第一篇') && formatted.includes('2. 第二篇'))
check('工具输出带链接', formatted.includes('https://example.com/a'))
check('工具输出带片段', formatted.includes('第一段的引用内容'))
check('空结果有明确说明', formatSearchResults('没有的东西', []).includes('没有返回结果'))

const statusServer = await startMockSearchServer({ mode: 'status', status: 401 })
let searchError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: 'bad', baseUrl: statusServer.url }).search('x')
} catch (cause) {
  searchError = cause instanceof Error ? cause.message : String(cause)
}
check('401 给出可读原因', searchError.includes('401') && searchError.includes('Key'), searchError)
await statusServer.close()

const noSearchServer = await startMockSearchServer({ mode: 'nosearch' })
let noSearchError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: 'k', baseUrl: noSearchServer.url }).search('x')
} catch (cause) {
  noSearchError = cause instanceof Error ? cause.message : String(cause)
}
check('端到端：没触发搜索时也报错', noSearchError.includes('没有触发联网搜索'), noSearchError)
await noSearchServer.close()

const slowServer = await startMockSearchServer({ mode: 'delay', delayMs: 1500 })
let timeoutError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: 'k', baseUrl: slowServer.url, timeoutMs: 200 }).search('x')
} catch (cause) {
  timeoutError = cause instanceof Error ? cause.message : String(cause)
}
check('超时能收住（不会挂死）', timeoutError.includes('超时'), timeoutError)
await slowServer.close()

const cancelServer = await startMockSearchServer({ mode: 'delay', delayMs: 1000 })
const cancelController = new AbortController()
cancelController.abort()
let cancelError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: 'k', baseUrl: cancelServer.url }).search('x', { signal: cancelController.signal })
} catch (cause) {
  cancelError = cause instanceof Error ? cause.message : String(cause)
}
check('取消能传导进来（按停止不该还挂着搜索）', cancelError !== '', cancelError)
await cancelServer.close()

let emptyQueryError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: 'k', baseUrl: searchServer.url }).search('   ')
} catch (cause) {
  emptyQueryError = cause instanceof Error ? cause.message : String(cause)
}
check('空查询直接驳回', emptyQueryError.includes('不能为空'), emptyQueryError)

let noKeyError = ''
try {
  await createDeepSeekSearchProvider({ apiKey: '', baseUrl: searchServer.url }).search('x')
} catch (cause) {
  noKeyError = cause instanceof Error ? cause.message : String(cause)
}
check('没有 key 时给出明确原因', noKeyError.includes('API Key'), noKeyError)

await searchServer.close()
check('搜索端点能干净关掉', true)

// ═══════════════════════════════════════════════════════ 循环写进日志的东西

section('事件日志（循环层）')

const logged = await run({
  stream: scriptedStream([toolCall('calc', '{"expression":"1+1"}'), [{ type: 'text', text: '等于 2。' }]]),
  tools: [calcTool],
})
const types = logged.log.all().map(event => event.type)

check('轮次与步的边界都进了日志',
  types.includes('turn/start') && types.includes('step/start') && types.includes('step/end')
  && types.indexOf('turn/start') < types.indexOf('step/start')
  && types[types.length - 1] === 'turn/end',
  JSON.stringify(types))
equal('结束原因如实记录', (logged.log.all().find(event => event.type === 'turn/end')?.data as { reason: string }).reason, 'completed')

const callSeq = types.indexOf('tool/call')
const resultSeq = types.indexOf('tool/result')
check('工具调用在结果之前就入日志（崩在中间也能知道调过什么）', callSeq !== -1 && resultSeq !== -1 && callSeq < resultSeq, `${callSeq} vs ${resultSeq}`)

const header = foldRequestHeader(logged.log.all())
check('请求信封进了日志', header !== null)
check('信封里记的是渲染后的系统提示词（不只是人设）',
  (header?.data as { system: string }).system.includes('## 运行环境') && (header?.data as { system: string }).system.includes('你是测试助手'))
equal('信封里也记了工具清单', (header?.data as { tools: string[] }).tools, ['calc'])
equal('全新会话的第一份信封原因是 initial', (header?.data as { reason: string }).reason, 'initial')
check('请求信封不进模型可见列表（它是 log-only）',
  logged.persisted.every(message => !message.text.includes('## 运行环境')))

const secondTurn = await run({
  stream: scriptedStream([[{ type: 'text', text: '好的' }]]),
  tools: [calcTool],
  initialRequest: false,
})
equal('非全新会话的首份信封原因是 resume', (foldRequestHeader(secondTurn.log.all())?.data as { reason: string }).reason, 'resume')

const approved = await run({
  stream: scriptedStream([toolCall('write_thing'), [{ type: 'text', text: '写好了' }]]),
  tools: [writeTool],
  approvalMode: 'write',
  decide: () => 'allow',
})
const decisions = approved.log.all().filter(event => event.type === 'approval/decided')
equal('审批决定也进了日志', decisions.length, 1)
equal('记的是哪次调用、什么决定', (decisions[0]?.data as { toolName: string, decision: string }).decision, 'allow')
check('审批事件是 log-only（不进上下文）', !approved.persisted.some(message => message.text.includes('approval')))

const brokenDisk = await run({
  stream: scriptedStream([[{ type: 'text', text: '这段不该被当成完成了' }]]),
  tools: [],
  commitFails: true,
})
check('写盘失败时报错', brokenDisk.events.some(event => event.type === 'error'))
check('写盘失败时以 error 收尾（fail-closed）', doneReasons(brokenDisk).includes('error'), JSON.stringify(doneReasons(brokenDisk)))
check('写盘失败时不留"完成了"的假象', !doneReasons(brokenDisk).includes('completed'))

// 循环内压缩：走日志遮蔽而不是删数据
const compactHistory: ChatMessage[] = Array.from({ length: 14 }, (_, index) => ({
  id: `cf${index}`, role: 'user' as const,
  text: `历史 ${index}：${'这一段足够长，用来把上下文顶起来。'.repeat(4)}`, createdAt: index,
}))
const compactedRun = await run({
  stream: scriptedStream([[{ type: 'text', text: '这是摘要' }], [{ type: 'text', text: '继续。' }]]),
  history: compactHistory,
  tools: [],
  contextBudget: 200,
})
const compactTypes = compactedRun.log.all().map(event => event.type)
check('压缩动作进了日志', compactTypes.includes('compaction/applied'))
check('压缩是"遮蔽"而不是删除：旧事件还在', compactedRun.log.all().some(event => event.type === 'user/message' && (event.data as { text: string }).text.includes('历史 0')))
check('模型可见列表里旧消息被摘要取代', compactedRun.persisted.some(message => message.summary === true))
check('遮蔽的 seq 有据可查',
  (compactedRun.log.all().find(event => event.type === 'compaction/applied')?.data as { shadowedSeqs: number[] }).shadowedSeqs.length >= 4)
equal('压缩后仍然正常收尾', doneReasons(compactedRun), ['completed'])
equal('累计替换代数不为零', foldSurface(compactedRun.log.all()).replaceGeneration >= 1, true)

// 落盘的事件应当与日志内容一致（不能"内存里有、磁盘上没有"）。
// 注意：测试台会先把 history 种进日志，那些是"已经落盘的历史"，所以提交的应当从种子之后开始。
equal('提交的事件数与日志长度一致', logged.committed.length, logged.log.length - 1)
equal('提交的第一个事件紧紧接在种子历史之后', logged.committed[0]?.seq, 1)
equal('提交的事件就是日志里那些', logged.committed.map(event => event.seq), logged.log.all().slice(1).map(event => event.seq))

// ═══════════════════════════════════════════════════════ 结果

console.log(`\n${passed} 项通过，${failed} 项失败`)

// 收尾别用裸 process.exit：MCP 客户端断开时会 fire-and-forget 发一个 DELETE 会话请求，
// 在它还没落地时就硬退，会在 Windows 上撞 libuv 断言（`UV_HANDLE_CLOSING`），
// 症状是"测试全过但退出码是 1"—— 这种假红比不跑测试更糟。
const exitCode = failed === 0 ? 0 : 1
await new Promise(resolve => setTimeout(resolve, 150))
process.exitCode = exitCode
// 兜底：万一还有句柄没释放，一秒后强制退出（正常情况下上面这会儿已经退了）。
setTimeout(() => process.exit(exitCode), 1000)
