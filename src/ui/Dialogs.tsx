/**
 * 交互层：审批、追问、计划确认。
 *
 * 这三个是"手机上的 DSH"最该有的东西 —— 工具会真的动用户的数据（写文件、删文件、发通知、
 * 复制到剪贴板），一句不问就干是错的；而模型卡住时又能主动问人。
 * 组件本身无状态：谁在等、等什么、答什么由 App 持有，这里只负责把它问得清楚。
 */
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApprovalDecision, ApprovalRequest, AskRequest, TodoItem } from '../agent/types'
import type { Palette } from './theme'

const RISK_LABEL = { read: '只读', write: '会改动数据', danger: '不可逆操作' } as const

function Backdrop({ children, palette }: { children: ReactNode, palette: Palette }): JSX.Element {
  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: palette.card }]}>{children}</View>
      </View>
    </Modal>
  )
}

function RiskBadge({ risk, palette }: { risk: keyof typeof RISK_LABEL, palette: Palette }): JSX.Element {
  const color = risk === 'danger' ? palette.danger : risk === 'write' ? '#f0a020' : '#34c759'
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{RISK_LABEL[risk]}</Text>
    </View>
  )
}

export function ApprovalDialog({ request, palette, onDecide }: {
  request: ApprovalRequest
  palette: Palette
  onDecide: (decision: ApprovalDecision) => void
}): JSX.Element {
  return (
    <Backdrop palette={palette}>
      <Text style={[styles.title, { color: palette.fg }]}>允许执行 {request.toolName}？</Text>
      <View style={styles.badgeRow}>
        <RiskBadge risk={request.risk} palette={palette} />
      </View>
      {request.detail.trim() !== '' && (
        <ScrollView style={[styles.detailBox, { backgroundColor: palette.codeBg }]} contentContainerStyle={styles.detailInner}>
          <Text style={[styles.detail, { color: palette.fg }]}>{request.detail}</Text>
        </ScrollView>
      )}
      <Pressable style={[styles.button, { backgroundColor: palette.accent }]} onPress={() => onDecide('allow')}>
        <Text style={styles.buttonTextStrong}>允许这一次</Text>
      </Pressable>
      <Pressable style={[styles.button, { borderColor: palette.line, borderWidth: 1 }]} onPress={() => onDecide('always')}>
        <Text style={[styles.buttonText, { color: palette.accent }]}>本会话一直允许 {request.toolName}</Text>
      </Pressable>
      <Pressable style={[styles.button, { borderColor: palette.line, borderWidth: 1 }]} onPress={() => onDecide('deny')}>
        <Text style={[styles.buttonText, { color: palette.danger }]}>拒绝</Text>
      </Pressable>
    </Backdrop>
  )
}

export function AskDialog({ request, palette, onSubmit }: {
  request: AskRequest
  palette: Palette
  onSubmit: (answer: string) => void
}): JSX.Element {
  const [custom, setCustom] = useState('')
  const [typing, setTyping] = useState((request.options ?? []).length === 0)

  return (
    <Backdrop palette={palette}>
      <Text style={[styles.title, { color: palette.fg }]}>{request.question}</Text>
      {(request.options ?? []).map(option => (
        <Pressable
          key={option}
          style={[styles.button, { borderColor: palette.line, borderWidth: 1 }]}
          onPress={() => onSubmit(option)}
        >
          <Text style={[styles.buttonText, { color: palette.fg }]}>{option}</Text>
        </Pressable>
      ))}
      {!typing && (request.options ?? []).length > 0 && (
        <Pressable style={styles.plain} onPress={() => setTyping(true)}>
          <Text style={[styles.buttonText, { color: palette.accent }]}>其他（自己输入）</Text>
        </Pressable>
      )}
      {typing && (
        <>
          <TextInput
            value={custom}
            onChangeText={setCustom}
            multiline
            autoFocus
            placeholder="输入回答…"
            placeholderTextColor={palette.dim}
            style={[styles.input, { backgroundColor: palette.bg, color: palette.fg, borderColor: palette.line }]}
          />
          <Pressable style={[styles.button, { backgroundColor: palette.accent }]} onPress={() => onSubmit(custom)}>
            <Text style={styles.buttonTextStrong}>回答</Text>
          </Pressable>
        </>
      )}
      <Pressable style={styles.plain} onPress={() => onSubmit('')}>
        <Text style={[styles.buttonText, { color: palette.dim }]}>跳过</Text>
      </Pressable>
    </Backdrop>
  )
}

