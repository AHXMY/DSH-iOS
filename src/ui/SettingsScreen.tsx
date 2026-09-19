/**
 * 设置：模型连接 + 人设。
 *
 * 模型清单是问服务端要的（/models），不是我拍脑袋写死的列表 ——
 * 模型换代比 App 迭代快，写死就会立刻过期。
 */
import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { listModels } from '../agent/deepseek'
import { runConnectivityChecks, summarize } from '../agent/connectivity'
import type { CheckResult } from '../agent/connectivity'
import { parseMcpEntries } from '../agent/mcpConfig'
import { connectMcpServers, describeMcpRegistration } from '../agent/mcpTools'
import { SandboxClient } from '../agent/sandbox'
import { APPROVAL_MODE_LABEL, BUILTIN_PRESETS, CONTEXT_BUDGET_CHOICES } from '../store/sessions'
import type { LlmSettings } from '../store/sessions'
import type { ApprovalMode } from '../agent/types'
import type { Palette } from './theme'

type Props = {
  initial: LlmSettings
  palette: Palette
  skillCount: number
  onOpenSkills: () => void
  onSave: (settings: LlmSettings) => void
  onCancel?: () => void
}

const TEMPERATURES = [0.3, 0.7, 1.0, 1.3] as const
const APPROVAL_MODES: ApprovalMode[] = ['auto', 'write', 'all']

