/** Agent 的数据形状。刻意贴近 OpenAI 的 messages 契约 —— DeepSeek 走的就是这套。 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 助手消息上的工具调用（流式里是按 index 分片拼出来的）。 */
export type ToolCall = {
  id: string
  name: string
  /** 原始 JSON 字符串，由模型产出；执行前才解析。 */
  arguments: string
}

export type ChatMessage = {
  id: string
  role: Role
  text: string
  /** deepseek-reasoner 的思考过程，单独一块渲染，不进上下文。 */
  reasoning?: string
  toolCalls?: ToolCall[]
  /** role === 'tool' 时指向哪个调用。 */
  toolCallId?: string
  toolName?: string
  /** 工具执行失败时置位，界面上标红。 */
  failed?: boolean
  /**
   * 压缩摘要。以 user 身份承载（和 DSH 一样：摘要骑在一条 user 消息上替换旧区间），
   * 界面按卡片渲染，不当普通用户气泡。
   */
  summary?: boolean
  /** 工具结果被裁剪过（只留头部），用于界面标注"这里被裁过"。 */
  pruned?: boolean
  createdAt: number
}

/** 待办项。状态机只有三态，跟 DSH 的 todo 一致。 */
export type TodoItem = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  model: string
  /** 本会话的系统提示词快照 —— 换预设不影响已有会话。 */
  systemPrompt: string
  todos: TodoItem[]
  /** 计划模式：只规划不执行（写操作会被挡） */
  planMode: boolean
  /** 退出计划模式时产出的计划文本 */
  plan?: string
  /** 本会话内"总是允许"的工具名 */
  allowlist: string[]
}

/** 工具对用户数据的影响面 —— 审批策略按它分级。 */
export type ToolRisk = 'read' | 'write' | 'danger'

/** 工具执行时可以够到的东西：问用户、改会话状态、请人批计划、起子代理。 */
export type ToolContext = {
  ask: (request: AskRequest) => Promise<string>
  state: SessionState
  approvePlan: (plan: string) => Promise<boolean>
  /** 起一个子代理跑独立任务。由 App 注入（子代理要复用模型配置与工具面）。 */
  spawnSubagent: (task: string, options?: { maxSteps?: number }) => Promise<SubagentReport>
}

/** 子代理的交付：结论 + 它烧了多少步。 */
export type SubagentReport = {
  ok: boolean
  text: string
  steps: number
  toolCalls: number
  error?: string
}

/** 工具能改的会话状态（循环负责落盘）。 */
export type SessionState = {
  todos: TodoItem[]
  planMode: boolean
  plan?: string
  allowlist: string[]
}

export type AskRequest = {
  question: string
  /** 可选选项；为空表示让用户自由输入。 */
  options?: string[]
}

export type ApprovalRequest = {
  toolName: string
  risk: ToolRisk
  /** 给用户看的参数摘要（已格式化）。 */
  detail: string
  /** 请求方：主循环，还是某个子代理（界面上要标出来，不然用户不知道谁在要权限）。 */
  origin?: string
}

export type ApprovalDecision = 'allow' | 'always' | 'deny'

export type ApprovalMode = 'auto' | 'write' | 'all'

export type ToolSpec = {
  name: string
  description: string
  /** JSON Schema（OpenAI function 参数格式）。 */
  parameters: Record<string, unknown>
  risk: ToolRisk
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<string>
}

export type LlmConfig = {
  apiKey: string
  /** 例：https://api.deepseek.com */
  baseUrl: string
  model: string
  temperature: number
}

/** 流式增量。deepseek-reasoner 的思考内容走 reason，正文走 text。 */
export type StreamChunk =
  | { type: 'text', text: string }
  | { type: 'reasoning', text: string }
  | { type: 'tool-call', index: number, id?: string, name?: string, argsDelta?: string }
  | { type: 'usage', promptTokens?: number, completionTokens?: number }

export type StreamRequest = {
  config: LlmConfig
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
}

/**
 * agent 循环只认这个函数形状，不认具体实现。
 * 好处有三：循环能在 Node 里用假流跑测试；压缩摘要复用同一条通路；换供应商不用动循环。
 */
export type StreamFn = (request: StreamRequest) => AsyncGenerator<StreamChunk>
