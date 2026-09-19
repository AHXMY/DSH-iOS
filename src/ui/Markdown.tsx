/**
 * 迷你 markdown 渲染。
 *
 * 手机上不需要完整 CommonMark —— 模型实际会用的就那么几样：代码块、行内代码、
 * 粗体、标题、列表。引 markdown-it 那套纯 JS 依赖在这个体量上不划算（还要配
 * markdown 渲染组件），于是这里自己做：按 ``` 切块，块内等宽，块外做行内标记。
 */
import type { JSX } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { Palette } from './theme'

type Block =
  | { kind: 'code', language: string, content: string }
  | { kind: 'text', content: string }

/** 按 ``` 围栏切块；未闭合的围栏按"还在流式输出"处理，先当代码块显示。 */
export function splitBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')
  let plain: string[] = []
  let code: string[] | null = null
  let language = ''

  const flushPlain = (): void => {
    if (plain.length === 0) return
    const content = plain.join('\n')
    if (content.trim() !== '') blocks.push({ kind: 'text', content })
    plain = []
  }

  for (const line of lines) {
    const fence = /^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line)
    if (fence !== null) {
      if (code === null) {
        flushPlain()
        code = []
        language = fence[1] ?? ''
      } else {
        blocks.push({ kind: 'code', language, content: code.join('\n') })
        code = null
        language = ''
      }
      continue
    }
    if (code === null) plain.push(line)
    else code.push(line)
  }

  if (code !== null) blocks.push({ kind: 'code', language, content: code.join('\n') })
  flushPlain()
  return blocks
}

/** 行内：`code`、**bold**、*italic*。返回可嵌套的 Text 片段。 */
function InlineText({ content, palette, baseStyle }: { content: string, palette: Palette, baseStyle: object }): JSX.Element {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  const parts: JSX.Element[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${key++}`}>{content.slice(lastIndex, match.index)}</Text>)
    }
    const token = match[0]
    if (token.startsWith('`')) {
      parts.push(
        <Text key={`c${key++}`} style={[styles.inlineCode, { backgroundColor: palette.codeBg, color: palette.fg }]}>
          {token.slice(1, -1)}
        </Text>,
      )
    } else if (token.startsWith('**')) {
      parts.push(<Text key={`b${key++}`} style={styles.bold}>{token.slice(2, -2)}</Text>)
    } else {
      parts.push(<Text key={`i${key++}`} style={styles.italic}>{token.slice(1, -1)}</Text>)
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < content.length) parts.push(<Text key={`t${key++}`}>{content.slice(lastIndex)}</Text>)

  return <Text style={baseStyle}>{parts}</Text>
}

export function Markdown({ source, palette }: { source: string, palette: Palette }): JSX.Element {
  const blocks = splitBlocks(source)
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <View key={index} style={[styles.codeBlock, { backgroundColor: palette.codeBg }]}>
              {block.language !== '' && (
                <Text style={[styles.codeLang, { color: palette.dim }]}>{block.language}</Text>
              )}
              <Text style={[styles.codeText, { color: palette.fg }]} selectable>{block.content}</Text>
            </View>
          )
        }
        return (
          <View key={index} style={styles.textBlock}>
            {block.content.split('\n').map((line, lineIndex) => {
              const heading = /^(#{1,6})\s+(.*)$/.exec(line)
              if (heading !== null) {
                return (
                  <InlineText
                    key={lineIndex}
                    content={heading[2] ?? ''}
                    palette={palette}
                    baseStyle={[styles.paragraph, styles.heading, { color: palette.fg }]}
                  />
                )
              }
              const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
              if (bullet !== null) {
                return (
                  <View key={lineIndex} style={styles.bulletRow}>
                    <Text style={[styles.bulletMark, { color: palette.dim }]}>•</Text>
                    <InlineText
                      content={bullet[2] ?? ''}
                      palette={palette}
                      baseStyle={[styles.paragraph, styles.bulletText, { color: palette.fg }]}
                    />
                  </View>
                )
              }
              if (line.trim() === '') return <View key={lineIndex} style={styles.spacer} />
              return (
                <InlineText
                  key={lineIndex}
                  content={line}
                  palette={palette}
                  baseStyle={[styles.paragraph, { color: palette.fg }]}
                />
              )
            })}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: 2 },
  textBlock: { gap: 1 },
  paragraph: { fontSize: 15.5, lineHeight: 22 },
  heading: { fontSize: 16.5, fontWeight: '700' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: { fontFamily: 'Menlo', fontSize: 13.5 },
  spacer: { height: 6 },
  bulletRow: { flexDirection: 'row', gap: 6, paddingLeft: 2 },
  bulletMark: { fontSize: 15.5, lineHeight: 22 },
  bulletText: { flex: 1 },
  codeBlock: { borderRadius: 10, padding: 10, marginVertical: 4 },
  codeLang: { fontSize: 10.5, marginBottom: 4, textTransform: 'uppercase' },
  codeText: { fontFamily: 'Menlo', fontSize: 12.5, lineHeight: 18 },
})
