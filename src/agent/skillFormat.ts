/**
 * 技能的文件格式（与桌面 DSH 一致的那一层）。
 *
 * 只做纯字符串处理：frontmatter、名字规范化、渲染回 Markdown。
 * 落盘/读盘在 store/skills.ts，这样这一层能在 Node 里验证格式兼容性。
 */

export type Skill = {
  name: string
  description: string
  body: string
  modelInvocable: boolean
  userInvocable: boolean
  source: 'builtin' | 'file'
}

/** DSH 的约束：kebab-case。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slugifySkillName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return SKILL_NAME_PATTERN.test(slug) ? slug : `skill-${Math.random().toString(36).slice(2, 6)}`
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.replace(/^["']|["']$/g, '').trim().toLowerCase()
  if (['false', 'no', '0', 'off'].includes(normalized)) return false
  if (['true', 'yes', '1', 'on'].includes(normalized)) return true
  return fallback
}

/** 只认最朴素的 `key: value` frontmatter —— 引一整个 YAML 解析器不值当。 */
export function parseSkillMarkdown(text: string, fallbackName: string): Skill {
  const frontmatter: Record<string, string> = {}
  let body = text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)

  if (match !== null) {
    body = text.slice(match[0].length)
    for (const line of (match[1] ?? '').split('\n')) {
      const pair = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (pair !== null) frontmatter[pair[1] as string] = (pair[2] ?? '').trim()
    }
  }

  // 没有 name 就用第一个标题兜底，让"直接粘一份 Markdown"也能成技能。
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? ''
  const name = slugifySkillName(frontmatter.name ?? fallbackName ?? heading)
  const description = frontmatter.description
    ?? body.replace(/^#.*$/m, '').trim().split('\n').find(line => line.trim() !== '')?.trim()
    ?? '（无说明）'

  return {
    name,
    description: description.slice(0, 200),
    body: body.trim(),
    modelInvocable: !parseBoolean(frontmatter['disable-model-invocation'], false),
    userInvocable: parseBoolean(frontmatter['user-invocable'], true),
    source: 'file',
  }
}

export function renderSkillMarkdown(skill: Skill): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`]
  if (!skill.modelInvocable) lines.push('disable-model-invocation: true')
  if (!skill.userInvocable) lines.push('user-invocable: false')
  lines.push('---', '', skill.body.trim(), '')
  return lines.join('\n')
}

/** 模型能自己调用的技能；其余只允许用户显式引用。 */
export function modelInvocableSkills(skills: Skill[]): Skill[] {
  return skills.filter(skill => skill.modelInvocable)
}
