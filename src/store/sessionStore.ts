/**
 * 会话存储：把事件日志落到手机上，并在需要时把它读回来。
 *
 * 这一层只做三件事，其余一概不做：
 *
 *   1. **每会话一个 JSONL 事件日志**（`<dir>/logs/<id>.jsonl`），一行一个事件。
 *      之所以不是"一个 sessions.json 装全部"：整份重写意味着每次发消息都要把
 *      所有会话的所有历史重新序列化一遍，而且写坏一次就是全部会话一起没。
 *      一行一条还有个额外好处 —— **追加是原子的最小单位**，写到一半被杀只坏最后一行。
 *   2. **索引是派生数据**（`<dir>/index.json`）：列表页要"标题 + 时间 + 条数"，不必为此
 *      把每个会话的日志都读一遍。但派生就是派生 —— 索引读不出来、或跟日志对不上时，
 *      直接扫一遍日志重建，绝不让索引成为第二份真相。
 *   3. **崩溃恢复**：加载时把被 App 杀掉的那一轮"合上"（补 `turn/end{interrupted}`），
 *      并把"记了但没结果"的工具调用标出来 —— 那些调用的结果**未知**，不许当没发生、更不许自动重试。
 *
 * 三条纪律，都是"错了很久都发现不了"的那类错误：
 *
 *   · **撕裂尾容忍、中间损坏报错**。最后一行可能是被杀时写了一半的半行，丢掉它是对的；
 *     中间某行坏了是严重问题（日志被篡改、或者写入逻辑有 bug），必须当场炸，不能装作没看见。
 *   · **格式版本不匹配就拒绝**。不猜、不迁移 —— 读不了的就别装作读得了。
 *   · **fail-closed 且次序固定**：先写日志行，再写索引。任何一步失败都抛给调用方，
 *     调用方据此中止这一轮。索引落后于日志是可接受的（下次加载自会补齐），
 *     反过来"索引说写了、日志里没有"才是真丢数据，所以次序不能反。
 *
 * 这个文件**不 import expo**：文件系统的一切都走 `FilePort`，于是整套逻辑能在 Node 里
 * 用内存端口把崩溃、损坏、写失败都真跑一遍（见 `scripts/test-store.mts`）。
 */
import { SessionLog, SESSION_FORMAT_VERSION, interruptedTurnClosers, unresolvedToolCalls } from '../agent/sessionLog'
import type { RequestHeaderData, SessionEvent, SessionSeq, ToolCallData } from '../agent/sessionLog'
import { appendMessageEvent, deriveMessages, foldRequestHeader } from '../agent/surface'
import type { ChatMessage, Session, SessionState, TodoItem } from '../agent/types'
import type { FilePort } from './filePort'

/** 索引里的一条：列表页要显示的东西，全都在这儿，不必读日志正文。 */
export type SessionIndexEntry = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  /** 派生读数，方便列表页不读日志正文就知道大概 */
  messageCount: number
  formatVersion: number
  /**
   * 日志存在、但格式版本不认识（比"读不了"更准确的表达是"本版本不该动它"）。
   *
   * 这是对给定索引形状的**附加可选字段**，加它的理由：需求要求"版本不匹配的会话要在
   * `list()` 里被标成不可用"，而把"不可用"表达成 `messageCount: -1` 那种约定会让
   * 调用方永远猜不透；可选字段则在形状不变的前提下把话说明白。不写这个字段的旧索引照样读。
   */
  unusable?: true
}

/**
 * 会话状态事件的类型名。它是 log-only 事件，不进模型上下文。
 *
 * 为什么要有它：`SessionState`（todo / 计划模式 / 允许清单 / 计划文本）现在还是由循环
 * 直接改内存对象的，日志里还没有承载它的一等事件。若不做任何约定，`load()` 之后
 * 这几个字段只能永远回落到默认值，而"恢复出来的会话状态不对"正是最难被发现的一类 bug。
 *
 * 采用原版对未知事件的那套办法处理：标 `ignorable: true`。于是它
 *   ① 能通过 `validateAppend`（未知类型但显式声明可忽略）；
 *   ② 不会被 `foldSurface` 当成 surface 事件（不污染模型上下文）；
 *   ③ 循环哪天开始写它，存储层不用再改一行。
 * 现在没人写它，所以命中就用、没有就落回传入的默认 —— 全部逻辑在下面这个"认不认"和
 * `deriveState()` 里，不往 `sessionLog.ts` 的联合类型上加东西。
 */
