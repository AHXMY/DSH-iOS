/**
 * 会话与配置的本地存储。
 *
 * 全在 App 沙盒里，不经过任何服务器 —— 这是"iOS 上自己跑"的另一半含义：
 * 会话记录属于这台手机。数据量小（纯 JSON），一次性落盘足够，
 * 所以没有引入 SQLite 这类依赖。
 */
import * as SecureStore from 'expo-secure-store'
import { Directory, File, Paths } from 'expo-file-system'
import type { ApprovalMode, ChatMessage, Session } from '../agent/types'

const SESSIONS_FILE = 'sessions.json'
const CONFIG_KEY = 'dsh.ios.llm.v1'
/** 单会话最多保留的消息条数，避免 JSON 无限膨胀。 */
const MAX_MESSAGES = 200

export type Preset = {
  id: string
  name: string
  summary: string
  systemPrompt: string
}

const TOOL_NOTE = `
你运行在一台 iPhone 上：没有 shell、没有 git、没有网络服务器，能用的只有下面这些工具。
工作区是 App 沙盒里的 workspace 目录，路径一律用相对路径。
需要算数就用 calc，需要今天的日期就用 get_time，不要凭记忆猜。`

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'assistant',
    name: '通用助理',
    summary: '先给结论，再给理由；一次只问一个最关键的问题',
    systemPrompt: `你是 DSH 的手机端助手。回答直接、具体、不绕弯：先给结论，再给必要细节，不铺垫背景、不重复用户的话。${TOOL_NOTE}`,
  },
  {
    id: 'engineer',
    name: '严谨工程师',
    summary: '先看现状再动手，给可验证的结果',
    systemPrompt: `你是严谨的工程助手。任何结论都要能验证：先确认现状（读文件、查时间、算数都走工具），再给判断，明确区分"已验证"和"推测"。写文件时给出完整路径与内容要点。${TOOL_NOTE}`,
  },
  {
    id: 'organizer',
    name: '资料整理',
    summary: '把口述变成结构化的笔记、清单与待办',
    systemPrompt: `你负责把零散信息整理成可用的资料：笔记、清单、待办、摘要。默认落成文件（write_file 写到 workspace 里），文件名用英文短横线。整理完用三行以内说明放了什么、在哪、怎么用。${TOOL_NOTE}`,
  },
]

export const DEFAULT_PRESET = BUILTIN_PRESETS[0] as Preset

export type LlmSettings = {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  presetId: string
  systemPrompt: string
  /** 工具审批策略：auto 全放行 / write 写操作问 / all 每次都问 */
  approvalMode: ApprovalMode
  /** 上下文预算（估算 token），超过就压缩 */
  contextBudget: number
  /** 远程执行代理：填了才会多出 bash / 沙箱文件工具 */
  sandboxUrl: string
  sandboxToken: string
  /** MCP 服务器配置（每行一台：name url [token]） */
  mcpLines: string
  /** 联网搜索供应商：与原版 DSH 的 provider 家族对齐（deepseek / exa / perplexity），外加自建 */
  searchProvider: 'off' | 'deepseek' | 'self' | 'exa' | 'perplexity'
  searchBaseUrl: string
  searchModel: string
  /** 自建搜索代理（server/search-agent.mjs） */
  searchAgentUrl: string
  searchAgentToken: string
  searchEngine: 'bing' | 'sogou'
  /** 第三方 provider 的 key（原版那几家的线格式我们已经对齐） */
  exaApiKey: string
  perplexityApiKey: string
}

export const DEFAULT_SETTINGS: LlmSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  temperature: 0.7,
  presetId: DEFAULT_PRESET.id,
  systemPrompt: DEFAULT_PRESET.systemPrompt,
  approvalMode: 'write',
  // 模型窗口通常是 64k，留足输出与工具 schema 的余量；压缩在超预算时才触发。
  contextBudget: 24_000,
  sandboxUrl: '',
  sandboxToken: '',
  mcpLines: '',
  // DeepSeek 没有独立搜索端点，它的原生搜索走 Anthropic 兼容的 Messages API。
  // 端点与模型名都给好默认值，用户只需要决定开不开。
  searchProvider: 'off',
  searchBaseUrl: 'https://api.deepseek.com/anthropic/v1',
  searchModel: 'deepseek-v4-flash',
  // 自建搜索代理：跑在你自己机器上，不依赖任何第三方搜索 API。
  // 默认引擎选 bing 是有实测依据的：这张网络里 DuckDuckGo / Brave / 360 全部直接超时。
  searchAgentUrl: '',
  searchAgentToken: '',
  searchEngine: 'bing',
  exaApiKey: '',
  perplexityApiKey: '',
}

