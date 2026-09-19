/**
 * 会话存储（JSONL 事件日志 + 派生索引）的验证。
 *
 * 这一层要防的不是"功能没写"，而是**数据丢了很久都发现不了**，所以每组都按"现场复现"来：
 * App 被杀留下的撕裂尾、日志中间坏一行、索引丢了或写坏、端口写失败（fail-closed）、
 * 老格式迁移跑第二遍（幂等）、以及"消息是派生的"这条根本性质。
 * 同一组用例跑两遍 —— 内存端口一遍、真实临时目录一遍：只跑内存的话，
 * 端口抽象有没有偷偷依赖内存语义就验不出来。
 *
 *   npm test
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '../src/agent/sessionLog.ts'
import type { SessionEvent } from '../src/agent/sessionLog.ts'
import { foldSurface } from '../src/agent/surface.ts'
import type { ChatMessage, Session } from '../src/agent/types.ts'
import { createMemoryFilePort } from '../src/store/filePort.ts'
import type { FilePort } from '../src/store/filePort.ts'
import { createSessionStore } from '../src/store/sessionStore.ts'
import type { SessionIndexEntry } from '../src/store/sessionStore.ts'

/**
 * 真实文件系统端口 —— **只存在于测试里**。
 *
 * 应用侧用的是 `createExpoFilePort()`（走 expo-file-system）。这里再实现一份 Node 的，
 * 是为了让同一组用例在真实文件上再跑一遍：内存端口"太听话"，
 * 撕裂尾、目录不存在、追加语义这些差异只有落到真文件上才会暴露。
 */
function createNodeFilePort(root: string): FilePort {
  const full = (path: string): string => join(root, path)
  const parentOf = (path: string): string => full(path).replace(/[/\\][^/\\]*$/, '')
  return {
    readText: path => (existsSync(full(path)) ? readFileSync(full(path), 'utf8') : null),
    writeText: (path, text) => {
      mkdirSync(parentOf(path), { recursive: true })
      writeFileSync(full(path), text)
    },
    appendLine: (path, line) => {
      mkdirSync(parentOf(path), { recursive: true })
      appendFileSync(full(path), `${line}\n`)
    },
    list: dir => {
      if (!existsSync(full(dir))) return []
      return readdirSync(full(dir)).filter(name => statSync(join(full(dir), name)).isFile())
    },
    exists: path => existsSync(full(path)),
    remove: path => { rmSync(full(path), { recursive: true, force: true }) },
    ensureDir: dir => { mkdirSync(full(dir), { recursive: true }) },
  }
}

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

const T0 = 1_700_000_000_000
const DIR = 'dsh-store'