const STATE_EVENT_TYPE = 'session/state'

/** 状态事件的数据形状：拿不准的一律在读取时逐字段收窄，不轻信落盘的内容。 */
type SessionStateEventData = {
  todos?: unknown
  planMode?: unknown
  plan?: unknown
  allowlist?: unknown
}

/**
 * 认不认识一个"会话状态"事件，并把它的 data 收成可读的形状。
 *
 * 注意这里绕了一圈类型：`SessionEvent` 是从 `SessionEventDataMap` 生成的判别联合，里面没有
 * `session/state`，所以 `event.type === 'session/state'` 会被 TS 判成"永假比较" —— 这是**故意的**，
 * 状态事件是存储层对未知事件（`ignorable`）的一次使用，不是往地基里加类型。
 * 所以在边界上转一次型，拿到 data 之后走同一个运行期校验。
 */
function asStateEventData(event: SessionEvent): SessionStateEventData | null {
  const raw = event as unknown as { type?: unknown, data?: unknown }
  if (raw.type !== STATE_EVENT_TYPE) return null
  return isRecord(raw.data) ? (raw.data as SessionStateEventData) : null
}

/** 加载结果：日志是唯一真相，`session.messages` 只是它派生出来的读数。 */
export type LoadedSession = {
  /** 事件日志（唯一真相） */
  log: SessionLog
  /** 从日志派生出来的会话对象；messages 是*派生*结果，不是存下来的 */
  session: Session
  /** 加载时补写的"合上被打断轮次"的事件（已 append 进日志，这里回显一份） */
  recovered: SessionEvent[]
  /** 已记录但没有结果的工具调用（恢复时要让用户/模型知道结果未知） */
  unresolved: ToolCallData[]
}

export type SessionStore = {
  list(): SessionIndexEntry[]
  /** 不存在返回 null；加载时会校验格式版本、补合被打断的轮次 */
  load(id: string): LoadedSession | null
  create(session: Session): LoadedSession
  /** 追加事件并更新索引（这里是唯一的写入口） */
  append(id: string, events: Array<Omit<SessionEvent, 'seq'>>): void
  rename(id: string, title: string): void
  remove(id: string): void
  /** 老格式（sessions.json 里带 messages 数组）迁移；幂等，可重复调用 */
  migrateLegacy(legacy: Session[], options?: { keepBackup?: boolean }): { migrated: number, skipped: number }
}

/** 存储层的错误单独一类：调用方可以据此区分"存储挂了"和"事件本身不合法"。 */
export class SessionStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'SessionStoreError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** 会话状态部分的默认值：日志里没有就落回这里。 */
const DEFAULT_STATE: SessionState = { todos: [], planMode: false, allowlist: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 索引条目的宽松校验：索引是派生数据，格式不对就当它不存在（会触发重建），不要拿它喂下游。 */
function coerceIndexEntry(raw: unknown): SessionIndexEntry | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  const entry: SessionIndexEntry = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '会话',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    model: typeof raw.model === 'string' ? raw.model : '',
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
    formatVersion: typeof raw.formatVersion === 'number' ? raw.formatVersion : SESSION_FORMAT_VERSION,
  }
  if (raw.unusable === true) entry.unusable = true
  return entry
}

// ─────────────────────────────────────────────────────────────
// JSONL 解析

/** 一行日志里的版本信息：拿不到就当场拒绝，"猜一个版本"是最不该做的事。 */
type LogHead = { formatVersion: number, events: SessionEvent[] }

/**
 * 逐行解析 JSONL 事件日志。
 *
 * 版本判定按**显式声明**来：
 *   · 写过的行里若带 `formatVersion` 且与当前版本不符 → 返回 `null`（不猜、不迁移）；
 *   · 一行都没有声明 → 视为当前版本。
 * 后者不是偷懒：事件信封本身（`sessionLog.ts`）没有版本字段，只有当某项不兼容的演化
 * 发生时才需要逐行标记，所以"没声明"就是"按当前版本写的"。反过来说，只要有人写了
 * `formatVersion: 1`，本版本就一律拒绝加载 —— 这条闸必须真的能拦住东西。
 *
 * 撕裂尾的处理：最后一行解析失败就丢弃它（App 被杀时正在写这一行，这是预期内的）。
 * 中间行解析失败直接抛错 —— 日志中间破了个洞，继续读下去只会得到一份自相矛盾的历史。
 */
