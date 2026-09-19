/**
 * MCP 服务器的配置解析（纯字符串，可测）。
 *
 * 手机上不适合做复杂的配置表单，所以用最直白的一行一台服务器的写法：
 *
 *   name url [token]
 *   fs  https://mcp.example.com/mcp  sk-xxxx
 *   docs http://127.0.0.1:3000/mcp
 *
 * `#` 开头的行是注释。名字必须是 kebab-case —— 它会变成工具名前缀 mcp__<name>__<tool>，
 * 而工具名会被模型直接看到，脏名字会污染整份工具清单。
 */
import { SKILL_NAME_PATTERN } from './skillFormat'

export type McpServerEntry = {
  name: string
  url: string
  token?: string
}

export function parseMcpEntries(text: string): McpServerEntry[] {
  const entries: McpServerEntry[] = []
  const seen = new Set<string>()

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const [name, url, token] = parts
    if (name === undefined || url === undefined) {
      throw new Error(`这一行不完整（需要 name 和 url）：${line}`)
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`服务器名必须是 kebab-case（小写字母数字与短横线）：${name}`)
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`url 必须是 http(s) 地址：${url}`)
    }
    if (seen.has(name)) {
      throw new Error(`服务器名重复：${name}`)
    }
    seen.add(name)
    entries.push(token === undefined || token === '' ? { name, url } : { name, url, token })
  }

  return entries
}

export function formatMcpEntries(entries: McpServerEntry[]): string {
  return entries.map(entry => [entry.name, entry.url, entry.token ?? ''].filter(part => part !== '').join(' ')).join('\n')
}
