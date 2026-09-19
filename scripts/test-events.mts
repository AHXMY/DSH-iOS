/**
 * 事件日志与 surface 折叠的验证。
 *
 * 这一层是从原版搬过来的地基，所以验的也必须是原版那几条不变量：
 * 序号连续、未知事件默认拒绝、替换必须列全遮蔽集、**压缩只遮蔽不删除**、
 * 崩溃后能把被打断的轮次合上。这些都是"错了很久都发现不了"的东西，必须钉在测试里。
 *
 *   npm test
 */
import {
  SESSION_FORMAT_VERSION, SessionLog, SessionLogError,
  checkpointReasons, interruptedTurnClosers, isSurfaceEvent, unresolvedToolCalls,
} from '../src/agent/sessionLog.ts'
import type { SessionEvent } from '../src/agent/sessionLog.ts'
import { appendCompaction, appendMessageEvent, appendToolResultPrune, deriveMessages, foldRequestHeader, foldSurface } from '../src/agent/surface.ts'
import type { ChatMessage } from '../src/agent/types.ts'

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

function throwsWith(name: string, run: () => unknown, fragment: string): void {
  try {
    run()
    check(name, false, '没有抛错')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    check(name, message.includes(fragment), message)
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`,
  role,
  text,
  createdAt: 1_700_000_000_000,
  ...extra,
})

// ═══════════════════════════════════════════════ 信封与追加

section('事件信封与追加校验')

const log = new SessionLog()
const first = log.append({ type: 'turn/start', time: Date.now(), data: { turn: 1 } } as Omit<SessionEvent, 'seq'>)
equal('seq 从 0 开始且连续', first.seq, 0)
equal('长度即 seq', log.length, 1)

const second = log.append({ type: 'step/start', time: Date.now(), data: { turn: 1, step: 1 } } as Omit<SessionEvent, 'seq'>)
equal('第二条 seq 是 1', second.seq, 1)

throwsWith('显式给错 seq 会被拒绝（日志不许有洞）',
  () => log.append({ type: 'step/end', time: Date.now(), data: { turn: 1, step: 1 }, seq: 99 } as Omit<SessionEvent, 'seq'>),
  '连续')

throwsWith('未知事件类型默认拒绝',
  () => log.append({ type: 'plugin/whatever', time: Date.now(), data: {} } as Omit<SessionEvent, 'seq'>),
  '未知事件类型')

const ignorable = log.append({ type: 'plugin/whatever', time: Date.now(), data: { x: 1 }, ignorable: true } as unknown as Omit<SessionEvent, 'seq'>)
check('标了 ignorable 的未知事件允许写入', ignorable.seq === 2)
check('未知事件不算 surface', isSurfaceEvent(ignorable) === false)

throwsWith('未知事件不许带 surface 元数据',
  () => log.append({ type: 'plugin/x', time: Date.now(), data: {}, ignorable: true, surfaceOp: 'append' } as unknown as Omit<SessionEvent, 'seq'>),
  'surface')

check('追加后的事件被冻结（改不动）', Object.isFrozen(log.all()[0] as SessionEvent))
check('冻结是深层的（data 也改不动）', Object.isFrozen((log.all()[0] as SessionEvent).data))

throwsWith('格式版本不匹配就拒绝加载，不做迁移',
  () => new SessionLog(undefined, SESSION_FORMAT_VERSION + 1),
  '不支持的会话格式版本')

// ═══════════════════════════════════════════════ surface 规则

section('surface 规则')

const rules = new SessionLog()
throwsWith('非 surface 事件不许带 surfaceOp',
  () => rules.append({ type: 'model/usage', time: Date.now(), data: { promptTokens: 1 }, surfaceOp: 'append' } as unknown as Omit<SessionEvent, 'seq'>),
  '不是 surface 事件')

throwsWith('surface 事件必须带 surfaceOp',
  () => rules.append({ type: 'user/message', time: Date.now(), data: { text: '你好' } } as Omit<SessionEvent, 'seq'>),
  '必须带 surfaceOp')

rules.append({ type: 'user/message', time: Date.now(), data: { text: '你好' }, surfaceOp: 'append' } as unknown as Omit<SessionEvent, 'seq'>)
throwsWith('replace 必须列全被遮蔽的 seq',
  () => rules.append({ type: 'user/message', time: Date.now(), data: { text: '摘要' }, surfaceOp: { op: 'replace', start: 0, end: 0 } } as unknown as Omit<SessionEvent, 'seq'>),
  'sourceEventSeqs')

throwsWith('replace 不能遮蔽还不存在的事件',
  () => rules.append({
    type: 'user/message', time: Date.now(), data: { text: 'x' },
    surfaceOp: { op: 'replace', start: 0, end: 99 }, sourceEventSeqs: [0],
  } as unknown as Omit<SessionEvent, 'seq'>),
  '已经存在')

// ═══════════════════════════════════════════════ 折叠与派生

section('折叠与派生（压缩 = 遮蔽，不是删除）')

const convo = new SessionLog()
appendMessageEvent(convo, msg('user', '帮我整理一下这周的记录'))
appendMessageEvent(convo, msg('assistant', '好的，我先看看有哪些。'))
appendMessageEvent(convo, msg('tool', '已写入 notes/周报.md', { toolCallId: 'c1', toolName: 'write_file' }))
appendMessageEvent(convo, msg('user', '再补一条'))
appendMessageEvent(convo, msg('assistant', '补好了。'))

const beforeFold = foldSurface(convo.all())
equal('五条消息按序派生', beforeFold.messages.length, 5)
equal('角色顺序正确', beforeFold.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user', 'assistant'])
equal('初始替换代数为 0', beforeFold.replaceGeneration, 0)

const eventsBeforeCompaction = convo.length
const shadowed = beforeFold.nodes.slice(0, 3).map(node => node.seq)
appendCompaction(convo, {
  summary: '【对话摘要】用户要做周报；已写入 notes/周报.md。',
  shadowedSeqs: shadowed,
  replacedCount: 3,
  tokensBefore: 900,
  tokensAfter: 120,
})

const afterFold = foldSurface(convo.all())
check('旧事件一条都没删（日志只增）', convo.length === eventsBeforeCompaction + 2, `${eventsBeforeCompaction} → ${convo.length}`)
equal('被遮蔽的三条从模型可见列表里消失', afterFold.messages.length, 3)
equal('摘要排在被遮蔽的位置', afterFold.messages[0]?.summary, true)
check('摘要正文在', (afterFold.messages[0]?.text ?? '').includes('周报'))
equal('后面的消息顺序不变', afterFold.messages.slice(1).map(m => m.text), ['再补一条', '补好了。'])
equal('替换代数自增', afterFold.replaceGeneration, 1)
check('被遮蔽的 seq 记录在节点上，可审计', JSON.stringify(afterFold.nodes[0]?.shadowed) === JSON.stringify(shadowed), JSON.stringify(afterFold.nodes[0]?.shadowed))
check('日志里还能查到被遮蔽的原事件（压缩可回溯）',
  convo.all().some(event => event.type === 'user/message' && (event.data as { text: string }).text.includes('帮我整理')))
check('压缩动作本身也留了记录',
  convo.all().some(event => event.type === 'compaction/applied' && JSON.stringify((event.data as { shadowedSeqs: number[] }).shadowedSeqs) === JSON.stringify(shadowed)))

// 再次压缩（把摘要 + 后两条也压掉），验证 replaceGeneration 与"叠replace"能工作
const secondFold = foldSurface(convo.all())
const shadowedAgain = secondFold.nodes.map(node => node.seq)
appendCompaction(convo, { summary: '【对话摘要】全部压成一句。', shadowedSeqs: shadowedAgain, replacedCount: 3, tokensBefore: 300, tokensAfter: 30 })
const thirdFold = foldSurface(convo.all())
equal('二次压缩后只剩一条', thirdFold.messages.length, 1)
equal('二次压缩的遮蔽集包含上一次的摘要节点', thirdFold.nodes[0]?.shadowed?.length, shadowedAgain.length)
equal('替换代数累计', thirdFold.replaceGeneration, 2)

// 声明与实际不符必须报错（否则"遮蔽集"就是假的）。
// 注意两点：① 只能靠手写事件触发 —— appendCompaction 是根据遮蔽集反推区间的，不可能自相矛盾；
// ② 这道闸在**折叠**时守（追加时日志还不知道 surface 长什么样），所以要 append 完再 fold。
// 两条反例各用一份干净的日志：共用一个日志的话，第一条"说谎"的事件会先被折叠撞上，
// 第二条就永远轮不到 —— 那样测出来的是"报了错"，但报的不是这一条该报的错。
const lyingMissing = new SessionLog()
appendMessageEvent(lyingMissing, msg('user', 'a'))
appendMessageEvent(lyingMissing, msg('assistant', 'b'))
throwsWith('声明的遮蔽集少列了（实际遮蔽两条、只声明一条）时报错',
  () => {
    lyingMissing.append({
      type: 'user/message', time: Date.now(), data: { text: 's' },
      surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0],
    } as unknown as Omit<SessionEvent, 'seq'>)
    foldSurface(lyingMissing.all())
  },
  '漏报')

const lyingOutside = new SessionLog()
appendMessageEvent(lyingOutside, msg('user', '丙'))
appendMessageEvent(lyingOutside, msg('assistant', '丁'))
throwsWith('声明的遮蔽集多列了（声明了区间外的 seq）时报错',
  () => {
    lyingOutside.append({
      type: 'user/message', time: Date.now(), data: { text: 's' },
      surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0, 1],
    } as unknown as Omit<SessionEvent, 'seq'>)
    foldSurface(lyingOutside.all())
  },
  '区间之外')

// 单条工具结果裁剪（原版 compaction-tool-result-pruner 的做法）
const withBigTool = new SessionLog()
appendMessageEvent(withBigTool, msg('user', '抓个网页'))
appendMessageEvent(withBigTool, msg('assistant', '', { toolCalls: [{ id: 'c9', name: 'web_fetch', arguments: '{"url":"x"}' }] }))
appendMessageEvent(withBigTool, msg('tool', 'x'.repeat(5000), { toolCallId: 'c9', toolName: 'web_fetch' }))
const toolSeq = foldSurface(withBigTool.all()).nodes[2]?.seq as number
appendToolResultPrune(withBigTool, { targetSeq: toolSeq, callId: 'c9', name: 'web_fetch', preview: 'x'.repeat(200), originalChars: 5000 })
const prunedFold = foldSurface(withBigTool.all())
equal('裁剪后条数不变（是替换不是删除）', prunedFold.messages.length, 3)
check('工具结果变短了', (prunedFold.messages[2]?.text.length ?? 0) < 1000)
check('裁剪有标注', prunedFold.messages[2]?.pruned === true)
check('裁剪注明原长度', (prunedFold.messages[2]?.text ?? '').includes('5000'))

// ═══════════════════════════════════════════════ 重放与恢复

section('重放与崩溃恢复')

const replayA = deriveMessages(convo.all())
const replayB = deriveMessages(convo.all())
equal('同一份日志派生两次结果一致（replay = 重新派生）', JSON.stringify(replayA), JSON.stringify(replayB))

const seeded = SessionLog.fromSeed([
  { type: 'user/message', time: 1, data: { text: '历史一' }, surfaceOp: 'append' },
  { type: 'assistant/message', time: 2, data: { text: '历史二' }, surfaceOp: 'append' },
] as unknown as SessionEvent[])
check('fromSeed 会补上 end-seed 边界', seeded.all().some(event => event.type === 'session/end-seed'))
equal('实时事件的起点在边界之后', seeded.firstLiveSeq, 3)
equal('种子历史照样进模型上下文', deriveMessages(seeded.all()).length, 2)

// 回归：普通构造器**不能**偷偷补事件。
// 早先的版本会补，结果存储层从磁盘重建日志时内存比文件多一条，
// 下一次追加拿到的 seq 就比文件行数大一 —— 日志出现空洞，再加载直接报"seq 不连续"。
const plainSeed = new SessionLog([
  { type: 'user/message', time: 1, data: { text: '甲' }, surfaceOp: 'append' },
] as unknown as SessionEvent[])
equal('普通构造器只播种、不多写事件', plainSeed.length, 1)
const appendedAfterSeed = plainSeed.append({
  type: 'user/message', time: 2, data: { text: '乙' }, surfaceOp: 'append',
} as unknown as Omit<SessionEvent, 'seq'>)
equal('播种之后追加的 seq 紧接种子（不跳号）', appendedAfterSeed.seq, 1)

const crashed = new SessionLog()
crashed.append({ type: 'turn/start', time: Date.now(), data: { turn: 1 } } as Omit<SessionEvent, 'seq'>)
crashed.append({ type: 'step/start', time: Date.now(), data: { turn: 1, step: 1 } } as Omit<SessionEvent, 'seq'>)
appendMessageEvent(crashed, msg('user', '跑到一半就被杀了'))
crashed.append({ type: 'tool/call', time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'web_fetch', arguments: '{}' } } as Omit<SessionEvent, 'seq'>)

const closers = interruptedTurnClosers(crashed.all())
equal('被打断的轮次会被合上（补 step/end + turn/end）', closers.map(event => event.type), ['step/end', 'turn/end'])
equal('结束原因标记为 interrupted', (closers[1]?.data as { reason: string }).reason, 'interrupted')
for (const closer of closers) crashed.append(closer)
equal('合上之后再算就没有待补的了', interruptedTurnClosers(crashed.all()).length, 0)

const unresolved = unresolvedToolCalls(crashed.all())
equal('已记录但没有结果的调用被标出来', unresolved.length, 1)
equal('那个调用就是 web_fetch', unresolved[0]?.name, 'web_fetch')
crashed.append({ type: 'tool/result', time: Date.now(), data: { callId: 'c1', name: 'web_fetch', text: '结果' }, surfaceOp: 'append' } as unknown as Omit<SessionEvent, 'seq'>)
equal('有结果之后就不再是未决调用', unresolvedToolCalls(crashed.all()).length, 0)

// ═══════════════════════════════════════════════ 检查点与请求信封

section('检查点与请求信封')

equal('模型请求前要落盘', checkpointReasons({ aboutToCallModel: true, aboutToRunTool: false, atStepBoundary: false, atTurnBoundary: false }), ['before-model-request'])
equal('有副作用的工具派发前要落盘',
  checkpointReasons({ aboutToCallModel: false, aboutToRunTool: { hasSideEffect: true }, atStepBoundary: false, atTurnBoundary: false }),
  ['before-tool-side-effect'])
equal('只读工具不必单独落盘',
  checkpointReasons({ aboutToCallModel: false, aboutToRunTool: { hasSideEffect: false }, atStepBoundary: false, atTurnBoundary: false }),
  [])
equal('步与轮边界都要落盘',
  checkpointReasons({ aboutToCallModel: false, aboutToRunTool: false, atStepBoundary: true, atTurnBoundary: true }),
  ['step-boundary', 'turn-boundary'])

const headerLog = new SessionLog()
headerLog.append({
  type: 'request/header', time: 10,
  data: { system: '第一版提示词', tools: ['web_search'], model: 'deepseek-chat', reason: 'initial' },
} as Omit<SessionEvent, 'seq'>)
headerLog.append({
  type: 'request/header', time: 20,
  data: { system: '第二版提示词', tools: ['web_search', 'bash'], model: 'deepseek-chat', reason: 'change' },
} as Omit<SessionEvent, 'seq'>)
const header = foldRequestHeader(headerLog.all())
equal('取最新一份请求信封', (header?.data as { system: string }).system, '第二版提示词')
equal('工具清单也在信封里（请求可重建）', (header?.data as { tools: string[] }).tools.length, 2)
equal('请求信封不进 surface', isSurfaceEvent(header as SessionEvent), false)
equal('所以它不会出现在模型消息里', deriveMessages(headerLog.all()).length, 0)

// ═══════════════════════════════════════════════ 结果

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