function parseLog(text: string, id: string): LogHead | null {
  const raw = text.split('\n')
  // 文件正常以换行结尾，split 会多出一个空串；先去掉它，免得把"正常结尾"误判成撕裂尾。
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()

  const events: SessionEvent[] = []
  let declaredVersion: number = SESSION_FORMAT_VERSION

  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] as string
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      if (i === raw.length - 1) {
        // 撕裂尾：最后一行是半行，丢掉。日志里已有的部分仍然可信。
        break
      }
      throw new SessionStoreError(`会话 ${id} 的日志第 ${i + 1} 行损坏（不是合法 JSON）`, { cause })
    }
    if (!isRecord(parsed)) {
      if (i === raw.length - 1) break
      throw new SessionStoreError(`会话 ${id} 的日志第 ${i + 1} 行损坏（不是一个事件对象）`)
    }
    if (typeof parsed.formatVersion === 'number') {
      declaredVersion = parsed.formatVersion
      // 版本是第一件要判的事：不匹配就没必要往下解析了。
      if (declaredVersion !== SESSION_FORMAT_VERSION) return null
    }
    events.push(parsed as unknown as SessionEvent)
  }

  if (events.length === 0) {
    // 空文件不是"一个新会话"：新建会话总会先写一行 header（哪怕是空会话）。
    // 把空文件当作可加载的会话，等于让一个写坏的现场冒充"刚建好还没聊过"。
    return null
  }
  return { formatVersion: declaredVersion, events }
}

/** 重建日志对象：`SessionLog` 的构造器会连同"seq 连续、未知事件、surface 元数据"一起把关。 */
function rehydrate(events: readonly SessionEvent[]): SessionLog {
  return new SessionLog(events)
}

/**
 * 把一条事件序列化成"一行"。
 *
 * 统一走这里，是为了让"一行 = 一个 JSON 对象 + 一个换行"这条约定只写一次 ——
 * 散落各处手拼 JSON.stringify 的话，漏掉 seq、漏掉换行这类错误会在不同调用点各犯一次。
 */
function serializeEvent(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** 新建会话的第一行：请求信封（`reason: 'initial'`）。 */
function headerEvent(session: Session): SessionEvent {
  return {
    type: 'request/header',
    // 时间戳取会话自己的 updatedAt（退回 createdAt，再退回现在）：
    // 日志里的时间是**唯一真相**，索引里的 updatedAt 是从它派生的。
    // 如果这里随手写 Date.now()，那么"这个会话什么时候动过"就只存在索引里，
    // 索引一重建，列表排序就跟用户记忆里的顺序对不上了。
    seq: 0,
    time: session.updatedAt || session.createdAt || Date.now(),
    data: { system: session.systemPrompt, tools: [], model: session.model, reason: 'initial' },
  } as SessionEvent
}

// ─────────────────────────────────────────────────────────────
// 派生：状态、标题、读数

function coerceTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TodoItem => {
    if (!isRecord(item)) return false
    const status = item.status
    return typeof item.id === 'string' && typeof item.text === 'string'
      && (status === 'pending' || status === 'in_progress' || status === 'done')
  })
}

/**
 * 把"会话状态"（systemPrompt / todos / planMode / plan / allowlist）从日志里派生出来。
 *
 * 两类来源，优先级明确：
 *   · `request/header` → 系统提示词与模型名（原版也把当时渲染好的系统提示词记进日志，
 *     所以"这个会话用的是哪版 persona"是可查的，而不是靠猜）；
 *   · `session/state` → 状态快照（现在还没有人写，命中就用、没有就落回传入的默认）。
 */