/** 边打边验：配置写错了当场说，别等到用的时候才炸。 */
function mcpError(lines: string): string | null {
  if (lines.trim() === '') return null
  try {
    parseMcpEntries(lines)
    return null
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

export function SettingsScreen({ initial, palette, skillCount, onOpenSkills, onSave, onCancel }: Props): JSX.Element {
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState<LlmSettings>(initial)
  const [models, setModels] = useState<string[]>([])
  const [probe, setProbe] = useState<{ kind: 'idle' | 'running' | 'done', ok?: boolean, message?: string }>({ kind: 'idle' })
  const [sandboxProbe, setSandboxProbe] = useState<{ kind: 'idle' | 'running' | 'done', ok?: boolean, message?: string }>({ kind: 'idle' })
  const [mcpProbe, setMcpProbe] = useState<{ kind: 'idle' | 'running' | 'done', ok?: boolean, message?: string }>({ kind: 'idle' })
  const [checks, setChecks] = useState<{ kind: 'idle' | 'running' | 'done', summary?: string, results: CheckResult[] }>({ kind: 'idle', results: [] })

  /** 四条链路一次跑完：模型、搜索、远程执行、MCP。 */
  const runChecks = useCallback(async () => {
    setChecks({ kind: 'running', results: [] })
    try {
      const results = await runConnectivityChecks({
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: draft.model,
        searchProvider: draft.searchProvider,
        searchBaseUrl: draft.searchBaseUrl,
        searchModel: draft.searchModel,
        searchAgentUrl: draft.searchAgentUrl,
        searchAgentToken: draft.searchAgentToken,
        searchEngine: draft.searchEngine,
        exaApiKey: draft.exaApiKey,
        perplexityApiKey: draft.perplexityApiKey,
        sandboxUrl: draft.sandboxUrl,
        sandboxToken: draft.sandboxToken,
        mcpLines: draft.mcpLines,
      })
      setChecks({ kind: 'done', summary: summarize(results), results })
    } catch (cause) {
      setChecks({
        kind: 'done',
        summary: '自检自身出错了',
        results: [{
          id: 'model',
          label: '自检',
          status: 'fail',
          detail: cause instanceof Error ? cause.message : String(cause),
        }],
      })
    }
  }, [draft])

  /** MCP 也当场验：连上没连上、几台、几个工具，别等模型调用时才发现连不通。 */
  const testMcp = useCallback(async () => {
    setMcpProbe({ kind: 'running' })
    try {
      if (draft.mcpLines.trim() === '') {
        setMcpProbe({ kind: 'done', ok: true, message: '没有配置 MCP 服务器' })
        return
      }
      const registration = await connectMcpServers(draft.mcpLines)
      setMcpProbe({
        kind: 'done',
        ok: registration.failures.length === 0,
        message: describeMcpRegistration(registration),
      })
      registration.close()
    } catch (cause) {
      setMcpProbe({ kind: 'done', ok: false, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [draft.mcpLines])

  const patch = useCallback((values: Partial<LlmSettings>) => {
    setDraft(current => ({ ...current, ...values }))
  }, [])

  /** 远程执行代理连通性：这是"iOS 上没有的能力"能不能真的回来的分界线，必须能当场验。 */
  const testSandbox = useCallback(async () => {
    setSandboxProbe({ kind: 'running' })
    try {
      const client = new SandboxClient({
        url: draft.sandboxUrl.trim(),
        token: draft.sandboxToken.trim(),
        label: '远程沙箱',
      })
      const health = await client.health()
      const ping = await client.exec('node -e "console.log(1)"', { timeoutMs: 15_000 }).catch(() => null)
      setSandboxProbe({
        kind: 'done',
        ok: true,
        message: [
          `连上了（${health.platform}，${health.root}）`,
          ping === null ? '但命令没跑通' : `命令可执行（退出码 ${ping.exitCode}, ${ping.durationMs}ms）`,
        ].join('；'),
      })
    } catch (cause) {
      setSandboxProbe({ kind: 'done', ok: false, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [draft.sandboxUrl, draft.sandboxToken])

  const test = useCallback(async () => {
    setProbe({ kind: 'running' })
    try {
      const found = await listModels({ apiKey: draft.apiKey, baseUrl: draft.baseUrl })
      setModels(found)
      setProbe({ kind: 'done', ok: true, message: `连上了，${found.length} 个模型可选` })
      if (found.length > 0 && !found.includes(draft.model)) patch({ model: found[0] as string })
    } catch (cause) {
      setProbe({ kind: 'done', ok: false, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [draft.apiKey, draft.baseUrl, draft.model, patch])

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: palette.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: palette.fg }]}>设置</Text>
          {onCancel !== undefined && (
            <Pressable onPress={onCancel} hitSlop={12}>
              <Text style={[styles.link, { color: palette.accent }]}>返回</Text>
            </Pressable>
          )}
        </View>

        <Text style={[styles.section, { color: palette.dim }]}>模型</Text>
        <Text style={[styles.label, { color: palette.dim }]}>API Key</Text>
        <TextInput
          value={draft.apiKey}
          onChangeText={value => patch({ apiKey: value.trim() })}
          placeholder="sk-…"
          placeholderTextColor={palette.dim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
        <Text style={[styles.hint, { color: palette.dim }]}>只存在这台手机的 Keychain 里，不经过任何第三方。</Text>

        <Text style={[styles.label, { color: palette.dim }]}>接口地址</Text>
        <TextInput
          value={draft.baseUrl}
          onChangeText={value => patch({ baseUrl: value.trim() })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />

        <Text style={[styles.label, { color: palette.dim }]}>模型</Text>
        <TextInput
          value={draft.model}
          onChangeText={value => patch({ model: value.trim() })}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
        <View style={styles.chipRow}>
          {(models.length > 0 ? models : [draft.model]).slice(0, 8).map(model => (
            <Pressable
              key={model}
              onPress={() => patch({ model })}
              style={[styles.chip, { borderColor: model === draft.model ? palette.accent : palette.line }]}
            >
              <Text style={[styles.chipText, { color: model === draft.model ? palette.accent : palette.dim }]}>{model}</Text>
            </Pressable>
          ))}
          <Pressable onPress={test} style={[styles.chip, { borderColor: palette.line }]}>
            {probe.kind === 'running'
              ? <ActivityIndicator color={palette.accent} />
              : <Text style={[styles.chipText, { color: palette.accent }]}>拉取模型清单</Text>}
          </Pressable>
        </View>
        {probe.message !== undefined && (
          <Text style={[styles.hint, { color: probe.ok === true ? '#34c759' : palette.danger }]}>{probe.message}</Text>
        )}

        <Text style={[styles.label, { color: palette.dim }]}>发散程度</Text>
        <View style={styles.chipRow}>
          {TEMPERATURES.map(value => (
            <Pressable
              key={value}
              onPress={() => patch({ temperature: value })}
              style={[styles.chip, { borderColor: value === draft.temperature ? palette.accent : palette.line }]}
            >
              <Text style={[styles.chipText, { color: value === draft.temperature ? palette.accent : palette.dim }]}>{value}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.section, { color: palette.dim }]}>权限与上下文</Text>
        <Text style={[styles.label, { color: palette.dim }]}>工具审批</Text>
        <View style={styles.chipRow}>
          {APPROVAL_MODES.map(mode => (
            <Pressable
              key={mode}
              onPress={() => patch({ approvalMode: mode })}
              style={[styles.chip, { borderColor: mode === draft.approvalMode ? palette.accent : palette.line }]}
            >
              <Text style={[styles.chipText, { color: mode === draft.approvalMode ? palette.accent : palette.dim }]}>
                {APPROVAL_MODE_LABEL[mode]}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.hint, { color: palette.dim }]}>
          只读工具（读文件、抓网页、算数）一律放行；写入、删除、发通知、写剪贴板按这里的策略问你。
        </Text>

        <Text style={[styles.label, { color: palette.dim }]}>上下文预算</Text>
        <View style={styles.chipRow}>
          {CONTEXT_BUDGET_CHOICES.map(value => (
            <Pressable
              key={value}
              onPress={() => patch({ contextBudget: value })}
              style={[styles.chip, { borderColor: value === draft.contextBudget ? palette.accent : palette.line }]}
            >
              <Text style={[styles.chipText, { color: value === draft.contextBudget ? palette.accent : palette.dim }]}>
                {value / 1000}k
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.hint, { color: palette.dim }]}>
          超过预算时会先裁剪旧工具输出，再让模型把更早的对话压成摘要 —— 这样长会话不会中途卡死。
        </Text>

        <Pressable style={[styles.presetRow, { borderColor: palette.line, backgroundColor: palette.card }]} onPress={onOpenSkills}>
          <Text style={[styles.presetName, { color: palette.fg }]}>技能（{skillCount}）</Text>
          <Text style={[styles.presetSummary, { color: palette.dim }]}>管理本机技能包：导入、编辑、决定模型能不能自己调用</Text>
        </Pressable>

        <Text style={[styles.section, { color: palette.dim }]}>远程执行（把 shell / git 找回来）</Text>
        <Text style={[styles.hint, { color: palette.dim }]}>
          iOS 不给子进程，所以手机本地永远跑不了命令。填上你自己的执行代理，就能让 agent 在一台 Linux
          机器上跑 shell、用 git、处理真实文件树 —— 手机只发 HTTP。服务端就是仓库里的
          {' '}<Text style={{ fontFamily: 'Menlo' }}>server/exec-agent.mjs</Text>（零依赖，一个文件）。
        </Text>
        <Text style={[styles.label, { color: palette.dim }]}>执行代理地址</Text>
        <TextInput
          value={draft.sandboxUrl}
          onChangeText={value => patch({ sandboxUrl: value.trim() })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://127.0.0.1:7717 或 https://box.example.com"
          placeholderTextColor={palette.dim}
          style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
        <Text style={[styles.label, { color: palette.dim }]}>执行代理 token</Text>
        <TextInput
          value={draft.sandboxToken}
          onChangeText={value => patch({ sandboxToken: value.trim() })}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="启动代理时设的 DSH_EXEC_TOKEN"
          placeholderTextColor={palette.dim}
          style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />
        <View style={styles.chipRow}>
          <Pressable onPress={testSandbox} style={[styles.chip, { borderColor: palette.line }]}>
            {sandboxProbe.kind === 'running'
              ? <ActivityIndicator color={palette.accent} />
              : <Text style={[styles.chipText, { color: palette.accent }]}>测试执行代理</Text>}
          </Pressable>
        </View>
        {sandboxProbe.message !== undefined && (
          <Text style={[styles.hint, { color: sandboxProbe.ok === true ? '#34c759' : palette.danger }]}>
            {sandboxProbe.message}
          </Text>
        )}

        <Text style={[styles.section, { color: palette.dim }]}>联网搜索</Text>
        <View style={styles.chipRow}>
          {(['off', 'self', 'deepseek', 'exa', 'perplexity'] as const).map(provider => (
            <Pressable
              key={provider}
              onPress={() => patch({ searchProvider: provider })}
              style={[styles.chip, { borderColor: provider === draft.searchProvider ? palette.accent : palette.line }]}
            >
              <Text style={[styles.chipText, { color: provider === draft.searchProvider ? palette.accent : palette.dim }]}>
                {provider === 'off' ? '关闭'
                  : provider === 'self' ? '自建搜索代理'
                    : provider === 'deepseek' ? 'DeepSeek 原生'
                      : provider === 'exa' ? 'Exa' : 'Perplexity'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.hint, { color: palette.dim }]}>
          开着才会多出 web_search 工具（只读，不打扰你）。
          这几家就是桌面 DSH 的 provider 家族（deepseek / exa / perplexity），线格式照原版对齐。
        </Text>
        <Text style={[styles.hint, { color: palette.dim }]}>
          **自建**（推荐）：把 server/search-agent.mjs 跑在一台自己能控制的机器上，不依赖第三方搜索 API。
          默认引擎是 Bing 的 RSS 输出（真 URL、不怕改版）；实测这张网络里 DuckDuckGo / Brave / 360 全部直接超时。
        </Text>
        <Text style={[styles.hint, { color: palette.dim }]}>
          **DeepSeek 原生搜索**：走服务端搜索工具（Anthropic 兼容端点），一次搜索等于一次模型回合，
          慢且计费；而且不是每个 Key 都能用 —— 报「没有触发联网搜索」就是这条不通。
          **Exa / Perplexity**：要各自的 API Key，按量计费。
        </Text>
        {draft.searchProvider === 'exa' && (
          <>
            <Text style={[styles.label, { color: palette.dim }]}>Exa API Key</Text>
            <TextInput
              value={draft.exaApiKey}
              onChangeText={value => patch({ exaApiKey: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="exa-…"
              placeholderTextColor={palette.dim}
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
          </>
        )}
        {draft.searchProvider === 'perplexity' && (
          <>
            <Text style={[styles.label, { color: palette.dim }]}>Perplexity API Key</Text>
            <TextInput
              value={draft.perplexityApiKey}
              onChangeText={value => patch({ perplexityApiKey: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="pplx-…"
              placeholderTextColor={palette.dim}
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
          </>
        )}
        {draft.searchProvider === 'self' && (
          <>
            <Text style={[styles.label, { color: palette.dim }]}>搜索代理地址</Text>
            <TextInput
              value={draft.searchAgentUrl}
              onChangeText={value => patch({ searchAgentUrl: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="http://127.0.0.1:7718 或 https://box.example.com"
              placeholderTextColor={palette.dim}
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
            <Text style={[styles.label, { color: palette.dim }]}>搜索代理 token</Text>
            <TextInput
              value={draft.searchAgentToken}
              onChangeText={value => patch({ searchAgentToken: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="启动代理时设的 DSH_SEARCH_TOKEN"
              placeholderTextColor={palette.dim}
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
            <View style={styles.chipRow}>
              {(['bing', 'sogou'] as const).map(engine => (
                <Pressable
                  key={engine}
                  onPress={() => patch({ searchEngine: engine })}
                  style={[styles.chip, { borderColor: engine === draft.searchEngine ? palette.accent : palette.line }]}
                >
                  <Text style={[styles.chipText, { color: engine === draft.searchEngine ? palette.accent : palette.dim }]}>
                    {engine === 'bing' ? 'Bing（RSS，推荐）' : '搜狗'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
        {draft.searchProvider === 'deepseek' && (
          <>
            <Text style={[styles.label, { color: palette.dim }]}>搜索端点</Text>
            <TextInput
              value={draft.searchBaseUrl}
              onChangeText={value => patch({ searchBaseUrl: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
            <Text style={[styles.label, { color: palette.dim }]}>搜索模型</Text>
            <TextInput
              value={draft.searchModel}
              onChangeText={value => patch({ searchModel: value.trim() })}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
            />
          </>
        )}

        <Text style={[styles.section, { color: palette.dim }]}>连通性自检</Text>
        <Text style={[styles.hint, { color: palette.dim }]}>
          这个 App 有四条要联网才能用的链路：模型、搜索、远程执行、MCP。任何一条断了，
          你看到的都只是一句底层报错。点一下，它会告诉你每条通不通、以及下一步该做什么。
        </Text>
        <View style={styles.chipRow}>
          <Pressable onPress={runChecks} style={[styles.chip, { borderColor: palette.line }]}>
            {checks.kind === 'running'
              ? <ActivityIndicator color={palette.accent} />
              : <Text style={[styles.chipText, { color: palette.accent }]}>跑一遍自检</Text>}
          </Pressable>
        </View>
        {checks.kind === 'done' && (
          <View style={[styles.checkList, { borderColor: palette.line, backgroundColor: palette.card }]}>
            <Text style={[styles.checkSummary, { color: palette.fg }]}>{checks.summary}</Text>
            {checks.results.map(result => (
              <View key={result.id} style={styles.checkRow}>
                <Text style={[styles.checkMark, {
                  color: result.status === 'ok' ? '#34c759' : result.status === 'fail' ? palette.danger : palette.dim,
                }]}>
                  {result.status === 'ok' ? '✓' : result.status === 'fail' ? '✕' : '—'}
                </Text>
                <View style={styles.checkBody}>
                  <Text style={[styles.checkLabel, { color: palette.fg }]}>{result.label}</Text>
                  <Text style={[styles.checkDetail, { color: palette.dim }]}>{result.detail}</Text>
                  {result.hint !== undefined && (
                    <Text style={[styles.checkHint, { color: palette.accent }]}>{result.hint}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        <Text style={[styles.section, { color: palette.dim }]}>MCP 服务器（可选）</Text>
        <Text style={[styles.hint, { color: palette.dim }]}>
          一行一台：<Text style={{ fontFamily: 'Menlo' }}>名字 url [token]</Text>。只支持 streamable-http
          （iOS 起不了本地进程，stdio 的 MCP 用不了）。工具会以
          {' '}<Text style={{ fontFamily: 'Menlo' }}>mcp__名字__工具</Text> 出现在清单里。
        </Text>
        <TextInput
          value={draft.mcpLines}
          onChangeText={value => patch({ mcpLines: value })}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={'# fs https://mcp.example.com/mcp sk-xxxx\ndocs http://127.0.0.1:3000/mcp'}
          placeholderTextColor={palette.dim}
          style={[styles.textarea, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line, minHeight: 84 }]}
        />
        {mcpError(draft.mcpLines) !== null && (
          <Text style={[styles.hint, { color: palette.danger }]}>{mcpError(draft.mcpLines)}</Text>
        )}
        <View style={styles.chipRow}>
          <Pressable onPress={testMcp} style={[styles.chip, { borderColor: palette.line }]}>
            {mcpProbe.kind === 'running'
              ? <ActivityIndicator color={palette.accent} />
              : <Text style={[styles.chipText, { color: palette.accent }]}>测试并拉取工具清单</Text>}
          </Pressable>
        </View>
        {mcpProbe.message !== undefined && (
          <Text style={[styles.hint, { color: mcpProbe.ok === true ? '#34c759' : palette.danger }]}>
            {mcpProbe.message}
          </Text>
        )}

        <Text style={[styles.section, { color: palette.dim }]}>人设</Text>
        {BUILTIN_PRESETS.map(preset => (
          <Pressable
            key={preset.id}
            onPress={() => patch({ presetId: preset.id, systemPrompt: preset.systemPrompt })}
            style={[styles.presetRow, {
              borderColor: preset.id === draft.presetId ? palette.accent : palette.line,
              backgroundColor: palette.card,
            }]}
          >
            <Text style={[styles.presetName, { color: palette.fg }]}>{preset.name}</Text>
            <Text style={[styles.presetSummary, { color: palette.dim }]}>{preset.summary}</Text>
          </Pressable>
        ))}

        <Text style={[styles.label, { color: palette.dim }]}>系统提示词（可直接改）</Text>
        <TextInput
          value={draft.systemPrompt}
          onChangeText={value => patch({ systemPrompt: value })}
          multiline
          style={[styles.textarea, { backgroundColor: palette.card, color: palette.fg, borderColor: palette.line }]}
        />

        <Pressable style={[styles.primary, { backgroundColor: palette.accent }]} onPress={() => onSave(draft)}>
          <Text style={styles.primaryText}>保存</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingHorizontal: 18, gap: 8 },
  checkList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 10 },
  checkSummary: { fontSize: 14, fontWeight: '600' },
  checkRow: { flexDirection: 'row', gap: 8 },
  checkMark: { fontSize: 14, lineHeight: 20, width: 14 },
  checkBody: { flex: 1, gap: 2 },
  checkLabel: { fontSize: 13.5, fontWeight: '600' },
  checkDetail: { fontSize: 12, lineHeight: 17 },
  checkHint: { fontSize: 12, lineHeight: 17 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 26, fontWeight: '800' },
  link: { fontSize: 15 },
  section: { fontSize: 12.5, marginTop: 18, textTransform: 'uppercase' },
  label: { fontSize: 12.5, marginTop: 8 },
  input: { height: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 15 },
  textarea: { minHeight: 130, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, fontSize: 13.5, lineHeight: 19 },
  hint: { fontSize: 11.5, lineHeight: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, minHeight: 30, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 13 },
  presetRow: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 3 },
  presetName: { fontSize: 15, fontWeight: '600' },
  presetSummary: { fontSize: 12.5 },
  primary: { height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  primaryText: { color: '#ffffff', fontSize: 16.5, fontWeight: '600' },
})