export function PlanDialog({ plan, palette, onDecide }: {
  plan: string
  palette: Palette
  onDecide: (approved: boolean) => void
}): JSX.Element {
  return (
    <Backdrop palette={palette}>
      <Text style={[styles.title, { color: palette.fg }]}>这份计划可以执行吗？</Text>
      <ScrollView style={[styles.detailBox, { backgroundColor: palette.bg }]} contentContainerStyle={styles.detailInner}>
        <Text style={[styles.detail, { color: palette.fg }]}>{plan}</Text>
      </ScrollView>
      <Pressable style={[styles.button, { backgroundColor: palette.accent }]} onPress={() => onDecide(true)}>
        <Text style={styles.buttonTextStrong}>批准，开始执行</Text>
      </Pressable>
      <Pressable style={[styles.button, { borderColor: palette.line, borderWidth: 1 }]} onPress={() => onDecide(false)}>
        <Text style={[styles.buttonText, { color: palette.danger }]}>继续修改</Text>
      </Pressable>
    </Backdrop>
  )
}

export type SheetAction = {
  label: string
  onPress: () => void
  destructive?: boolean
  /** 右侧的小字说明（比如当前状态） */
  hint?: string
}

/** 底部动作面板：聊天页的 ⋯ 菜单用它，比 Alert 能装更多项也更像 iOS。 */
export function ActionSheet({ visible, title, actions, palette, onClose }: {
  visible: boolean
  title?: string
  actions: SheetAction[]
  palette: Palette
  onClose: () => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}><View /></Pressable>
      <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 12 }]}>
        {title !== undefined && <Text style={[styles.sheetTitle, { color: palette.dim }]}>{title}</Text>}
        {actions.map(action => (
          <Pressable
            key={action.label}
            style={[styles.sheetRow, { borderColor: palette.line }]}
            onPress={() => { onClose(); action.onPress() }}
          >
            <Text style={[styles.sheetLabel, { color: action.destructive === true ? palette.danger : palette.fg }]}>
              {action.label}
            </Text>
            {action.hint !== undefined && <Text style={[styles.sheetHint, { color: palette.dim }]}>{action.hint}</Text>}
          </Pressable>
        ))}
      </View>
    </Modal>
  )
}

/** 待办面板：模型在写，用户在看。 */
export function TodoSheet({ visible, todos, palette, onClear, onClose }: {
  visible: boolean
  todos: TodoItem[]
  palette: Palette
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}><View /></Pressable>
      <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 12 }]}>
        <Text style={[styles.sheetTitle, { color: palette.dim }]}>待办</Text>
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 10, gap: 8 }}>
          {todos.length === 0 && <Text style={[styles.detail, { color: palette.dim }]}>（空）</Text>}
          {todos.map(todo => (
            <View key={todo.id} style={styles.todoRow}>
              <Text style={[styles.todoMark, {
                color: todo.status === 'done' ? '#34c759' : todo.status === 'in_progress' ? '#f0a020' : palette.dim,
              }]}>
                {todo.status === 'done' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
              </Text>
              <Text style={[styles.todoText, {
                color: todo.status === 'done' ? palette.dim : palette.fg,
                textDecorationLine: todo.status === 'done' ? 'line-through' : 'none',
              }]}>{todo.text}</Text>
            </View>
          ))}
        </ScrollView>
        {todos.length > 0 && (
          <Pressable style={[styles.sheetRow, { borderColor: palette.line }]} onPress={() => { onClose(); onClear() }}>
            <Text style={[styles.sheetLabel, { color: palette.danger }]}>清空待办</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  card: { width: '100%', maxWidth: 420, borderRadius: 18, padding: 18, gap: 10 },
  title: { fontSize: 17, fontWeight: '700', lineHeight: 23 },
  badgeRow: { flexDirection: 'row' },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { fontSize: 11.5, fontWeight: '600' },
  detailBox: { maxHeight: 190, borderRadius: 10 },
  detailInner: { padding: 10 },
  detail: { fontSize: 12, fontFamily: 'Menlo', lineHeight: 17 },
  button: { height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  buttonText: { fontSize: 15.5 },
  buttonTextStrong: { fontSize: 15.5, fontWeight: '600', color: '#ffffff' },
  plain: { alignItems: 'center', paddingVertical: 8 },
  input: { minHeight: 60, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10, fontSize: 15 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 12 },
  sheetTitle: { fontSize: 12, textAlign: 'center', paddingBottom: 8 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetLabel: { fontSize: 16 },
  sheetHint: { fontSize: 12.5 },
  todoRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  todoMark: { fontSize: 14, lineHeight: 20 },
  todoText: { fontSize: 14.5, lineHeight: 20, flex: 1 },
})