function deriveState(events: readonly SessionEvent[], fallback?: Partial<Session>): Omit<Session, 'messages'> {
  const header = foldRequestHeader(events)
  const headerData = header === null ? null : header.data as RequestHeaderData

  let state: SessionState = { ...DEFAULT_STATE, todos: [...DEFAULT_STATE.todos], allowlist: [...DEFAULT_STATE.allowlist] }
  for (const event of events) {
    const data = asStateEventData(event)
    if (data === null) continue
    // 后写的覆盖先写的 —— 状态事件是快照，不是增量。
    state = {
      todos: coerceTodos(data.todos),
      planMode: data.planMode === true,
      ...(typeof data.plan === 'string' ? { plan: data.plan } : {}),
      allowlist: Array.isArray(data.allowlist)
        ? (data.allowlist.filter(item => typeof item === 'string') as string[])
        : [],
    }
  }

  // 标题：取日志里**最后一条** session/title（last-wins）。
  // 这样索引整份丢掉也能重建出用户改过的名字 —— 标题是内容，不是缓存。
  let foldedTitle: string | null = null
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const data = event.data as { title?: unknown }
    if (typeof data.title === 'string' && data.title !== '') foldedTitle = data.title
  }

  return {
    id: fallback?.id ?? '',
    title: foldedTitle ?? fallback?.title ?? '会话',
    createdAt: fallback?.createdAt ?? 0,
    updatedAt: fallback?.updatedAt ?? 0,
    model: headerData?.model !== undefined && headerData.model !== '' ? headerData.model : (fallback?.model ?? ''),
    systemPrompt: headerData !== null && headerData.system !== '' ? headerData.system : (fallback?.systemPrompt ?? ''),
    todos: state.todos,
    planMode: state.planMode,
    ...(state.plan !== undefined ? { plan: state.plan } : {}),
    allowlist: state.allowlist,
  }
}

/**
 * 最后一条**内容事件**的写入时间 —— 它是"这个会话最近动过"最诚实的读数。
 *
 * 刻意跳过 `session/title`：改个标题不该让会话跳到列表最前面，
 * 那个位置的含义是"最近聊过"。这是用户直觉问题，不是排序细节。
 */
function lastEventTime(events: readonly SessionEvent[], fallback: number): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'session/title') continue
    return typeof event.time === 'number' ? event.time : fallback
  }
  return fallback
}

/**
 * 列表页要的两件事：条数与可用性。
 *
 * 只读第一行拿版本号（不整份解析）—— 列表页要快，而"哪个会话不可用"只需要知道版本。
 */
function readProbe(port: FilePort, path: string): { formatVersion: number, messageCount: number } | null {
  const text = port.readText(path)
  if (text === null) return null
  const firstLine = text.split('\n').find(line => line.trim() !== '')
  if (firstLine === undefined) return null
  try {
    const parsed = JSON.parse(firstLine) as { formatVersion?: unknown }
    const lineCount = text.split('\n').filter(line => line.trim() !== '').length
    // 没声明版本 = 当前版本（与 parseLog 同一口径：两处各判一套必然有一天走偏）。
    const formatVersion = typeof parsed.formatVersion === 'number' ? parsed.formatVersion : SESSION_FORMAT_VERSION
    return { formatVersion, messageCount: lineCount }
  } catch {
    return null
  }
}

function isUnusable(probe: { formatVersion: number } | null): boolean {
  return probe === null || probe.formatVersion !== SESSION_FORMAT_VERSION
}

// ─────────────────────────────────────────────────────────────
// 存储本体