export const CONTEXT_BUDGET_CHOICES = [12_000, 24_000, 48_000] as const

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  auto: '全部放行',
  write: '写操作问一次',
  all: '每个工具都问',
}

function documentsDirectory(): Directory {
  return new Directory(Paths.document)
}

function sessionsFile(): File {
  return new File(documentsDirectory(), SESSIONS_FILE)
}

/** Key 进 Keychain，其余进普通文件：key 是机密，模型名不是。 */
export async function loadSettings(): Promise<LlmSettings> {
  const raw = await SecureStore.getItemAsync(CONFIG_KEY)
  if (raw === null) return DEFAULT_SETTINGS
  try {
    const parsed = JSON.parse(raw) as Partial<LlmSettings>
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl !== '' ? parsed.baseUrl : DEFAULT_SETTINGS.baseUrl,
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : DEFAULT_SETTINGS.model,
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : DEFAULT_SETTINGS.temperature,
      presetId: typeof parsed.presetId === 'string' ? parsed.presetId : DEFAULT_SETTINGS.presetId,
      systemPrompt: typeof parsed.systemPrompt === 'string' && parsed.systemPrompt !== ''
        ? parsed.systemPrompt
        : DEFAULT_SETTINGS.systemPrompt,
      approvalMode: parsed.approvalMode === 'auto' || parsed.approvalMode === 'all' || parsed.approvalMode === 'write'
        ? parsed.approvalMode
        : DEFAULT_SETTINGS.approvalMode,
      contextBudget: typeof parsed.contextBudget === 'number' && parsed.contextBudget >= 4_000
        ? parsed.contextBudget
        : DEFAULT_SETTINGS.contextBudget,
      sandboxUrl: typeof parsed.sandboxUrl === 'string' ? parsed.sandboxUrl : '',
      sandboxToken: typeof parsed.sandboxToken === 'string' ? parsed.sandboxToken : '',
      mcpLines: typeof parsed.mcpLines === 'string' ? parsed.mcpLines : '',
      searchProvider: parsed.searchProvider === 'deepseek' || parsed.searchProvider === 'self'
        || parsed.searchProvider === 'exa' || parsed.searchProvider === 'perplexity'
        ? parsed.searchProvider
        : 'off',
      searchBaseUrl: typeof parsed.searchBaseUrl === 'string' && parsed.searchBaseUrl !== ''
        ? parsed.searchBaseUrl
        : DEFAULT_SETTINGS.searchBaseUrl,
      searchModel: typeof parsed.searchModel === 'string' && parsed.searchModel !== ''
        ? parsed.searchModel
        : DEFAULT_SETTINGS.searchModel,
      searchAgentUrl: typeof parsed.searchAgentUrl === 'string' ? parsed.searchAgentUrl : '',
      searchAgentToken: typeof parsed.searchAgentToken === 'string' ? parsed.searchAgentToken : '',
      searchEngine: parsed.searchEngine === 'sogou' ? 'sogou' : 'bing',
      exaApiKey: typeof parsed.exaApiKey === 'string' ? parsed.exaApiKey : '',
      perplexityApiKey: typeof parsed.perplexityApiKey === 'string' ? parsed.perplexityApiKey : '',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(settings: LlmSettings): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(settings))
}

/** 老版本存的会话没有待办/计划模式这些字段，读的时候补齐，别让升级把历史弄丢。 */
function normalizeSession(raw: Partial<Session> & { id: string }): Session {
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : '会话',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : DEFAULT_SETTINGS.model,
    systemPrompt: typeof raw.systemPrompt === 'string' && raw.systemPrompt !== ''
      ? raw.systemPrompt
      : DEFAULT_SETTINGS.systemPrompt,
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    planMode: raw.planMode === true,
    plan: typeof raw.plan === 'string' ? raw.plan : undefined,
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist : [],
  }
}

export function loadSessions(): Session[] {
  const file = sessionsFile()
  if (!file.exists) return []
  try {
    const parsed = JSON.parse(file.textSync()) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as (Partial<Session> & { id: string })[])
      .filter(item => typeof item?.id === 'string')
      .map(normalizeSession)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  } catch {
    return []
  }
}

export function saveSessions(sessions: Session[]): void {
  const file = sessionsFile()
  if (!file.exists) file.create()
  file.write(JSON.stringify(sessions, null, 0))
}

export function newSession(settings: LlmSettings): Session {
  const now = Date.now()
  return {
    id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    todos: [],
    planMode: false,
    allowlist: [],
  }
}

/** 首条用户消息即标题 —— 手机上没地方给你慢慢起名字。 */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  const clean = line.replace(/\s+/g, ' ').trim()
  if (clean === '') return '新会话'
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean
}

export function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length <= MAX_MESSAGES ? messages : messages.slice(messages.length - MAX_MESSAGES)
}