function message(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m-${text.slice(0, 4)}`, role, text, createdAt: T0, ...extra }
}

function newSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: '新会话',
    createdAt: T0,
    updatedAt: T0,
    messages: [],
    model: 'deepseek-chat',
    systemPrompt: '你是 DSH 的手机端助手。',
    todos: [],
    planMode: false,
    allowlist: [],
    ...overrides,
  }
}

const userEvent = (text: string, time = T0 + 1): Omit<SessionEvent, 'seq'> => ({
  type: 'user/message', time, data: { text }, surfaceOp: 'append',
} as unknown as Omit<SessionEvent, 'seq'>)
const assistantEvent = (text: string, time = T0 + 2): Omit<SessionEvent, 'seq'> => ({
  type: 'assistant/message', time, data: { text }, surfaceOp: 'append',
} as unknown as Omit<SessionEvent, 'seq'>)

const logPath = (id: string): string => `${DIR}/logs/${id}.jsonl`
const lines = (port: FilePort, path: string): string[] =>
  (port.readText(path) ?? '').split('\n').filter(line => line.trim() !== '')

/** 一个会在第 N 次写入时抛错的端口：用来验 fail-closed。 */
function failingPort(inner: FilePort, options: { failIndexWrite?: number, failLogAppend?: number }): FilePort {
  let indexWrites = 0
  let logAppends = 0
  return {
    ...inner,
    writeText: (path, text) => {
      if (path.endsWith('index.json')) {
        indexWrites += 1
        if (options.failIndexWrite === indexWrites) throw new Error('注入故障：索引写不进去')
      }
      inner.writeText(path, text)
    },
    appendLine: (path, line) => {
      if (path.endsWith('.jsonl')) {
        logAppends += 1
        if (options.failLogAppend === logAppends) throw new Error('注入故障：日志追加失败')
      }
      inner.appendLine(path, line)
    },
  }
}

async function caseSet(label: string, makePort: () => FilePort, cleanup?: () => void): Promise<void> {
  const port = makePort()
  const store = createSessionStore(port, { dir: DIR })

  // ── 往返与追加
  const created = store.create(newSession('s1', { title: '往返' }))
  equal(`${label} · create 可加载`, created.session.id, 's1')
  equal(`${label} · create 只写一行（请求信封）`, lines(port, logPath('s1')).length, 1)
  equal(`${label} · 第一行是请求信封`, JSON.parse(lines(port, logPath('s1'))[0] as string).type, 'request/header')
  equal(`${label} · 信封咬住了人设`, created.session.systemPrompt, '你是 DSH 的手机端助手。')

  store.append('s1', [userEvent('第一句'), assistantEvent('第一答')])
  equal(`${label} · 追加是只追加（三行）`, lines(port, logPath('s1')).length, 3)
  const seqs = lines(port, logPath('s1')).map(line => (JSON.parse(line) as { seq: number }).seq)
  equal(`${label} · seq 连续且等于行号`, seqs, [0, 1, 2])

  const reloaded = store.load('s1')
  equal(`${label} · 重新加载读回两条消息`, reloaded?.session.messages.map(m => m.text), ['第一句', '第一答'])
  equal(`${label} · 消息 id 由 seq 派生`, reloaded?.session.messages[1]?.id, 'e2')
  equal(`${label} · list 的 messageCount 与日志一致`, store.list().find(e => e.id === 's1')?.messageCount, 3)

  // ── 撕裂尾：App 被杀时最后一行只有半截
  port.writeText(logPath('s2'), [
    JSON.stringify({ type: 'request/header', seq: 0, time: T0, data: { system: '人设', tools: [], model: 'm', reason: 'initial' } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: T0, data: { text: '这一行是完整的' }, surfaceOp: 'append' }),
    '{"type":"assistant/message","seq":2,"time":1700000000',
  ].join('\n'))
  const torn = store.load('s2')
  equal(`${label} · 撕裂尾被丢弃，留下完整的那行`, torn?.log.length, 2)
  equal(`${label} · 丢弃的确实是最后半行`, torn?.session.messages.map(m => m.text), ['这一行是完整的'])

  // ── 日志中间坏了：必须报错并指出行号（不能装作没看见）
  port.writeText(logPath('s3'), [
    JSON.stringify({ type: 'user/message', seq: 0, time: T0, data: { text: 'a' }, surfaceOp: 'append' }),
    '{"type":"assistant/message" 这里是坏掉的半行',
    JSON.stringify({ type: 'assistant/message', seq: 2, time: T0, data: { text: 'c' }, surfaceOp: 'append' }),
  ].join('\n'))
  throwsWith(`${label} · 中间行损坏 → 报错并指出行号`, () => store.load('s3'), '行损坏')
  const corruptEntry = store.list().find(entry => entry.id === 's3')
  equal(`${label} · 坏会话仍列出来但标成不可用`, corruptEntry?.unusable, true)

  // ── 格式版本：不迁移、只拒绝
  port.writeText(logPath('s4'), [JSON.stringify({
    type: 'user/message', seq: 0, time: T0, data: { text: '未来格式' }, surfaceOp: 'append', formatVersion: 99,
  })].join('\n'))
  equal(`${label} · 版本不认 → load 返回 null`, store.load('s4'), null)
  equal(`${label} · 版本不认 → 列表里标成不可用`, store.list().find(e => e.id === 's4')?.unusable, true)

  // ── 索引是派生数据：丢了/写坏了都要能重建，而且**不能**因此丢标题
  store.rename('s1', '改过的标题')
  port.remove(`${DIR}/index.json`)
  const rebuilt = store.list().find(entry => entry.id === 's1')
  equal(`${label} · 索引丢了能重建`, rebuilt !== undefined, true)
  equal(`${label} · 重建后标题仍是我改过的（标题在日志里）`, rebuilt?.title, '改过的标题')
  equal(`${label} · 重建后条数是日志算出来的`, rebuilt?.messageCount, 4)

  port.writeText(`${DIR}/index.json`, '{"这不是数组":true}')
  equal(`${label} · 索引是坏 JSON 时同样重建`, store.list().find(e => e.id === 's1')?.title, '改过的标题')

  // ── messages 是派生的：绕过 store 直接改日志，重新 load 消息就该变
  const beforeDerive = store.load('s1')
  equal(`${label} · 改动前两条消息`, beforeDerive?.session.messages.length, 2)
  port.appendLine(logPath('s1'), JSON.stringify({
    type: 'user/message', seq: 4, time: T0 + 5, data: { text: '只写进日志的第三条' }, surfaceOp: 'append',
  }))
  const afterDerive = store.load('s1')
  equal(`${label} · 只改日志，消息跟着变（没有第二份副本）`, afterDerive?.session.messages.length, 3)
  equal(`${label} · 新消息内容也对`, afterDerive?.session.messages[2]?.text, '只写进日志的第三条')

  // ── 压缩：遮蔽而不是删除
  const all = afterDerive?.log.all() ?? []
  const shadowed = foldSurface(all).nodes.slice(0, 2).map(node => node.seq)
  const compactionLog = new SessionLog(all)
  compactionLog.append({
    type: 'compaction/applied', time: T0 + 6,
    data: { shadowedSeqs: shadowed, summarySeq: all.length + 1, replacedCount: shadowed.length, tokensBefore: 900, tokensAfter: 100 },
  } as Omit<SessionEvent, 'seq'>)
  compactionLog.append({
    type: 'user/message', time: T0 + 6, data: { text: '【对话摘要】压成一句', synthetic: 'summary' },
    surfaceOp: { op: 'replace', start: shadowed[0] as number, end: shadowed[shadowed.length - 1] as number },
    sourceEventSeqs: shadowed,
  } as unknown as Omit<SessionEvent, 'seq'>)
  for (const event of compactionLog.all().slice(-2)) port.appendLine(logPath('s1'), JSON.stringify(event))

  const compacted = store.load('s1')
  equal(`${label} · 压缩后可见消息变少（遮蔽生效）`, compacted?.session.messages.length, 2)
  equal(`${label} · 摘要排在被遮蔽的位置`, compacted?.session.messages[0]?.summary, true)
  equal(`${label} · 旧事件一条没删（压缩可回溯）`, compacted?.log.length, all.length + 2)
  check(`${label} · 被遮蔽的原消息仍能在日志里找到`,
    (compacted?.log.all() ?? []).some(e => e.type === 'user/message' && (e.data as { text: string }).text === '第一句'))

  // ── 崩溃恢复：有 turn/start 没 turn/end
  store.create(newSession('s5', { title: '崩过' }))
  store.append('s5', [
    { type: 'turn/start', time: T0, data: { turn: 1 } } as Omit<SessionEvent, 'seq'>,
    { type: 'step/start', time: T0, data: { turn: 1, step: 1 } } as Omit<SessionEvent, 'seq'>,
    userEvent('跑到一半被杀', T0),
    { type: 'tool/call', time: T0, data: { turn: 1, step: 1, callId: 'c1', name: 'web_fetch', arguments: '{}' } } as Omit<SessionEvent, 'seq'>,
  ])
  const beforeRecover = lines(port, logPath('s5')).length
  const recoveredSession = store.load('s5')
  equal(`${label} · 加载时补合了被打断的轮次`, recoveredSession?.recovered.map(e => e.type), ['step/end', 'turn/end'])
  equal(`${label} · 结束原因标成 interrupted`, (recoveredSession?.recovered[1]?.data as { reason: string }).reason, 'interrupted')
  equal(`${label} · 未决的工具调用被标出来`, recoveredSession?.unresolved.map(c => c.name), ['web_fetch'])
  equal(`${label} · 补合的事件落了盘（凭空多两行）`, lines(port, logPath('s5')).length, beforeRecover + 2)
  equal(`${label} · 再加载就没有待补的了`, store.load('s5')?.recovered.length, 0)

  // ── fail-closed
  store.create(newSession('s6', { title: '失败注入' }))
  const beforeFail = lines(port, logPath('s6')).length
  const failing = createSessionStore(failingPort(port, { failIndexWrite: 1 }), { dir: DIR })
  throwsWith(`${label} · 索引写不进去 → append 抛错（调用方据此中止这一轮）`,
    () => failing.append('s6', [userEvent('这条会写进日志但索引失败')]),
    '索引写入失败')
  equal(`${label} · 日志行仍然写了（次序：先日志后索引）`, lines(port, logPath('s6')).length, beforeFail + 1)
  const indexAfterFail = JSON.parse(port.readText(`${DIR}/index.json`) ?? '[]') as SessionIndexEntry[]
  const staleEntry = indexAfterFail.find(entry => entry.id === 's6')
  check(`${label} · 索引只会落后于日志，绝不会反过来`,
    (staleEntry?.messageCount ?? 0) < lines(port, logPath('s6')).length,
    `索引 ${staleEntry?.messageCount} vs 日志 ${lines(port, logPath('s6')).length}`)

  const failingLog = createSessionStore(failingPort(port, { failLogAppend: 1 }), { dir: DIR })
  throwsWith(`${label} · 日志追加失败 → 同样抛错`, () => failingLog.append('s6', [userEvent('这行落不了盘')]), '追加失败')

  // ── 迁移（老格式 → 事件日志），幂等
  const legacyRaw: Session[] = [
    newSession('s-old-1', {
      title: '老会话一',
      systemPrompt: '老一的人设',
      messages: [message('system', '老一的人设'), message('user', '老会话里的第一句'), message('assistant', '老会话里的第一答')],
    }),
    newSession('s-old-2', { title: '老会话二', messages: [message('user', '只有一句')] }),
  ]
  const migrated = createSessionStore(port, { dir: 'legacy' })
  equal(`${label} · 第一次迁移两个都迁了`, migrated.migrateLegacy(legacyRaw, { keepBackup: true }), { migrated: 2, skipped: 0 })
  const oldOne = migrated.load('s-old-1')
  equal(`${label} · 老消息全变成事件`, oldOne?.log.length, 3)
  equal(`${label} · system 消息自然变成请求信封`, oldOne?.log.all()[0]?.type, 'request/header')
  equal(`${label} · 老会话的人设没丢`, oldOne?.session.systemPrompt, '老一的人设')
  equal(`${label} · 老消息文本一字不差`, oldOne?.session.messages.map(m => m.text), ['老会话里的第一句', '老会话里的第一答'])
  equal(`${label} · 第二次迁移全部跳过（幂等）`, migrated.migrateLegacy(legacyRaw), { migrated: 0, skipped: 2 })
  equal(`${label} · 备份留的是原文`, JSON.parse(port.readText('legacy/legacy-backup.json') ?? '[]').length, 2)

  // ── 列表排序与改名/删除
  const listStore = createSessionStore(port, { dir: 'list' })
  listStore.create(newSession('s-a', { title: 'A', updatedAt: T0 + 100 }))
  listStore.create(newSession('s-b', { title: 'B', updatedAt: T0 + 300 }))
  listStore.create(newSession('s-c', { title: 'C', updatedAt: T0 + 200 }))
  equal(`${label} · list 按最近动静倒序`, listStore.list().map(e => e.id), ['s-b', 's-c', 's-a'])

  listStore.append('s-a', [userEvent('把 A 顶到最前', T0 + 400)])
  equal(`${label} · 有新动静的排最前`, listStore.list()[0]?.id, 's-a')
  listStore.rename('s-c', 'C 改过名')
  equal(`${label} · 改名落进索引`, listStore.list().find(e => e.id === 's-c')?.title, 'C 改过名')
  equal(`${label} · 改名不会把它顶到最前（updatedAt 衡量的是内容）`, listStore.list()[0]?.id, 's-a')
  equal(`${label} · 改名后重新加载，标题还是新的`, listStore.load('s-c')?.session.title, 'C 改过名')

  listStore.remove('s-b')
  equal(`${label} · 删除后列表里没有了`, listStore.list().map(e => e.id), ['s-a', 's-c'])
  equal(`${label} · 删除后日志文件也没了`, port.exists('list/logs/s-b.jsonl'), false)

  cleanup?.()
}

console.log('── 内存端口 ──')
await caseSet('内存', () => createMemoryFilePort())

console.log('\n── 临时目录（真实文件系统）──')
const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
await caseSet('真机', () => createNodeFilePort(dir), () => rmSync(dir, { recursive: true, force: true }))

console.log(`\n${passed} 项通过，${failed} 项失败`)
const exitCode = failed === 0 ? 0 : 1
await new Promise(resolve => setTimeout(resolve, 150))
process.exitCode = exitCode
setTimeout(() => process.exit(exitCode), 1000)