export function createSessionStore(port: FilePort, options?: { dir?: string }): SessionStore {
  const dir = options?.dir ?? 'dsh-store'
  const logsDir = `${dir}/logs`
  const indexPath = `${dir}/index.json`
  const backupPath = `${dir}/legacy-backup.json`

  const logPath = (id: string): string => `${logsDir}/${id}.jsonl`
  const listLogIds = (): string[] => port.list(logsDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))

  // ── 索引读写：索引是派生数据，读不出来就重建，不把损坏的索引喂给下游

  /**
   * 读索引；**读不出来返回 null**（而不是空数组）—— 这两件事必须分开：
   * "没有会话"和"索引坏了但有会话"是完全不同的处境，混在一起就会静默清空列表。
   */
  function readIndex(): SessionIndexEntry[] | null {
    const text = port.readText(indexPath)
    if (text === null) return null
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return null
      const entries: SessionIndexEntry[] = []
      const seen = new Set<string>()
      for (const raw of parsed) {
        const entry = coerceIndexEntry(raw)
        if (entry === null || seen.has(entry.id)) continue
        seen.add(entry.id)
        entries.push(entry)
      }
      return entries
    } catch {
      return null
    }
  }

  /** 索引写入失败一律抛出：这是 fail-closed 的后半截，调用方要能据此中止这一轮。 */
  function writeIndex(entries: SessionIndexEntry[]): void {
    try {
      port.ensureDir(dir)
      port.writeText(indexPath, JSON.stringify(entries))
    } catch (cause) {
      throw new SessionStoreError(`索引写入失败：${describeError(cause)}`, { cause })
    }
  }

  /**
   * 从日志重建索引（缺失、损坏、或需要修一条时的统一通路）。
   *
   * 每个会话都读第一行拿版本与条数，然后**逐条快照补进索引**：只读第一行会漏掉
   * 老日志里的标题与时间，而"重建出来的索引缺字段"是下一轮 bug 的种子。
   */
  function rebuildIndex(): SessionIndexEntry[] {
    const entries: SessionIndexEntry[] = []
    for (const id of listLogIds()) {
      const path = logPath(id)
      const probe = readProbe(port, path)
      if (probe === null) continue
      if (probe.formatVersion !== SESSION_FORMAT_VERSION) {
        // 版本不认的会话照样列出来，但标成不可用 —— 用户该看见"这里有个我打不开的会话"，
        // 而不是让它凭空消失（那才是真的数据丢失体验）。
        entries.push({
          id,
          title: id,
          createdAt: 0,
          updatedAt: 0,
          model: '',
          messageCount: probe.messageCount,
          formatVersion: probe.formatVersion,
          unusable: true,
        })
        continue
      }
      const loaded = (() => {
        try {
          return loadUnrepaired(id)
        } catch {
          // 单个会话的日志坏了（中间行损坏、或被别的写入方写花）时，只把它标成不可用。
          // 一个坏文件不该让整个会话列表打不开 —— 那是把局部损坏放大成全面不可用。
          return null
        }
      })()
      if (loaded === null) {
        // 读不出来但文件还在：列出来并标成不可用，让用户看见"这里有个我打不开的会话"，
        // 而不是让它凭空消失（那才是真的数据丢失体验）。
        entries.push({
          id,
          title: id,
          createdAt: 0,
          updatedAt: 0,
          model: '',
          messageCount: probe.messageCount,
          formatVersion: SESSION_FORMAT_VERSION,
          unusable: true,
        })
        continue
      }
      entries.push(entryFrom(id, loaded.log.all()))
    }
    // 只写盘、不吞错：重建结果必须落下去，否则每次 list() 都要重扫一遍。
    writeIndex(entries)
    return entries
  }

  function readIndexOrRebuild(): SessionIndexEntry[] {
    return readIndex() ?? rebuildIndex()
  }

  function upsertIndexEntry(entry: SessionIndexEntry): void {
    const entries = readIndexOrRebuild().filter(existing => existing.id !== entry.id)
    entries.push(entry)
    writeIndex(entries)
  }

  /**
   * 从日志算出一条索引条目。`fallback` 只在日志本身给不出信息时兜底
   * （比如老日志只有几条消息、没有请求信封，那就用迁移输入里的标题与时间）。
   */
  function entryFrom(id: string, events: readonly SessionEvent[], fallback?: Partial<Session>): SessionIndexEntry {
    const derived = deriveState(events, fallback)
    const last = lastEventTime(events, fallback?.updatedAt ?? 0)
    return {
      id,
      title: fallback?.title ?? derived.title,
      createdAt: fallback?.createdAt ?? derived.createdAt,
      updatedAt: last > 0 ? last : (fallback?.updatedAt ?? 0),
      model: derived.model !== '' ? derived.model : (fallback?.model ?? ''),
      messageCount: events.length,
      formatVersion: SESSION_FORMAT_VERSION,
    }
  }

  // ── 加载：解析 → 补合 → 派生

  /**
   * 只做"解析 + 补合"，**不碰索引**。
   *
   * 单独拆出来是因为重建索引时也要走它：重建既可能发生在 `load()` 里，也可能发生在
   * `list()` 里（索引坏了），两条路都不该各自实现一遍补合逻辑 —— 那种重复必然有一天走偏。
   */
  function loadUnrepaired(id: string): { log: SessionLog, recovered: SessionEvent[], events: readonly SessionEvent[] } | null {
    const path = logPath(id)
    const text = port.readText(path)
    if (text === null) return null

    const head = parseLog(text, id)
    if (head === null) return null

    let log = rehydrate(head.events)

    // 崩溃恢复：有 turn/start 没 turn/end（或有 step/start 没 step/end）就把它合上。
    // 不补的话，这个悬着的轮次下次会被当成"正在进行"，用户会看到一个永远转不完的圈。
    const closers = interruptedTurnClosers(log.all())
    const recovered: SessionEvent[] = []
    for (const closer of closers) {
      const validated = log.append(closer)
      // 落盘次序：这一行先写进日志，再更新索引。写日志失败就是失败，抛给调用方。
      try {
        port.appendLine(path, JSON.stringify(validated))
      } catch (cause) {
        throw new SessionStoreError(`会话 ${id} 的日志追加失败：${describeError(cause)}`, { cause })
      }
      recovered.push(validated)
    }

    return { log, recovered, events: log.all() }
  }

  function load(id: string): LoadedSession | null {
    const index = readIndexOrRebuild()
    let entry = index.find(item => item.id === id)
    if (entry === undefined) {
      // 索引是**派生数据**：可能丢、可能落后（比如上次索引写盘失败）。
      // 日志在就说明会话在，所以这里从日志补一条索引再加载，
      // 而不是因为"索引里没有"就告诉用户这个会话不存在 —— 那是把派生数据的缺失当成真相的缺失。
      // 注意：日志**损坏**时不能吞错，要把带行号的原因抛出去（"读不出来"和"没有这个会话"是两件事）。
      if (port.readText(logPath(id)) === null) return null
      const probe = loadUnrepaired(id)
      if (probe === null) return null
      const repaired = entryFrom(id, probe.events)
      upsertIndexEntry(repaired)
      entry = repaired
    }
    // 被标成不可用的会话：要给出**具体原因**（哪一行坏了 / 版本是多少），不能只回一个 null。
    // 所以这里不 catch —— 底层那句带行号的错误原样抛给调用方。
    // 反过来，如果日志其实读得出来（索引标错了），就当索引写错，继续往下正常加载：能自愈就别拦着。
    if (entry.unusable === true) {
      const probe = loadUnrepaired(id)
      if (probe === null) return null
    }
    if (entry.formatVersion !== SESSION_FORMAT_VERSION) return null

    const loaded = loadUnrepaired(id)
    if (loaded === null) return null

    // 索引里那份元数据（标题/时间/模型）以索引为准，缺的部分才从日志推。
    const fallback: Partial<Session> = {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      model: entry.model,
    }
    const derived = deriveState(loaded.events, fallback)
    const session: Session = {
      ...derived,
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: lastEventTime(loaded.events, entry.updatedAt),
      // **消息是派生结果**：改日志、重新 load，消息就跟着变。这里不存任何一份副本。
      messages: deriveMessages(loaded.events),
    }

    const unresolved = unresolvedToolCalls(loaded.events)

    if (loaded.recovered.length > 0) {
      // 补合改动了日志，索引的读数（条数/时间）必须跟着修正，否则列表页会一直显示旧数字。
      upsertIndexEntry({
        ...entry,
        updatedAt: session.updatedAt,
        messageCount: loaded.events.length,
        formatVersion: SESSION_FORMAT_VERSION,
      })
    }

    return { log: loaded.log, session, recovered: loaded.recovered, unresolved }
  }

  // ── 写入口

  /**
   * 唯一的写入口：逐个校验 → 逐行落盘 → 最后更新索引。
   *
   * `log.append()` 会把不合法的事件当场拒掉（seq 有洞、未知类型、surface 元数据不对），
   * 所以在写盘之前就能确定"这一批事件是自洽的"。落盘时**每写一行就追一次索引**：
   * 崩在第 5 行时索引只是落后，不会出现"索引说写了、日志里没有"。
   */
  function append(id: string, events: Array<Omit<SessionEvent, 'seq'>>): void {
    if (events.length === 0) return
    // 先确认这个会话真的有日志：往不存在的会话写事件是调用方的 bug，
    // 静默造一个空日志出来只会把 bug 埋起来。
    const loaded = loadUnrepaired(id)
    if (loaded === null) throw new SessionStoreError(`会话 ${id} 不存在或日志不可读，拒绝写入`)

    const log = loaded.log
    const path = logPath(id)
    let entries = readIndexOrRebuild()
    const existing = entries.find(item => item.id === id)
    const base: SessionIndexEntry = existing ?? {
      id,
      title: '会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: '',
      messageCount: log.length,
      formatVersion: SESSION_FORMAT_VERSION,
    }
    let count = log.length
    let updatedAt = lastEventTime(log.all(), base.updatedAt)

    for (const event of events) {
      const validated = log.append(event)
      try {
        port.appendLine(path, JSON.stringify(validated))
      } catch (cause) {
        throw new SessionStoreError(`会话 ${id} 的日志追加失败：${describeError(cause)}`, { cause })
      }
      count += 1
      updatedAt = lastEventTime([validated], updatedAt)
      // 日志行已经落地，索引必须跟上 —— 索引写失败算这一轮失败（fail-closed）。
      entries = entries.filter(item => item.id !== id)
      entries.push({ ...base, updatedAt, messageCount: count, formatVersion: SESSION_FORMAT_VERSION })
      writeIndex(entries)
    }
  }

  // ── 其余操作

  function create(session: Session): LoadedSession {
    const path = logPath(session.id)
    port.ensureDir(logsDir)

    // 第一行必须是请求信封：把"这个会话当时用的系统提示词与模型"钉在日志里。
    // 这样即便索引丢了，标题/模型/systemPrompt 也能从日志推回来，persona 是哪一版永远可查。
    //
    // 信封走 `serializeEvent()` 而不是手拼对象 —— 手拼出来的信封会漏掉 `seq`，
    // 而"第一行 seq 缺失"在下一次加载时正好是"seq 必须是 0"的那条报错。
    const header = headerEvent(session)

    try {
      port.writeText(path, serializeEvent(header))
    } catch (cause) {
      throw new SessionStoreError(`会话 ${session.id} 创建失败：${describeError(cause)}`, { cause })
    }

    const entries = readIndexOrRebuild().filter(item => item.id !== session.id)
    entries.push({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      messageCount: 1,
      formatVersion: SESSION_FORMAT_VERSION,
    })
    writeIndex(entries)

    const loaded = load(session.id)
    if (loaded === null) throw new SessionStoreError(`会话 ${session.id} 刚创建就读不出来`)
    return loaded
  }

  function rename(id: string, title: string): void {
    const path = logPath(id)
    if (port.readText(path) === null) throw new SessionStoreError(`会话 ${id} 不存在，无法改名`)
    // 标题**先写进日志**，再更新索引。
    // 这一步是被真实缺陷逼出来的：早先标题只存在索引里，而索引是派生数据 ——
    // 一旦重建（索引丢失、损坏、或日志从备份恢复），用户改过的标题就没了。
    // 原版的做法正是把标题也写成会话事件（session-title，last-wins），这里对齐。
    const loaded = loadUnrepaired(id)
    if (loaded === null) throw new SessionStoreError(`会话 ${id} 的日志不可读，无法改名`)
    const validated = loaded.log.append({
      type: 'session/title', time: Date.now(), data: { title },
    } as Omit<SessionEvent, 'seq'>)
    try {
      port.appendLine(path, JSON.stringify(validated))
    } catch (cause) {
      throw new SessionStoreError(`会话 ${id} 的标题写入失败：${describeError(cause)}`, { cause })
    }

    const entries = readIndexOrRebuild()
    const entry = entries.find(item => item.id === id)
    if (entry === undefined) return
    // 改名不动 updatedAt：它衡量的是"这个会话的内容最近动过没有"，
    // 否则列表里一改标题就跳到最前面，与"最近聊过"这个直觉不符。
    upsertIndexEntry({ ...entry, title, messageCount: entry.messageCount + 1 })
  }

  function remove(id: string): void {
    const path = logPath(id)
    if (port.exists(path)) {
      try {
        port.remove(path)
      } catch (cause) {
        throw new SessionStoreError(`会话 ${id} 的日志删除失败：${describeError(cause)}`, { cause })
      }
    }
    // 先删日志再删索引条目：万一崩在中间，剩下的是"索引里有一条、日志没了"，
    // 加载时返回 null（可自愈）；反过来则是"日志还在、索引没了"，会重建出一个幽灵会话。
    const entries = readIndexOrRebuild().filter(item => item.id !== id)
    writeIndex(entries)
  }

  /**
   * 列表：**索引必须和日志目录对账**。
   *
   * 索引是派生数据，可能落后（上次写盘失败）、可能缺失（日志被从备份恢复回来）、
   * 也可能多出已经不存在的条目。所以这里不是"读索引就完事"，而是先看一眼日志目录里到底有哪些会话 ——
   * 对不上就重建。少了这一步，症状是"会话明明在磁盘上，列表里却没有"，
   * 而这是最容易被当成"数据丢了"的那种 bug。
   */
  function list(): SessionIndexEntry[] {
    // 干脆每次都从日志重建：索引只是缓存，日志才是真相。
    // 代价是 O(会话数) 次小文件读 —— 对个人使用的量级完全可接受；
    // 换来的是"列表永远和磁盘一致"，不会出现"日志在、列表里没有"这种最像数据丢失的症状。
    return rebuildIndex().sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * 老格式迁移：`sessions.json` 里的 `messages: ChatMessage[]` → 每会话一份事件日志。
   *
   * 三个要点：
   *   · **幂等**：日志文件已存在就跳过这个会话（`skipped`），所以重复跑不会写重、不会写花；
   *   · **先写日志、最后写索引**：崩在中途的话，下次重跑看日志就知道哪些已经迁过；
   *   · **`system` 消息自然变成 `request/header`** —— `appendMessageEvent()` 就是这么定的，
   *     于是老会话的系统提示词不会丢。
   */
  function migrateLegacy(legacy: Session[], options?: { keepBackup?: boolean }): { migrated: number, skipped: number } {
    if (options?.keepBackup === true) {
      // 备份的是原始 JSON 原文（不是被规范化过的对象）：迁移出问题时要能拿回一模一样的输入。
      try {
        port.ensureDir(dir)
        port.writeText(backupPath, JSON.stringify(legacy, null, 0))
      } catch (cause) {
        throw new SessionStoreError(`旧格式备份写入失败：${describeError(cause)}`, { cause })
      }
    }

    let migrated = 0
    let skipped = 0
    const entries = readIndexOrRebuild()

    for (const legacySession of legacy) {
      const id = legacySession.id
      if (typeof id !== 'string' || id === '') {
        // 没有 id 的会话无处安放，也算跳过 —— 但别静默：计数里能看出来。
        skipped += 1
        continue
      }
      const path = logPath(id)
      if (port.exists(path)) {
        skipped += 1
        continue
      }

      // 用真正的 SessionLog 收敛消息 → 事件：seq 连续性、surface 元数据这些校验一次都不省。
      const log = new SessionLog()
      for (const message of (legacySession.messages ?? []) as ChatMessage[]) {
        try {
          appendMessageEvent(log, message)
        } catch (cause) {
          throw new SessionStoreError(`会话 ${id} 迁移失败（消息 ${message.id}）：${describeError(cause)}`, { cause })
        }
      }
      if (log.length === 0) {
        // 一条消息都没有的老会话：也得有一行 header，否则日志读不出格式版本。
        log.append({
          type: 'request/header',
          time: legacySession.createdAt,
          data: { system: legacySession.systemPrompt, tools: [], model: legacySession.model, reason: 'initial' },
        } as Omit<SessionEvent, 'seq'>)
      }

      const text = log.all().map(event => JSON.stringify(event)).join('\n')
      try {
        port.ensureDir(logsDir)
        port.writeText(path, `${text}\n`)
      } catch (cause) {
        throw new SessionStoreError(`会话 ${id} 迁移写入失败：${describeError(cause)}`, { cause })
      }
      migrated += 1
    }

    // 索引放在最后统一写一次：中途崩了不会留下"索引说有、日志没有"的会话。
    const merged = entries.filter(entry => !legacy.some(session => session.id === entry.id))
    for (const legacySession of legacy) {
      if (typeof legacySession.id !== 'string' || legacySession.id === '') continue
      if (!port.exists(logPath(legacySession.id))) continue
      const loaded = loadUnrepaired(legacySession.id)
      if (loaded === null) continue
      merged.push(entryFrom(legacySession.id, loaded.events, legacySession))
    }
    writeIndex(merged)

    return { migrated, skipped }
  }

  return { list, load, create, append, rename, remove, migrateLegacy }
}
