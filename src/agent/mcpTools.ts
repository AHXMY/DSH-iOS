/**
 * 把 MCP 服务器接进工具面。
 *
 * 这是 iOS 上性价比最高的一次能力扩张：起不了本地 MCP 进程（stdio 用不了），
 * 但 streamable-http 的 MCP 完全能连 —— 一次实现，接上整个远程 MCP 生态。
 * 工具名照桌面 DSH 的约定：`mcp__<服务器>__<工具>`。
 *
 * 两个刻意的决定：
 *
 * 1. **审批风险用名字猜**。MCP 工具的影响面对我们是未知的（描述里写什么都有），
 *    所以按动词保守推断：含删除语义的一律 danger，明显只读的才放 read，其余全按 write。
 *    猜错的代价只是多问一次用户；反过来（把写当读放过去）代价是数据没了。
 * 2. **一台连不上不影响其它**。连接失败只记在 failures 里，工具面照常组装 ——
 *    因为 MCP 服务器是别人家的服务，随时可能挂，不能让它拖死整个 agent。
 */
import { McpClient, mcpToolName } from './mcp'
import { parseMcpEntries } from './mcpConfig'
import type { ToolRisk, ToolSpec } from './types'

/** 只读动词：出现在工具名开头才认。 */
const READ_VERBS = /^(get|list|read|search|fetch|query|describe|show|find|lookup|info|status|health|head|peek)/
/** 不可逆动词：只要出现就按最重的算。 */
const DESTRUCTIVE_VERBS = /(delete|remove|drop|destroy|truncate|purge|kill|terminate|uninstall|revoke)/
/** 会改动东西的动词。 */
const WRITE_VERBS = /(write|create|update|set|put|post|patch|insert|upsert|exec|run|install|move|rename|copy|upload|send|publish|apply|submit|enable|disable|start|stop|restart)/

/**
 * 按工具名推断影响面。
 *
 * 名字先切词再判：`fs.read_file` / `read-file` / `readFile` 都该认得出来。
 */
export function classifyMcpRisk(toolName: string): ToolRisk {
  const words = toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '')
  const flat = words.join('-')

  if (DESTRUCTIVE_VERBS.test(flat)) return 'danger'
  // 只读判定要"从头就是只读动词，且通篇没有写动作" —— `read_and_delete` 不算只读。
  if (READ_VERBS.test(flat) && !WRITE_VERBS.test(flat)) return 'read'
  return 'write'
}

export type McpConnectedServer = {
  name: string
  serverName: string
  serverVersion: string
  toolCount: number
}

export type McpFailure = {
  name: string
  message: string
}

export type McpRegistration = {
  connected: McpConnectedServer[]
  failures: McpFailure[]
  tools: ToolSpec[]
  /** 断开所有连接（换配置或退出时调用） */
  close: () => void
}

const EMPTY: McpRegistration = { connected: [], failures: [], tools: [], close: () => {} }

/**
 * 连上配置里的所有 MCP 服务器，把它们的工具变成 ToolSpec。
 *
 * 连接是并发的：五台服务器串行连会让人以为 App 卡住了。
 */
export async function connectMcpServers(
  lines: string,
  options: { signal?: AbortSignal } = {},
): Promise<McpRegistration> {
  const trimmed = lines.trim()
  if (trimmed === '') return EMPTY

  let entries
  try {
    entries = parseMcpEntries(lines)
  } catch (cause) {
    return { connected: [], failures: [{ name: '配置', message: cause instanceof Error ? cause.message : String(cause) }], tools: [], close: () => {} }
  }
  if (entries.length === 0) return EMPTY

  const clients = new Map<string, McpClient>()

  const results = await Promise.all(entries.map(async entry => {
    const client = new McpClient({
      name: entry.name,
      url: entry.url,
      headers: entry.token === undefined ? undefined : { authorization: `Bearer ${entry.token}` },
    })
    clients.set(entry.name, client)
    try {
      const connected = await client.connect(options.signal)
      return { entry, client, connected, error: null as string | null }
    } catch (cause) {
      return { entry, client, connected: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }))

  const tools: ToolSpec[] = []
  const connectedServers: McpConnectedServer[] = []
  const failures: McpFailure[] = []

  for (const result of results) {
    if (result.connected === null) {
      failures.push({ name: result.entry.name, message: result.error ?? '连接失败' })
      clients.delete(result.entry.name)
      continue
    }

    connectedServers.push({
      name: result.entry.name,
      serverName: result.connected.serverName,
      serverVersion: result.connected.serverVersion,
      toolCount: result.connected.tools.length,
    })

    for (const descriptor of result.connected.tools) {
      const fullName = mcpToolName(result.entry.name, descriptor.name)
      tools.push({
        name: fullName,
        // 说明里带来源：模型要能看出来这个工具是"别人家服务器上的"，而不是手机本地的。
        description: `[MCP ${result.entry.name}] ${descriptor.description === '' ? '（无说明）' : descriptor.description}`,
        parameters: descriptor.inputSchema,
        risk: classifyMcpRisk(descriptor.name),
        async run(args) {
          const outcome = await result.client.callTool(descriptor.name, args, options.signal)
          // 服务端说这是错误，就按错误交回循环：界面标红，模型也能据此改做法。
          if (outcome.isError) throw new Error(outcome.text === '' ? 'MCP 工具报告了一个错误' : outcome.text)
          return outcome.text === '' ? '（MCP 工具没有任何输出）' : outcome.text
        },
      })
    }
  }

  return {
    connected: connectedServers,
    failures,
    tools,
    close: () => {
      for (const client of clients.values()) {
        try {
          client.close()
        } catch {
          // 断开失败无所谓：进程是手机的，连接会自己烂掉。
        }
      }
      clients.clear()
    },
  }
}

/** 给界面/提示词用的一句话摘要。 */
export function describeMcpRegistration(registration: McpRegistration): string {
  if (registration.connected.length === 0 && registration.failures.length === 0) return '没有配置 MCP 服务器'
  const ok = registration.connected.map(server => `${server.name}(${server.toolCount} 个工具)`).join('、')
  const bad = registration.failures.map(failure => `${failure.name}（${failure.message}）`).join('、')
  const parts: string[] = []
  if (ok !== '') parts.push(`已连上：${ok}`)
  if (bad !== '') parts.push(`连不上：${bad}`)
  return parts.join('；')
}
