/**
 * 会话检索与导出（纯逻辑，可测）。
 *
 * 手机上会话一多，"上次让它干的活在哪"就成了真问题 —— 桌面版 DSH 有 session-query
 * 那一套（SQLite FTS + 事件检索）。手机上没必要上数据库：会话本来就是本地 JSON，
 * 直接扫就够快，而且少一个依赖少一处不一致。
 *
 * 中文不做分词：子串匹配对中文反而更准（"周报" 就该命中 "写周报"），
 * 分词错了会漏。代价是查英文时不如倒排索引聪明 —— 但会话量级根本用不着。
 */
import type { ChatMessage, Role, Session } from './types'

export type SearchHit = {
  sessionId: string
  title: string
  messageId: string
  role: Role | 'title'
  /** 命中处周围的片段 */
  snippet: string
  /** 命中位置（用于排序：标题命中权重更高） */
  score: number
  at: number
}

const SNIPPET_RADIUS = 28

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return `${head}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${tail}`
}

/** 一条消息里所有可被搜到的地方（正文优先，工具结果也算）。 */
function searchableText(message: ChatMessage): string {
  const parts = [message.text]
  if (message.reasoning !== undefined) parts.push(message.reasoning)
  for (const call of message.toolCalls ?? []) parts.push(`${call.name} ${call.arguments}`)
  return parts.join('\n')
}

export function searchSessions(sessions: Session[], query: string, limit = 40): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const hits: SearchHit[] = []

  for (const session of sessions) {
    const titleAt = session.title.toLowerCase().indexOf(needle)
    if (titleAt !== -1) {
      hits.push({
        sessionId: session.id,
        title: session.title,
        messageId: session.id,
        role: 'title',
        snippet: session.title,
        // 标题命中给足权重：用户想找的多半是自己起过的名字。
        score: 1000 + session.updatedAt / 1e12,
        at: session.updatedAt,
      })
    }

    for (const message of session.messages) {
      const haystack = searchableText(message).toLowerCase()
      const at = haystack.indexOf(needle)
      if (at === -1) continue
      hits.push({
        sessionId: session.id,
        title: session.title,
        messageId: message.id,
        role: message.role,
        snippet: snippetAround(searchableText(message), at, needle.length),
        score: 100 + message.createdAt / 1e12,
        at: message.createdAt,
      })
    }
  }

  return hits.sort((left, right) => right.score - left.score).slice(0, limit)
}

function stamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function roleLabel(role: Role): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'DSH'
  if (role === 'tool') return '工具'
  return '系统'
}

/**
 * 导出成 Markdown。
 *
 * 取舍：工具调用与结果**要保留**（否则复盘时看不见它做了什么），但旧工具结果
 * 已经被裁剪过就照实写"已裁剪" —— 导出的是真实经过，不是美化过的样子。
 */
export function sessionToMarkdown(session: Session): string {
  const lines: string[] = [
    `# ${session.title}`,
    '',
    `- 模型：${session.model}`,
    `- 创建：${stamp(session.createdAt)}`,
    `- 更新：${stamp(session.updatedAt)}`,
    `- 消息：${session.messages.length} 条`,
  ]
  if (session.plan !== undefined && session.plan !== '') lines.push(`- 计划：见下方引用`)
  lines.push('', '---', '')

  for (const message of session.messages) {
    if (message.summary === true) {
      lines.push('> **【历史摘要】**', '>', ...message.text.split('\n').map(line => `> ${line}`), '')
      continue
    }

    if (message.role === 'tool') {
      const label = `工具结果 · ${message.toolName ?? '未知工具'}${message.failed === true ? '（失败）' : ''}`
      lines.push(`<details><summary>${label}</summary>`, '', '```', message.text, '```', '', '</details>', '')
      continue
    }

    lines.push(`### ${roleLabel(message.role)} · ${stamp(message.createdAt)}`, '')
    if (message.reasoning !== undefined && message.reasoning !== '') {
      lines.push('<details><summary>思考过程</summary>', '', message.reasoning, '', '</details>', '')
    }
    if (message.text !== '') lines.push(message.text, '')
    for (const call of message.toolCalls ?? []) {
      lines.push(`调用工具 \`${call.name}\`：`, '', '```json', call.arguments === '' ? '{}' : call.arguments, '```', '')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

/** 文件名：标题里不能有路径分隔符，也不能太长。 */
export function exportFileName(session: Session): string {
  const safe = session.title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
  const date = new Date(session.updatedAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${safe === '' ? 'session' : safe}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.md`
}
