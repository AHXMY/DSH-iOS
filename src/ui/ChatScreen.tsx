/**
 * 聊天页：会话头部 + 消息流 + 输入条。
 *
 * 流式的写法：正在生成的那条不进列表，而是在列表末尾"叠"一条 live 消息；
 * 一旦落盘（persist）就撤掉 live，改由正常消息渲染 —— 这样不会闪、不会重复。
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import type { ChatMessage, Session } from '../agent/types'
import { formatTokens } from '../agent/tokens'
import { Markdown } from './Markdown'
import { buildRenderItems, prettyArguments } from './renderItems'
import type { RenderItem, ToolState } from './renderItems'
import type { Palette } from './theme'

export type LiveAssistant = {
  message: ChatMessage
  toolStates: Record<string, ToolState>
}

type Props = {
  session: Session
  live: LiveAssistant | null
  busy: boolean
  error: string | null
  notice: string | null
  palette: Palette
  /** 上下文估算与预算：让用户看得见"还剩多少额度"，压缩才有意义 */
  contextTokens: number
  contextBudget: number
  onSend: (text: string) => void
  onStop: () => void
  onBack: () => void
  onOpenMenu: () => void
  onDismissNotice: () => void
}

function ReasoningBlock({ text, palette, streaming }: { text: string, palette: Palette, streaming: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (streaming) setOpen(true) }, [streaming])
  const preview = text.trim().split('\n').slice(-1)[0] ?? ''
  return (
    <Pressable
      onPress={() => setOpen(value => !value)}
      style={[styles.reasoning, { borderColor: palette.line }]}
    >
      <Text style={[styles.reasoningHead, { color: palette.dim }]}>
        {streaming ? '正在思考…' : '思考过程'}  {open ? '▾' : '▸'}
      </Text>
      {open
        ? <Text style={[styles.reasoningBody, { color: palette.dim }]}>{text}</Text>
        : <Text style={[styles.reasoningBody, { color: palette.dim }]} numberOfLines={1}>{preview}</Text>}
    </Pressable>
  )
}

function ToolCard({ call, state, palette }: { call: { id: string, name: string, arguments: string }, state: ToolState, palette: Palette }): JSX.Element {
  const [open, setOpen] = useState(false)
  const dotColor = state.status === 'failed' ? palette.danger : state.status === 'running' ? '#f0a020' : '#34c759'
  const label = state.status === 'running' ? '执行中' : state.status === 'failed' ? '失败' : '完成'

  return (
    <Pressable onPress={() => setOpen(value => !value)} style={[styles.toolCard, { backgroundColor: palette.card, borderColor: palette.line }]}>
      <View style={styles.toolHead}>
        <View style={[styles.toolDot, { backgroundColor: dotColor }]} />
        <Text style={[styles.toolName, { color: palette.fg }]}>{call.name}</Text>
        <Text style={[styles.toolState, { color: palette.dim }]}>{label} {open ? '▾' : '▸'}</Text>
      </View>
      {open && (
        <View style={styles.toolBody}>
          {prettyArguments(call) !== '' && (
            <Text style={[styles.toolArgs, { color: palette.dim }]} selectable>{prettyArguments(call)}</Text>
          )}
          {state.result !== undefined && (
            <Text style={[styles.toolResult, { color: state.status === 'failed' ? palette.danger : palette.fg }]} selectable>
              {state.result}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  )
}

function MessageRow({ item, palette }: { item: RenderItem, palette: Palette }): JSX.Element {
  if (item.kind === 'tool') return <ToolCard call={item.call} state={item.state} palette={palette} />

  const { message } = item

  // 压缩摘要：是 user 身份承载的，但绝不能当用户气泡渲染，否则用户会以为是自己说的。
  if (message.summary === true) {
    return (
      <View style={[styles.summaryCard, { borderColor: palette.line, backgroundColor: palette.card }]}>
        <Text style={[styles.summaryTitle, { color: palette.dim }]}>已压缩的更早对话</Text>
        <Text style={[styles.summaryText, { color: palette.fg }]}>{message.text.replace(/^【对话摘要】/, '').replace(/^【历史已裁剪】/, '')}</Text>
      </View>
    )
  }

  if (message.role === 'system') {
    return (
      <View style={[styles.systemRow, { borderColor: palette.line }]}>
        <Text style={[styles.systemText, { color: palette.dim }]} numberOfLines={2}>{message.text}</Text>
      </View>
    )
  }

  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: palette.userBubble }]}>
          <Text style={[styles.userText, { color: palette.userText }]} selectable>{message.text}</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.assistantRow}>
      {message.reasoning !== undefined && message.reasoning !== '' && (
        <ReasoningBlock text={message.reasoning} palette={palette} streaming={message.id.startsWith('live')} />
      )}
      {message.text !== '' && <Markdown source={message.text} palette={palette} />}
    </View>
  )
}

