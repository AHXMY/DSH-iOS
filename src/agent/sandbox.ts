/**
 * 远程执行客户端：把 iOS 拿不到的那半边能力（shell / git / 真实文件树）接回来。
 *
 * 这里只做客户端，服务端是 `server/exec-agent.mjs` —— 一个零依赖的 Node 文件，
 * 丢到你自己的 Linux 机器上跑起来就行（不用第三方账号，不用 Docker）。
 *
 * 设计取舍：
 * · 不 import 任何 expo 模块 —— 这一层要能在 Node 里被完整测试（真起服务端跑命令）；
 * · 一个极小的自定协议，而不是硬贴某家 SDK：服务端换成别的实现，只要遵守同样的
 *   五个端点，上层工具一个都不用改（用户明确要求 provider 可换）；
 * · 所有调用都带超时；网络错误翻成人能看懂的话。
 */
import type { ToolRisk } from './types'

export type SandboxConfig = {
  /** 例如 http://127.0.0.1:7717 或 https://box.example.com/exec */
  url: string
  token: string
  /** 显示用标签 */
  label?: string
  /** 沙箱工具的默认影响面；默认 write（远程的东西一样会被改坏） */
  risk?: ToolRisk
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

export type TreeEntry = { path: string, type: 'file' | 'dir', size: number | null }

export class SandboxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SandboxError'
  }
}

const DEFAULT_TIMEOUT = 30_000

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

export class SandboxClient {
  constructor(private readonly config: SandboxConfig) {}

  get label(): string {
    return this.config.label ?? '远程沙箱'
  }

  /** 一次请求；把超时与网络错误翻成可读信息。 */
  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
    if (this.config.url.trim() === '') throw new SandboxError('没有配置远程执行地址')
    if (this.config.token.trim() === '') throw new SandboxError('没有配置远程执行 token')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(endpoint(this.config.url, path), {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw new SandboxError(`请求超时（${timeoutMs / 1000}s）`)
      throw new SandboxError(`连不上远程执行代理：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    if (!response.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { error?: unknown }
        if (typeof parsed.error === 'string') detail = parsed.error
      } catch { /* 保留原始文本 */ }
      if (response.status === 401) throw new SandboxError('远程执行代理拒绝了这次请求（token 不对）', 401)
      throw new SandboxError(`远程执行代理返回 ${response.status}：${detail}`, response.status)
    }

    if (text === '') return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      // /file 的 GET 返回纯文本，不是 JSON —— 由调用方自己取原文。
      return text as unknown as T
    }
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean, root: string, platform: string, version: string }> {
    void signal
    return this.request('/health', { method: 'GET' }, 10_000)
  }

  /** 在沙箱里跑一条 shell 命令。命令本身不设限制 —— 限制在服务端的 token 与目录上。 */
  async exec(command: string, options: { cwd?: string, timeoutMs?: number } = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? 120_000
    return this.request<ExecResult>(
      '/exec',
      { method: 'POST', body: JSON.stringify({ command, cwd: options.cwd, timeoutMs }) },
      // 客户端等得比服务端久一点，让服务端有机会把超时结果返回而不是被我们掐断。
      timeoutMs + 5_000,
    )
  }

  async readFile(path: string): Promise<string> {
    return this.request<string>('/file?' + new URLSearchParams({ path }).toString(), { method: 'GET' })
  }

  async writeFile(path: string, content: string, append = false): Promise<{ bytes: number, path: string }> {
    return this.request('/file', { method: 'PUT', body: JSON.stringify({ path, content, append }) })
  }

  async remove(path: string): Promise<{ removed: boolean }> {
    return this.request('/file?' + new URLSearchParams({ path }).toString(), { method: 'DELETE' })
  }

  async tree(path = '', depth = 2): Promise<{ root: string, entries: TreeEntry[] }> {
    return this.request('/tree?' + new URLSearchParams({ path, depth: String(depth) }).toString(), { method: 'GET' })
  }
}
