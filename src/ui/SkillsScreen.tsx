/**
 * 技能管理。
 *
 * 技能就是一份 Markdown：正文不进系统提示词，提示词里只挂一行 name + 说明，
 * 模型真要用时才用 skill 工具读进来。所以这里的目标很小 —— 能看、能改、能导入。
 * 导入路径两条：从「文件」App 选一个 .md，或者直接粘一段。
 */
import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import {
  Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { File } from 'expo-file-system'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { parseSkillMarkdown, slugifySkillName, writeSkill, deleteSkill } from '../store/skills'
import type { Skill } from '../store/skills'
import type { Palette } from './theme'

type Props = {
  skills: Skill[]
  palette: Palette
  onReload: () => void
  onClose: () => void
}

export function SkillsScreen({ skills, palette, onReload, onClose }: Props): JSX.Element {
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedBody, setExpandedBody] = useState('')
  const [busy, setBusy] = useState(false)

  const importFromFiles = useCallback(async () => {
    setBusy(true)
    try {
      const picked = await File.pickFileAsync({ mimeTypes: ['text/markdown', 'text/plain'] })
      if (picked.canceled || picked.result === null) return
      const text = picked.result.textSync()
      const name = slugifySkillName(picked.result.name.replace(/\.md$/i, ''))
      const skill = parseSkillMarkdown(text, name)
      writeSkill(skill)
      onReload()
      Alert.alert('已导入', `技能 ${skill.name} 已装好，模型下次需要时会自己读取。`)
    } catch (cause) {
      Alert.alert('导入失败', cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [onReload])

  const savePasted = useCallback(() => {
    if (draft.trim() === '') return
    try {
      const skill = parseSkillMarkdown(draft, `pasted-${Date.now().toString(36).slice(-4)}`)
      writeSkill(skill)
      setDraft('')
      onReload()
    } catch (cause) {
      Alert.alert('保存失败', cause instanceof Error ? cause.message : String(cause))
    }
  }, [draft, onReload])

  const toggleModelUse = useCallback((skill: Skill) => {
    writeSkill({ ...skill, modelInvocable: !skill.modelInvocable })
    onReload()
  }, [onReload])

  const confirmDelete = useCallback((skill: Skill) => {
    Alert.alert('删除技能', `确定删掉 ${skill.name}？内置技能删掉后可以通过版本更新恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          try {
            deleteSkill(skill.name)
            onReload()
          } catch (cause) {
            Alert.alert('删除失败', cause instanceof Error ? cause.message : String(cause))
          }
        },
      },
    ])
  }, [onReload])

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.line }]}>
        <Text style={[styles.title, { color: palette.fg }]}>技能</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={[styles.link, { color: palette.accent }]}>返回</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        <Text style={[styles.hint, { color: palette.dim }]}>
          技能 = 一份 Markdown 说明书。正文平时不占 token，模型需要时才会用 skill 工具读进去。
          格式与桌面 DSH 一致（kebab-case 名字 + 可选 frontmatter）。
        </Text>

        {skills.map(skill => (
          <View key={skill.name} style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.skillName, { color: palette.fg }]}>{skill.name}</Text>
              <Text style={[styles.source, { color: palette.dim }]}>{skill.source === 'builtin' ? '内置' : '自装'}</Text>
            </View>
            <Text style={[styles.skillDesc, { color: palette.dim }]}>{skill.description}</Text>

            <View style={styles.actionRow}>
              <Pressable
                onPress={() => {
                  if (expanded === skill.name) { setExpanded(null); return }
                  setExpanded(skill.name)
                  setExpandedBody(skill.body)
                }}
                style={[styles.smallButton, { borderColor: palette.line }]}
              >
                <Text style={[styles.smallText, { color: palette.accent }]}>{expanded === skill.name ? '收起' : '看正文'}</Text>
              </Pressable>
              <Pressable onPress={() => toggleModelUse(skill)} style={[styles.smallButton, { borderColor: palette.line }]}>
                <Text style={[styles.smallText, { color: skill.modelInvocable ? palette.accent : palette.dim }]}>
                  {skill.modelInvocable ? '模型可用' : '仅手动'}
                </Text>
              </Pressable>
              <Pressable onPress={() => confirmDelete(skill)} style={[styles.smallButton, { borderColor: palette.line }]}>
                <Text style={[styles.smallText, { color: palette.danger }]}>删除</Text>
              </Pressable>
            </View>

            {expanded === skill.name && (
              <View style={[styles.bodyBox, { backgroundColor: palette.bg }]}>
                <Text style={[styles.bodyText, { color: palette.fg }]} selectable>{expandedBody}</Text>
              </View>
            )}
          </View>
        ))}

        <Text style={[styles.section, { color: palette.dim }]}>新增技能</Text>
        <Pressable
          style={[styles.primary, { backgroundColor: busy ? palette.line : palette.accent }]}
          onPress={importFromFiles}
          disabled={busy}
        >
          <Text style={styles.primaryText}>从「文件」导入 .md</Text>
        </Pressable>

        <Text style={[styles.label, { color: palette.dim }]}>或直接粘贴一份：</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder={'---\nname: my-skill\ndescription: 什么时候用它\n---\n\n# 步骤\n1. …'}
          placeholderTextColor={palette.dim}
          style={[styles.textarea, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
        <Pressable
          style={[styles.primary, { backgroundColor: draft.trim() === '' ? palette.line : palette.accent }]}
          onPress={savePasted}
          disabled={draft.trim() === ''}
        >
          <Text style={styles.primaryText}>保存为技能</Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 24, fontWeight: '800' },
  link: { fontSize: 15 },
  body: { padding: 14, gap: 10 },
  hint: { fontSize: 12, lineHeight: 18 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 13, gap: 7 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  skillName: { fontSize: 15.5, fontWeight: '700', fontFamily: 'Menlo' },
  source: { fontSize: 11 },
  skillDesc: { fontSize: 12.5, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  smallButton: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  smallText: { fontSize: 12.5 },
  bodyBox: { borderRadius: 10, padding: 10, maxHeight: 240 },
  bodyText: { fontSize: 12.5, lineHeight: 18 },
  section: { fontSize: 12.5, textTransform: 'uppercase', marginTop: 12 },
  label: { fontSize: 12.5 },
  textarea: { minHeight: 130, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, fontSize: 13, lineHeight: 18, fontFamily: 'Menlo' },
  primary: { height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
})