export function ChatScreen(props: Props): JSX.Element {
  const { session, live, busy, error, notice, palette, contextTokens, contextBudget, onSend, onStop, onBack, onOpenMenu, onDismissNotice } = props
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  const listRef = useRef<FlatList<RenderItem>>(null)
  const atBottomRef = useRef(true)

  const items = useMemo(() => {
    const base = buildRenderItems(session.messages, live?.toolStates ?? {})
    if (live !== null && !session.messages.some(message => message.id === live.message.id)) {
      base.push(...buildRenderItems([live.message], live.toolStates))
    }
    return base
  }, [session.messages, live])

  useEffect(() => {
    if (atBottomRef.current) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }))
    }
  }, [items.length, live?.message.text, live?.message.reasoning])

  const send = useCallback(() => {
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSend(text)
  }, [draft, busy, onSend])

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { paddingTop: insets.top + 6, borderBottomColor: palette.line }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: palette.accent }]}>‹ 会话</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.titleRow}>
            <Text style={[styles.headerTitle, { color: palette.fg }]} numberOfLines={1}>{session.title}</Text>
            {session.planMode && (
              <View style={[styles.chip, { borderColor: '#f0a020' }]}>
                <Text style={[styles.chipText, { color: '#f0a020' }]}>计划模式</Text>
              </View>
            )}
            {session.todos.length > 0 && (
              <View style={[styles.chip, { borderColor: palette.line }]}>
                <Text style={[styles.chipText, { color: palette.dim }]}>
                  待办 {session.todos.filter(todo => todo.status === 'done').length}/{session.todos.length}
                </Text>
              </View>
            )}
          </View>
          <Text style={[styles.headerSub, { color: palette.dim }]} numberOfLines={1}>
            {session.model} · 上下文 {formatTokens(contextTokens)}/{formatTokens(contextBudget)}
            {session.messages.length > 0 ? ` · ${session.messages.length} 条` : ''}
          </Text>
        </View>
        <Pressable onPress={onOpenMenu} hitSlop={12} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: palette.accent }]}>⋯</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={item => item.key}
        renderItem={({ item }) => <MessageRow item={item} palette={palette} />}
        contentContainerStyle={styles.listContent}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
          atBottomRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
        }}
        scrollEventThrottle={64}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: palette.fg }]}>这是 DSH，跑在你手机上</Text>
            <Text style={[styles.emptyBody, { color: palette.dim }]}>
              它有自己的笔记目录、能读剪贴板、能联网抓网页、能发通知、能朗读。
              没有 shell —— iOS 不给，所以别指望它替你跑构建。
            </Text>
          </View>
        )}
      />

      {error !== null && (
        <Pressable onPress={onDismissNotice} style={[styles.banner, { backgroundColor: 'rgba(192,57,43,0.12)' }]}>
          <Text style={[styles.bannerText, { color: palette.danger }]}>{error}</Text>
        </Pressable>
      )}
      {notice !== null && (
        <Pressable onPress={onDismissNotice} style={[styles.banner, { backgroundColor: palette.codeBg }]}>
          <Text style={[styles.bannerText, { color: palette.dim }]}>{notice}</Text>
        </Pressable>
      )}

      <View style={[styles.composerWrap, { paddingBottom: insets.bottom + 8, borderTopColor: palette.line }]}>
        <View style={[styles.composer, { backgroundColor: palette.card, borderColor: palette.line }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="给 DSH 派个活…"
            placeholderTextColor={palette.dim}
            multiline
            style={[styles.input, { color: palette.fg }]}
            maxLength={8000}
          />
          {busy
            ? (
              <Pressable onPress={onStop} style={[styles.sendBtn, { backgroundColor: palette.danger }]}>
                <View style={styles.stopSquare} />
              </Pressable>
            )
            : (
              <Pressable
                onPress={send}
                disabled={draft.trim() === ''}
                style={[styles.sendBtn, { backgroundColor: draft.trim() === '' ? palette.line : palette.accent }]}
              >
                {busy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.sendGlyph}>↑</Text>}
              </Pressable>
            )}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 14, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { minWidth: 52, paddingVertical: 4 },
  headerBtnText: { fontSize: 16 },
  headerCenter: { flex: 1, alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  headerTitle: { fontSize: 15.5, fontWeight: '600', flexShrink: 1 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  chipText: { fontSize: 10.5 },
  summaryCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 11, gap: 5 },
  summaryTitle: { fontSize: 11, fontWeight: '600' },
  summaryText: { fontSize: 13, lineHeight: 19 },
  headerSub: { fontSize: 11.5, marginTop: 1 },
  listContent: { padding: 14, gap: 10, paddingBottom: 24 },
  empty: { paddingTop: 60, paddingHorizontal: 8, gap: 10 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyBody: { fontSize: 14, lineHeight: 21 },
  userRow: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '84%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  userText: { fontSize: 15.5, lineHeight: 21 },
  assistantRow: { gap: 6 },
  systemRow: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 8 },
  systemText: { fontSize: 11.5, lineHeight: 16 },
  reasoning: { borderLeftWidth: 2, paddingLeft: 10, paddingVertical: 2, gap: 2 },
  reasoningHead: { fontSize: 11.5, fontWeight: '600' },
  reasoningBody: { fontSize: 12.5, lineHeight: 18 },
  toolCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 8 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolDot: { width: 7, height: 7, borderRadius: 4 },
  toolName: { fontSize: 13.5, fontWeight: '600', flex: 1 },
  toolState: { fontSize: 11.5 },
  toolBody: { gap: 6 },
  toolArgs: { fontSize: 11.5, fontFamily: 'Menlo' },
  toolResult: { fontSize: 12.5, fontFamily: 'Menlo', lineHeight: 17 },
  banner: { paddingHorizontal: 14, paddingVertical: 9 },
  bannerText: { fontSize: 12.5, lineHeight: 18 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 14, paddingRight: 6, paddingVertical: 6 },
  input: { flex: 1, fontSize: 15.5, maxHeight: 132, paddingTop: 6, paddingBottom: 6 },
  sendBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sendGlyph: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  stopSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: '#ffffff' },
})
