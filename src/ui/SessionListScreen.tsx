/** 会话列表：本地会话 + 新会话（选预设）+ 进设置。 */
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import {
  Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Session } from '../agent/types'
import { searchSessions } from '../agent/sessionExport'
import type { Preset } from '../store/sessions'
import type { Palette } from './theme'

type Props = {
  sessions: Session[]
  presets: Preset[]
  palette: Palette
  onCreate: (preset: Preset) => void
  onOpen: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onOpenSettings: () => void
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function SessionListScreen(props: Props): JSX.Element {
  const { sessions, presets, palette, onCreate, onOpen, onDelete, onOpenSettings } = props
  const insets = useSafeAreaInsets()
  const [choosing, setChoosing] = useState(false)
  const [query, setQuery] = useState('')

  const rows = useMemo(
    () => sessions.map(session => {
      const last = session.messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(-1)[0]
      const preview = last === undefined
        ? '（空会话）'
        : `${last.role === 'user' ? '你：' : ''}${last.text.replace(/\s+/g, ' ').slice(0, 60)}`
      return { session, preview }
    }),
    [sessions],
  )

  // 会话一多就找不到"上次让它干的那件事"了，所以搜索直接摆在列表顶上。
  const hits = useMemo(() => searchSessions(sessions, query), [sessions, query])

  const confirmDelete = (session: Session): void => {
    Alert.alert('删除会话', `「${session.title}」的本地记录会被删掉，不可恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => onDelete(session.id) },
    ])
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: palette.line }]}>
        <Text style={[styles.title, { color: palette.fg }]}>DSH<Text style={{ color: palette.accent }}>.</Text></Text>
        <Pressable onPress={onOpenSettings} hitSlop={12}>
          <Text style={[styles.gear, { color: palette.accent }]}>设置</Text>
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜会话、消息、工具结果…"
          placeholderTextColor={palette.dim}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={[styles.search, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
      </View>

      {query.trim() === ''
        ? (
          <FlatList
            data={rows}
            keyExtractor={row => row.session.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={(
              <View style={styles.empty}>
                <Text style={[styles.emptyTitle, { color: palette.fg }]}>还没有会话</Text>
                <Text style={[styles.emptyBody, { color: palette.dim }]}>点下面的「新会话」，选一个预设开始。</Text>
              </View>
            )}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onOpen(item.session.id)}
                onLongPress={() => confirmDelete(item.session)}
                style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
              >
                <View style={styles.rowHead}>
                  <Text style={[styles.rowTitle, { color: palette.fg }]} numberOfLines={1}>{item.session.title}</Text>
                  <Text style={[styles.rowTime, { color: palette.dim }]}>{relativeTime(item.session.updatedAt)}</Text>
                </View>
                <Text style={[styles.rowPreview, { color: palette.dim }]} numberOfLines={2}>{item.preview}</Text>
                <Text style={[styles.rowMeta, { color: palette.dim }]}>
                  {item.session.model} · {item.session.messages.length} 条
                </Text>
              </Pressable>
            )}
          />
        )
        : (
          <FlatList
            data={hits}
            keyExtractor={hit => `${hit.messageId}-${hit.role}`}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={(
              <View style={styles.empty}>
                <Text style={[styles.emptyTitle, { color: palette.fg }]}>没搜到</Text>
                <Text style={[styles.emptyBody, { color: palette.dim }]}>换一个词试试；工具输出也在搜索范围里。</Text>
              </View>
            )}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => { setQuery(''); onOpen(item.sessionId) }}
                style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
              >
                <View style={styles.rowHead}>
                  <Text style={[styles.rowTitle, { color: palette.fg }]} numberOfLines={1}>
                    {item.role === 'title' ? '标题命中' : item.role === 'tool' ? '工具结果' : item.role === 'user' ? '你说过' : 'DSH 说过'} · {item.title}
                  </Text>
                  <Text style={[styles.rowTime, { color: palette.dim }]}>{relativeTime(item.at)}</Text>
                </View>
                <Text style={[styles.rowPreview, { color: palette.dim }]} numberOfLines={3}>{item.snippet}</Text>
              </Pressable>
            )}
          />
        )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + 10, borderTopColor: palette.line }]}>
        <Pressable style={[styles.primary, { backgroundColor: palette.accent }]} onPress={() => setChoosing(true)}>
          <Text style={styles.primaryText}>＋ 新会话</Text>
        </Pressable>
      </View>

      <Modal visible={choosing} transparent animationType="fade" onRequestClose={() => setChoosing(false)}>
        <Pressable style={styles.backdrop} onPress={() => setChoosing(false)}><View /></Pressable>
        <View style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 12 }]}>
          <Text style={[styles.sheetTitle, { color: palette.dim }]}>选一个预设</Text>
          {presets.map(preset => (
            <Pressable
              key={preset.id}
              style={[styles.sheetRow, { borderColor: palette.line }]}
              onPress={() => { setChoosing(false); onCreate(preset) }}
            >
              <Text style={[styles.sheetName, { color: palette.fg }]}>{preset.name}</Text>
              <Text style={[styles.sheetSummary, { color: palette.dim }]}>{preset.summary}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.sheetRow, styles.sheetCancel]} onPress={() => setChoosing(false)}>
            <Text style={[styles.sheetName, { color: palette.accent }]}>取消</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  gear: { fontSize: 15 },
  searchWrap: { paddingHorizontal: 14, paddingTop: 10 },
  search: {
    height: 38, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, fontSize: 15,
  },
  listContent: { padding: 14, gap: 10, paddingBottom: 30 },
  empty: { paddingTop: 70, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 13.5 },
  row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  rowTime: { fontSize: 11.5 },
  rowPreview: { fontSize: 13, lineHeight: 18 },
  rowMeta: { fontSize: 11 },
  footer: { paddingHorizontal: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  primary: { height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#ffffff', fontSize: 16.5, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 12 },
  sheetTitle: { fontSize: 12, textAlign: 'center', paddingBottom: 8 },
  sheetRow: { paddingHorizontal: 18, paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth, gap: 3 },
  sheetCancel: { alignItems: 'center', marginTop: 6 },
  sheetName: { fontSize: 16, fontWeight: '600' },
  sheetSummary: { fontSize: 12.5, lineHeight: 17 },
})
