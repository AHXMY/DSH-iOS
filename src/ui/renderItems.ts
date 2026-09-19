/**
 * 把消息数组摊成"可渲染项"。
 *
 * 难点在工具：助手消息里带 tool_calls，执行结果却是另一条 role:tool 的消息。
 * 界面上它们是同一张卡片（调用 + 结果），所以这里先合并，渲染层就不用管配对了。
 */
import type { ChatMessage, ToolCall } from '../agent/types'

export type ToolState = {
  status: 'running' | 'done' | 'failed'
  result?: string
}

export type RenderItem =
  | { kind: 'message', key: string, message: ChatMessage }
  | { kind: 'tool', key: string, call: ToolCall, state: ToolState }

export function buildRenderItems(
  messages: ChatMessage[],
  toolStates: Record<string, ToolState> = {},
): RenderItem[] {
  const items: RenderItem[] = []
  const indexByCallId = new Map<string, number>()

  for (const message of messages) {
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? ''
      const at = indexByCallId.get(callId)
      const state: ToolState = { status: message.failed === true ? 'failed' : 'done', result: message.text }
      if (at !== undefined) {
        const existing = items[at]
        if (existing !== undefined && existing.kind === 'tool') {
          items[at] = { ...existing, state }
          continue
        }
      }
      // 找不到对应的调用（例如历史被截断）也要显示出来，不能吞掉。
      items.push({
        kind: 'tool',
        key: `tool-${message.id}`,
        call: { id: callId, name: message.toolName ?? 'tool', arguments: '' },
        state,
      })
      continue
    }

    items.push({ kind: 'message', key: message.id, message })
    for (const call of message.toolCalls ?? []) {
      indexByCallId.set(call.id, items.length)
      items.push({
        kind: 'tool',
        key: `tool-${call.id}`,
        call,
        state: toolStates[call.id] ?? { status: 'running' },
      })
    }
  }

  return items
}

/** 工具参数长得是一串 JSON 字符串，展示前尽量弄好看点。 */
export function prettyArguments(call: ToolCall): string {
  const raw = call.arguments.trim()
  if (raw === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
