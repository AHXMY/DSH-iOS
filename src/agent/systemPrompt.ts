/**
 * 系统提示词拼装。
 *
 * DSH 的提示词之所以"看起来聪明"，很大一部分不是模型强，而是**环境事实被喂进去了**：
 * 它是谁、在哪台机器上、能用什么工具、手上有什么待办、现在几点。手机版同样需要，
 * 否则模型会假装自己有 shell，或者把今天的日期算错。
 *
 * 原则：只放模型真正用得上的事实，不含隐私，能省则省（每轮都要花 token）。
 */
import { RISK_LABEL } from './policy'
import type { SessionState, ToolSpec } from './types'

export type PromptInput = {
  /** 预设人设（用户在设置里写的那段） */
  persona: string
  tools: ToolSpec[]
  state: SessionState
  /** 模型可调用的技能：只给名称与用途，正文靠 skill 工具按需加载 */
  skills: { name: string, description: string }[]
  /** 配了远程执行代理时给个标签，让提示词能说清"你不是只有这台手机" */
  sandboxLabel?: string
  now?: Date
}

function environmentLines(now: Date, sandboxLabel?: string): string[] {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const stamp = now.toLocaleString('zh-CN', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  })
  const lines = [
    `- 时间：${stamp}（时区 ${zone}）`,
    '- 设备：iPhone（iOS），你是这个 App 里的 agent，完全运行在本机',
    '- 文件：手机本地有一个工作目录，路径一律用它下面的相对路径',
    '- 手机上没有的能力：shell、子进程、git、任意路径读写 —— iOS 不允许，不要假装有；需要精确结果就用工具，算数用 calc、取时间用 get_time，别猜',
  ]
  if (sandboxLabel !== undefined && sandboxLabel !== '') {
    lines.push(
      `- 另外你连着一台可执行命令的机器：${sandboxLabel}。`
      + '需要跑命令、用 git、处理仓库或大文件时，用 bash / sandbox_* 这组工具在上面做（它们操作的是那台机器，不是手机）；'
      + '手机本机的 read_file / write_file 只动 App 自己的小工作区。两边的路径不要混用。',
    )
  }
  return lines
}

function toolLines(tools: ToolSpec[]): string[] {
  return tools.map(tool => `- ${tool.name}（${RISK_LABEL[tool.risk]}）：${tool.description}`)
}

export function composeSystemPrompt(input: PromptInput): string {
  const now = input.now ?? new Date()
  const sections: string[] = [input.persona.trim()]

  sections.push(['## 运行环境', ...environmentLines(now, input.sandboxLabel)].join('\n'))
  sections.push(['## 可用工具', ...toolLines(input.tools)].join('\n'))

  if (input.skills.length > 0) {
    sections.push([
      '## 技能（按需加载）',
      '下面是本机安装的技能。任务对得上时，先用 skill 工具把正文读进来，再照它做；不要凭名字猜内容。',
      ...input.skills.map(skill => `- ${skill.name}：${skill.description}`),
    ].join('\n'))
  }

  if (input.state.todos.length > 0) {
    sections.push([
      '## 当前待办',
      ...input.state.todos.map(todo => {
        const mark = todo.status === 'done' ? 'x' : todo.status === 'in_progress' ? '~' : ' '
        return `- [${mark}] ${todo.text}`
      }),
      '（多步任务用它跟踪进度：开始一项标 in_progress，做完标 done，变更后立刻用 todo_write 更新）',
    ].join('\n'))
  } else {
    sections.push('## 当前待办\n（空。超过两步的任务先写下来再动手，别在心里记）')
  }

  if (input.state.planMode) {
    sections.push([
      '## 计划模式（已开启）',
      '现在只做规划：可以读文件、抓网页、查时间，但不要执行任何会改动数据的操作。',
      '想清楚后调用 exit_plan_mode 把计划交给用户确认，批准后才会解除。',
    ].join('\n'))
  }

  if (input.state.allowlist.length > 0) {
    sections.push(`## 已获准的操作\n用户已允许本会话直接执行：${input.state.allowlist.join('、')}`)
  }

  return sections.join('\n\n')
}

/** 给"压缩摘要"用的提示词 —— 单独一条，别混进系统提示词。 */
export const SUMMARY_INSTRUCTION = [
  '把下面这段早期对话压缩成一份结构化摘要，供后续对话直接使用。要求：',
  '1. 只保留对后续有用的信息：用户的目标与偏好、已确认的事实与数据、已经做过的动作及其结果、未完成的事项、关键路径与文件名。',
  '2. 丢掉寒暄、重复、失败的中间尝试（除非失败原因仍重要）。',
  '3. 用中文，条目式，不超过 500 字。不要评论、不要客套、不要"以下是摘要"。',
  '4. 数字、日期、文件名、代码片段必须原样保留，不要概括。',
].join('\n')
