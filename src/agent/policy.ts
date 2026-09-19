/**
 * 工具执行策略：谁能跑、谁要问人、计划模式下挡什么。
 *
 * 单独一个文件是有意的 —— 这里全是纯判断，不碰 expo、不碰 IO，
 * 所以能在 Node 里逐条验证（审批这种"问不对就会写坏用户数据"的逻辑，必须可测）。
 */
import type { ApprovalMode, ToolSpec } from './types'

/** 会话自身的簿记类工具：改的是 App 状态（待办、计划），不是用户数据，所以不参与审批。 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(['todo_write', 'todo_read', 'exit_plan_mode'])

/** 计划模式下仍允许执行的工具 —— 否则用户永远没法批准计划。 */
export const PLAN_MODE_ALLOWED: ReadonlySet<string> = new Set(['exit_plan_mode'])

export const RISK_LABEL: Record<ToolSpec['risk'], string> = {
  read: '只读',
  write: '会改动数据',
  danger: '不可逆',
}

/** 审批判定：只读放行；会话簿记放行；已白名单放行；其余按模式问人。 */
export function needsApproval(tool: ToolSpec, mode: ApprovalMode, allowlist: readonly string[]): boolean {
  if (BOOKKEEPING_TOOLS.has(tool.name)) return false
  if (allowlist.includes(tool.name)) return false
  if (mode === 'auto') return false
  if (mode === 'all') return true
  return tool.risk !== 'read'
}

/** 计划模式拦截：只挡会改动数据的操作，读操作照旧。返回拦截原因，null 表示放行。 */
export function planModeBlock(tool: ToolSpec, planMode: boolean): string | null {
  if (!planMode) return null
  if (PLAN_MODE_ALLOWED.has(tool.name)) return null
  if (tool.risk === 'read') return null
  return '现在是计划模式，不能执行会改动数据的操作。先把计划写清楚，用 exit_plan_mode 交给用户确认。'
}
