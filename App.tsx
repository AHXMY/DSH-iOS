/**
 * DSH-iOS 入口。
 *
 * 这一版的定位：**DSH 自己跑在 iPhone 上**。
 * 没有电脑、没有服务器、没有隧道 —— agent 循环、工具执行、会话记录全在本机，
 * 模型请求直连 API。所以打开就能用，飞机上也一样（只要网络能到 API）。
 *
 * 代价讲清楚：桌面版那套 shell / git / 仓库编辑在 iOS 上不存在（系统不给子进程），
 * 这里的工具是手机自己的：沙盒文件、剪贴板、联网抓取、通知、语音、计算，
 * 外加会话自身的簿记（技能、待办、计划模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Share, useColorScheme, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { Directory, File, Paths } from 'expo-file-system'
import { streamCompletion } from './src/agent/deepseek'
import { runAgent } from './src/agent/loop'
import type { AgentEvent, ApprovalGate } from './src/agent/loop'
import { SessionLog } from './src/agent/sessionLog'
import { appendMessageEvent, deriveMessages } from './src/agent/surface'
import { SandboxClient } from './src/agent/sandbox'
import { connectMcpServers, describeMcpRegistration } from './src/agent/mcpTools'
import type { McpRegistration } from './src/agent/mcpTools'
import { exportFileName, sessionToMarkdown } from './src/agent/sessionExport'
import { createSubagentSpawner } from './src/agent/subagent'
import { formatTokens } from './src/agent/tokens'
import { createDeepSeekSearchProvider } from './src/agent/webSearch'
import { createSelfHostedSearchProvider } from './src/agent/searchSelfHosted'
import { createExaSearchProvider, createPerplexitySearchProvider } from './src/agent/searchProviders'
import { createTools } from './src/agent/tools'
import type { SkillEntry } from './src/agent/tools'
import type { ApprovalDecision, ApprovalRequest, AskRequest, ChatMessage, Session } from './src/agent/types'
import {
  BUILTIN_PRESETS, loadSessions, loadSettings, newSession, saveSessions, saveSettings, titleFrom, trimMessages,
} from './src/store/sessions'
import type { LlmSettings, Preset } from './src/store/sessions'
import { loadSkills, modelInvocableSkills } from './src/store/skills'
import type { Skill } from './src/store/skills'
import { ChatScreen } from './src/ui/ChatScreen'
import type { LiveAssistant } from './src/ui/ChatScreen'
import { ActionSheet, ApprovalDialog, AskDialog, PlanDialog, TodoSheet } from './src/ui/Dialogs'
import { SessionListScreen } from './src/ui/SessionListScreen'
import { SettingsScreen } from './src/ui/SettingsScreen'
import { SkillsScreen } from './src/ui/SkillsScreen'
import { paletteFor } from './src/ui/theme'

const LIVE_ID = 'live-assistant'

const EMPTY_MCP: McpRegistration = { connected: [], failures: [], tools: [], close: () => {} }

type Route = 'list' | 'chat' | 'settings' | 'skills'

/** 循环在等人回答时就停在这里；用户点了什么，就 resolve 什么。 */
type PendingDialog =
  | { kind: 'approval', request: ApprovalRequest, resolve: (decision: ApprovalDecision) => void }
  | { kind: 'ask', request: AskRequest, resolve: (answer: string) => void }
  | { kind: 'plan', plan: string, resolve: (approved: boolean) => void }

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export default function App() {
  const scheme = useColorScheme()
  const palette = paletteFor(scheme === 'dark' ? 'dark' : 'light')

  const [settings, setSettings] = useState<LlmSettings | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [ready, setReady] = useState(false)
  const [route, setRoute] = useState<Route>('list')
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveAssistant | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<PendingDialog | null>(null)
  const [context, setContext] = useState<{ tokens: number, budget: number }>({ tokens: 0, budget: 24_000 })
  const [menuOpen, setMenuOpen] = useState(false)
  const [todoOpen, setTodoOpen] = useState(false)

  const [mcp, setMcp] = useState<McpRegistration>(EMPTY_MCP)
  const mcpRef = useRef<McpRegistration>(EMPTY_MCP)

  const activeRef = useRef<Session | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  /** 配了 MCP 才连；配置一变就断开重连（服务端可能已经不是原来那台了）。 */
  useEffect(() => {
    if (settings === null) return
    let cancelled = false

    const swap = (next: McpRegistration): void => {
      mcpRef.current.close()
      mcpRef.current = next
      setMcp(next)
    }

    if (settings.mcpLines.trim() === '') {
      swap(EMPTY_MCP)
      return
    }

    void (async () => {
      const next = await connectMcpServers(settings.mcpLines)
      if (cancelled) {
        next.close()
        return
      }
      swap(next)
      if (next.failures.length > 0 || next.connected.length > 0) {
        setNotice(`MCP：${describeMcpRegistration(next)}`)
      }
    })()

    return () => { cancelled = true }
  }, [settings?.mcpLines, settings])

  /** 配了远程执行代理才会有 —— 手机跑不了 shell，但可以指挥一台跑得动的机器。 */
  const sandbox = useMemo(() => {
    if (settings === null) return null
    if (settings.sandboxUrl.trim() === '' || settings.sandboxToken.trim() === '') return null
    return new SandboxClient({
      url: settings.sandboxUrl.trim(),
      token: settings.sandboxToken.trim(),
      label: '远程沙箱',
    })
  }, [settings?.sandboxUrl, settings?.sandboxToken])

  /** 联网搜索：四条路 —— 自建代理 / DeepSeek 原生 / Exa / Perplexity（与原版 provider 家族对齐）。 */
  const search = useMemo(() => {
    if (settings === null) return null
    if (settings.searchProvider === 'deepseek') {
      if (settings.apiKey.trim() === '') return null
      return createDeepSeekSearchProvider({
        apiKey: settings.apiKey,
        baseUrl: settings.searchBaseUrl,
        model: settings.searchModel,
      })
    }
    if (settings.searchProvider === 'self') {
      if (settings.searchAgentUrl.trim() === '' || settings.searchAgentToken.trim() === '') return null
      return createSelfHostedSearchProvider({
        url: settings.searchAgentUrl.trim(),
        token: settings.searchAgentToken.trim(),
        engine: settings.searchEngine,
      })
    }
    if (settings.searchProvider === 'exa') {
      if (settings.exaApiKey.trim() === '') return null
      return createExaSearchProvider({ apiKey: settings.exaApiKey.trim() })
    }
    if (settings.searchProvider === 'perplexity') {
      if (settings.perplexityApiKey.trim() === '') return null
      return createPerplexitySearchProvider({ apiKey: settings.perplexityApiKey.trim() })
    }
    return null
  }, [
    settings?.searchProvider, settings?.apiKey, settings?.searchBaseUrl, settings?.searchModel,
    settings?.searchAgentUrl, settings?.searchAgentToken, settings?.searchEngine,
    settings?.exaApiKey, settings?.perplexityApiKey,
  ])

  // 技能、沙箱、搜索、MCP 任一变化都要重建工具：工具清单直接进系统提示词，不重建就是过期信息。
  const tools = useMemo(() => {
    const entries: SkillEntry[] = modelInvocableSkills(skills).map(skill => ({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      modelInvocable: skill.modelInvocable,
    }))
    return [...createTools({ skills: entries, sandbox, search }), ...mcp.tools]
  }, [skills, sandbox, search, mcp])

  const refreshSkills = useCallback(() => { setSkills(loadSkills()) }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const storedSettings = await loadSettings()
      if (!alive) return
      setSettings(storedSettings)
      setSessions(loadSessions())
      setSkills(loadSkills())
      setReady(true)
    })()
    return () => { alive = false }
  }, [])

  /** 会话状态的唯一写入口：先改 ref（agent 循环读的是它），再发布快照并落盘。 */
  const publish = useCallback((session: Session) => {
    activeRef.current = session
    setSessions(current => {
      const next = current.some(item => item.id === session.id)
        ? current.map(item => (item.id === session.id ? { ...session, messages: [...session.messages] } : item))
        : [{ ...session, messages: [...session.messages] }, ...current]
      saveSessions(next)
      return next
    })
  }, [])

  const appendMessage = useCallback((message: ChatMessage) => {
    const session = activeRef.current
    if (session === null) return
    session.messages = trimMessages([...session.messages, message])
    session.updatedAt = Date.now()
    if (message.role === 'user' && message.summary !== true && session.title === '新会话') {
      session.title = titleFrom(message.text)
    }
    publish(session)
  }, [publish])

  const openSession = useCallback((sessionId: string) => {
    const found = sessions.find(item => item.id === sessionId)
    if (found === undefined) return
    activeRef.current = found
    setActiveId(sessionId)
    setRoute('chat')
    setError(null)
    setNotice(null)
    setContext(current => ({ ...current, tokens: 0 }))
  }, [sessions])

  const createSession = useCallback((preset: Preset) => {
    if (settings === null) return
    const session = newSession({ ...settings, systemPrompt: preset.systemPrompt, presetId: preset.id })
    setSessions(current => {
      const next = [session, ...current]
      saveSessions(next)
      return next
    })
    activeRef.current = session
    setActiveId(session.id)
    setRoute('chat')
    setError(null)
    setNotice(null)
  }, [settings])

  const deleteSession = useCallback((sessionId: string) => {
    setSessions(current => {
      const next = current.filter(item => item.id !== sessionId)
      saveSessions(next)
      return next
    })
    if (activeId === sessionId) {
      activeRef.current = null
      setActiveId(null)
      setRoute('list')
    }
  }, [activeId])

  /** 跑一轮：上下文从事件日志派生，事件落盘失败就中止（fail-closed）。 */
  const runTurn = useCallback((session: Session) => {
    if (settings === null) return
    /**
     * 过渡桥：把当前会话的历史装进事件日志，让循环按日志驱动跑。
     *
     * 为什么是桥而不是当场换掉存储：存储层（JSONL 事件日志 + 派生索引）已经写好并验证过，
     * 但把 App 的会话生命周期整体搬过去是独立的一批改动。这里先保证**循环**已经是日志驱动的
     * （压缩遮蔽、执行前记录、请求信封、fail-closed 都在这层生效），
     * 会话落盘仍是老路径 —— 下一批把 store 接上，这几行删掉即可。
     */
    const turnLog = new SessionLog()
    for (const message of session.messages) appendMessageEvent(turnLog, message)
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    setLive({
      message: { id: LIVE_ID, role: 'assistant', text: '', reasoning: '', createdAt: Date.now() },
      toolStates: {},
    })

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case 'step-start':
          setLive({
            message: { id: LIVE_ID, role: 'assistant', text: '', reasoning: '', createdAt: Date.now() },
            toolStates: {},
          })
          break
        case 'text-delta':
          setLive(current => current === null
            ? current
            : { ...current, message: { ...current.message, text: current.message.text + event.text } })
          break
        case 'reasoning-delta':
          setLive(current => current === null
            ? current
            : { ...current, message: { ...current.message, reasoning: (current.message.reasoning ?? '') + event.text } })
          break
        case 'context':
          setContext({ tokens: event.tokens, budget: event.budget })
          break
        case 'compaction-start':
          setNotice(`上下文约 ${formatTokens(event.tokens)} token，超过预算，正在把更早的对话压成摘要…`)
          break
        case 'compaction-done':
          setNotice(event.summary === null
            ? '压缩没能生成摘要，已改为裁剪旧工具输出。'
            : `历史已压缩：${event.replacedCount} 条 → 1 条摘要，上下文约 ${formatTokens(event.tokensAfter)} token。`)
          break
        case 'context-rewritten':
          // 压缩/裁剪写的是遮蔽事件：旧事件还在日志里，只是不再出现在模型可见列表里。
          publish(session)
          break
        case 'state-changed':
          publish(session)
          break
        case 'error':
          setError(event.message)
          break
        case 'done':
          if (event.reason === 'step-limit') setNotice('到工具调用步数上限了，再发一句可以接着往下做。')
          break
        default:
          break
      }
    }

    void (async () => {
      const config = {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: session.model,
        temperature: settings.temperature,
      }
      // 审批通道全 App 一个：主循环与子代理共用，所以"允许一次"对谁都算数，
      // 而子代理的请求会在弹框上标明来源。
      const approvalGate: ApprovalGate = {
        mode: settings.approvalMode,
        request: request => new Promise<ApprovalDecision>(resolve => setDialog({ kind: 'approval', request, resolve })),
      }
      // 子代理的工具面里没有 subagent 自己 —— 防递归放大。
      const spawnSubagent = createSubagentSpawner({
        stream: streamCompletion,
        config,
        tools: tools.filter(tool => tool.name !== 'subagent'),
        persona: session.systemPrompt,
        state: session,
        approval: approvalGate,
        signal: controller.signal,
        contextBudget: settings.contextBudget,
        label: '子代理',
      })

      try {
        await runAgent({
          log: turnLog,
          /**
           * 过渡桥：把新事件同步回老存储的消息数组。
           *
           * 事件日志这一层已经是唯一真相（压缩遮蔽、执行前记录、请求信封都在它上面），
           * 但 App 的会话持久化整体搬到 `sessionStore` 是独立的一批改动。
           * 这里先把**派生结果**写回老路径，界面上看到的行为已经全部是新机制；
           * 下一批把 store 接上，这几行删掉即可。
           */
          commit: () => {
            const derived = deriveMessages(turnLog.all())
            session.messages = derived
            session.updatedAt = Date.now()
            publish(session)
          },
          stream: streamCompletion,
          persona: session.systemPrompt,
          config,
          tools,
          skills: modelInvocableSkills(skills).map(skill => ({ name: skill.name, description: skill.description })),
          state: session,
          approval: approvalGate,
          ask: request => new Promise<string>(resolve => setDialog({ kind: 'ask', request, resolve })),
          approvePlan: plan => new Promise<boolean>(resolve => setDialog({ kind: 'plan', plan, resolve })),
          spawnSubagent,
          sandboxLabel: sandbox === null ? undefined : sandbox.label,
          contextBudget: settings.contextBudget,
          signal: controller.signal,
          emit: onEvent,
          onStateChange: () => publish(session),
        })
      } finally {
        abortRef.current = null
        setBusy(false)
        setLive(null)
        setDialog(null)
      }
    })()
  }, [settings, tools, skills, appendMessage, publish])

  const send = useCallback((text: string) => {
    const session = activeRef.current
    if (session === null || settings === null || busy) return
    if (settings.apiKey.trim() === '') {
      setError('先去设置里填 API Key。')
      setRoute('settings')
      return
    }
    appendMessage({ id: newId('u'), role: 'user', text, createdAt: Date.now() })
    runTurn(session)
  }, [settings, busy, appendMessage, runTurn])

  /** 重新生成：把最后一条用户消息之后的全部丢弃，按同一上下文重跑。 */
  const regenerate = useCallback(() => {
    const session = activeRef.current
    if (session === null || busy) return
    const reversed = [...session.messages].reverse()
    const offset = reversed.findIndex(message => message.role === 'user' && message.summary !== true)
    if (offset === -1) return
    session.messages = session.messages.slice(0, session.messages.length - offset)
    publish(session)
    runTurn(session)
  }, [busy, publish, runTurn])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setBusy(false)
    setDialog(current => {
      if (current?.kind === 'approval') current.resolve('deny')
      else if (current?.kind === 'ask') current.resolve('')
      else if (current?.kind === 'plan') current.resolve(false)
      return null
    })
  }, [])

  /** 导出会话：写进 App 的 exports 目录，再交给系统分享面板（存到「文件」、发出去都行）。 */
  const exportSession = useCallback(async () => {
    const session = activeRef.current
    if (session === null) return
    try {
      const dir = new Directory(Paths.document, 'exports')
      if (!dir.exists) dir.create({ intermediates: true })
      const file = new File(dir, exportFileName(session))
      if (!file.exists) file.create()
      file.write(sessionToMarkdown(session))
      await Share.share({ url: file.uri, title: session.title })
    } catch (cause) {
      setError(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }, [])

  const saveSettingsAndReturn = useCallback((next: LlmSettings) => {
    setSettings(next)
    void saveSettings(next)
    const session = activeRef.current
    if (session !== null) {
      // 人设与模型是会话快照，改了设置就更新当前会话，别让"设置里改了却不起作用"发生。
      session.model = next.model
      session.systemPrompt = next.systemPrompt
      publish(session)
    }
    setRoute(activeRef.current === null ? 'list' : 'chat')
  }, [publish])

  const activeSession = activeId === null ? null : sessions.find(item => item.id === activeId) ?? null
  const effectiveRoute: Route = activeSession === null && route === 'chat' ? 'list' : route

  if (!ready || settings === null) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.bg }}>
          <ActivityIndicator color={palette.dim} />
        </View>
      </SafeAreaProvider>
    )
  }

  const needsKey = settings.apiKey.trim() === ''

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />

      {(effectiveRoute === 'settings' || needsKey) && (
        <SettingsScreen
          initial={settings}
          palette={palette}
          skillCount={skills.length}
          onOpenSkills={() => setRoute('skills')}
          onSave={saveSettingsAndReturn}
          onCancel={needsKey ? undefined : () => setRoute(activeSession === null ? 'list' : 'chat')}
        />
      )}

      {effectiveRoute === 'skills' && !needsKey && (
        <SkillsScreen
          skills={skills}
          palette={palette}
          onReload={refreshSkills}
          onClose={() => setRoute('settings')}
        />
      )}

      {effectiveRoute === 'list' && !needsKey && (
        <SessionListScreen
          sessions={sessions}
          presets={BUILTIN_PRESETS}
          palette={palette}
          onCreate={createSession}
          onOpen={openSession}
          onDelete={deleteSession}
          onOpenSettings={() => setRoute('settings')}
        />
      )}

      {effectiveRoute === 'chat' && activeSession !== null && !needsKey && (
        <ChatScreen
          session={activeSession}
          live={live}
          busy={busy}
          error={error}
          notice={notice}
          palette={palette}
          contextTokens={context.tokens}
          contextBudget={settings.contextBudget}
          onSend={send}
          onStop={stop}
          onBack={() => { setActiveId(null); activeRef.current = null; setRoute('list') }}
          onOpenMenu={() => setMenuOpen(true)}
          onDismissNotice={() => { setError(null); setNotice(null) }}
        />
      )}

      <ActionSheet
        visible={menuOpen}
        title={activeSession?.title}
        palette={palette}
        onClose={() => setMenuOpen(false)}
        actions={[
          { label: '待办', hint: activeSession === undefined || activeSession === null || activeSession.todos.length === 0 ? '空' : `${activeSession.todos.filter(todo => todo.status === 'done').length}/${activeSession.todos.length}`, onPress: () => setTodoOpen(true) },
          {
            label: activeSession?.planMode === true ? '退出计划模式' : '进入计划模式',
            hint: activeSession?.planMode === true ? '当前：只规划不执行' : '先规划再动手',
            onPress: () => {
              const session = activeRef.current
              if (session === null) return
              session.planMode = !session.planMode
              publish(session)
            },
          },
          { label: '重新生成', onPress: regenerate },
          { label: '导出 Markdown', hint: '分享 / 存到文件', onPress: () => { void exportSession() } },
          { label: '人设与模型', onPress: () => setRoute('settings') },
          {
            label: '清空本会话',
            destructive: true,
            onPress: () => {
              const session = activeRef.current
              if (session === null) return
              session.messages = []
              session.todos = []
              session.updatedAt = Date.now()
              publish(session)
            },
          },
        ]}
      />

      <TodoSheet
        visible={todoOpen}
        todos={activeSession?.todos ?? []}
        palette={palette}
        onClear={() => {
          const session = activeRef.current
          if (session === null) return
          session.todos = []
          publish(session)
        }}
        onClose={() => setTodoOpen(false)}
      />

      {dialog?.kind === 'approval' && (
        <ApprovalDialog
          request={dialog.request}
          palette={palette}
          onDecide={decision => { dialog.resolve(decision); setDialog(null) }}
        />
      )}
      {dialog?.kind === 'ask' && (
        <AskDialog
          request={dialog.request}
          palette={palette}
          onSubmit={answer => { dialog.resolve(answer); setDialog(null) }}
        />
      )}
      {dialog?.kind === 'plan' && (
        <PlanDialog
          plan={dialog.plan}
          palette={palette}
          onDecide={approved => { dialog.resolve(approved); setDialog(null) }}
        />
      )}
    </SafeAreaProvider>
  )
}
