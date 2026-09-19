#!/usr/bin/env node
/**
 * dsh-exec-agent —— 给手机版 DSH 用的远程执行代理（零依赖，一个文件）。
 *
 * 为什么需要它：iOS 不给子进程，所以手机上的 agent 永远跑不了 shell / git。
 * 但"跑不了"不等于"拿不回来"——把执行放到一台你自己的 Linux 机器上，
 * 手机只发 HTTP，能力就回来了。这个文件就是那台机器上要跑的东西。
 *
 * 协议（故意做到极小，够用就行）：
 *   GET    /health                       → { ok, root, platform, version }
 *   POST   /exec   {command,cwd?,timeoutMs?} → { stdout, stderr, exitCode, durationMs, timedOut }
 *   GET    /file?path=<相对路径>          → 文本内容
 *   PUT    /file   {path,content,append?} → { bytes }
 *   DELETE /file?path=<相对路径>          → { removed }
 *   GET    /tree?path=<相对路径>&depth=N  → { entries:[{path,type,size}] }
 *
 * 安全默认（别改成"方便"的样子）：
 *   · 必须带 Bearer token，没有 token 直接拒绝启动；
 *   · 默认只绑 127.0.0.1 —— 要暴露就给 nginx 套 TLS + 门禁，或者走 Tailscale；
 *   · 所有路径锁在 root 目录内，包含符号链接逃逸检查；
 *   · 请求体上限、输出上限、超时上限，都写死在这里。
 *
 * 单独跑：
 *   DSH_EXEC_TOKEN=xxx DSH_EXEC_ROOT=/home/ubuntu/workspace node server/exec-agent.mjs
 *   node server/exec-agent.mjs --token xxx --root /srv/ws --port 7717
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const VERSION = '1.0.0'
const MAX_OUTPUT = 64 * 1024
const MAX_BODY = 4 * 1024 * 1024
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

/** 恒定时间比较，避免 token 比对泄漏长度信息。 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

/**
 * 把请求路径解析到 root 之内。
 *
 * 只做字符串前缀判断是不够的：`link -> /etc` 这样的符号链接能绕过它。
 * 所以对"从目标向上第一个存在的祖先"求 realpath 再判一次 ——
 * 目标文件本身可能还不存在（写新文件），但它的祖先必须落在 root 里。
 */
function resolveInside(root, requested) {
  const cleaned = String(requested ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const absolute = resolve(root, cleaned)
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw Object.assign(new Error('路径越界：只允许访问 root 目录内的文件'), { status: 400 })
  }

  let probe = absolute
  for (;;) {
    try {
      const real = realpathSync(probe)
      if (real !== root && !real.startsWith(root + sep)) {
        throw Object.assign(new Error('路径越界：符号链接指向 root 之外'), { status: 400 })
      }
      return absolute
    } catch (cause) {
      if (cause && cause.status) throw cause
      // 这一级还不存在，往上找；到根还没找到就该拒绝。
      const parent = dirname(probe)
      if (parent === probe || probe === root) {
        throw Object.assign(new Error('路径越界：无法解析到 root 之内'), { status: 400 })
      }
      probe = parent
    }
  }
}

function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectPromise(Object.assign(new Error('请求体过大'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectPromise)
  })
}

function send(response, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * 跑一条命令，带上限：输出截断、超时连**子进程树**一起杀。
 *
 * "杀子进程树"不是讲究，是必须：命令往往是 `sh -c "npm run build"` 这种，
 * 只杀 shell 的话真正的进程还活着、还占着 stdout 管道，于是 close 事件永远不来，
 * 客户端就在那儿干等 —— 表现是"超时了但请求还是卡死"。
 */
function exec(command, options) {
  const { cwd, timeoutMs } = options
  return new Promise(resolvePromise => {
    const started = Date.now()
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'cmd' : 'sh'
    const args = isWindows ? ['/c', command] : ['-c', command]
    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, DSH_EXEC_AGENT: VERSION },
      // Windows 上必须 verbatim：Node 默认会给带空格的参数加引号并转义内部引号，
      // 而 cmd.exe 不认 `\"`，结果是命令被吃掉（退出码 0、没有任何输出）。
      windowsVerbatimArguments: isWindows,
      // POSIX 下开一个进程组，好让超时时能整组杀掉。
      detached: !isWindows,
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let timer = null
    let graceTimer = null

    const append = (chunk, target) => {
      if (target === 'out') {
        if (stdout.length >= MAX_OUTPUT) { truncated = true; return }
        stdout += chunk.toString('utf8')
        if (stdout.length > MAX_OUTPUT) { stdout = stdout.slice(0, MAX_OUTPUT); truncated = true }
      } else {
        if (stderr.length >= MAX_OUTPUT) { truncated = true; return }
        stderr += chunk.toString('utf8')
        if (stderr.length > MAX_OUTPUT) { stderr = stderr.slice(0, MAX_OUTPUT); truncated = true }
      }
    }

    child.stdout.on('data', chunk => append(chunk, 'out'))
    child.stderr.on('data', chunk => append(chunk, 'err'))

    const killTree = () => {
      if (isWindows) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }

    const finish = (exitCode, error) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      if (error !== undefined && error !== null && stderr === '') stderr = String(error.message ?? error)
      resolvePromise({
        stdout: truncated ? `${stdout}\n…（输出超过 ${MAX_OUTPUT} 字节，已截断）` : stdout,
        stderr,
        exitCode: timedOut ? 124 : exitCode,
        durationMs: Date.now() - started,
        timedOut,
      })
    }

    timer = setTimeout(() => {
      timedOut = true
      killTree()
      // 杀完树还可能因为管道没关而等不到 close —— 兜底自己收尾，绝不让请求悬着。
      graceTimer = setTimeout(() => finish(124, null), 2000)
    }, timeoutMs)

    child.on('error', error => finish(127, error))
    child.on('close', code => finish(code ?? 0, null))
  })
}

async function walk(root, target, depth, collected, maxDepth) {
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(target, entry.name)
    const info = await stat(absolute).catch(() => null)
    if (info === null) continue
    collected.push({
      path: relative(root, absolute).split(sep).join('/'),
      type: info.isDirectory() ? 'dir' : 'file',
      size: info.isDirectory() ? null : info.size,
    })
    if (info.isDirectory() && depth < maxDepth) await walk(root, absolute, depth + 1, collected, maxDepth)
  }
}

export function createExecAgent(options) {
  const root = resolve(options.root)
  const token = options.token
  const allowExec = options.allowExec !== false
  if (!token) throw new Error('必须配置 token：远程执行代理不允许无鉴权启动')

  return createServer(async (request, response) => {
    try {
      if (!sameToken(request.headers.authorization ?? '', `Bearer ${token}`)) {
        send(response, 401, { error: 'unauthorized' })
        return
      }

      const url = new URL(request.url ?? '/', 'http://localhost')

      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, root, platform: process.platform, version: VERSION, allowExec })
        return
      }

      if (request.method === 'POST' && url.pathname === '/exec') {
        if (!allowExec) { send(response, 403, { error: '这台代理被配置为禁止执行命令' }); return }
        const body = JSON.parse((await readBody(request)) || '{}')
        const command = String(body.command ?? '').trim()
        if (command === '') { send(response, 400, { error: 'command 不能为空' }); return }
        const cwd = body.cwd === undefined ? root : resolveInside(root, body.cwd)
        const requested = Number(body.timeoutMs ?? DEFAULT_TIMEOUT)
        const timeoutMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT, MAX_TIMEOUT)
        const result = await exec(command, { cwd, timeoutMs })
        send(response, 200, result)
        return
      }

      if (request.method === 'GET' && url.pathname === '/file') {
        const file = resolveInside(root, url.searchParams.get('path'))
        const info = await stat(file).catch(() => null)
        if (info === null || !info.isFile()) { send(response, 404, { error: '文件不存在' }); return }
        send(response, 200, await readFile(file, 'utf8'), 'text/plain; charset=utf-8')
        return
      }

      if (request.method === 'PUT' && url.pathname === '/file') {
        const body = JSON.parse((await readBody(request)) || '{}')
        const file = resolveInside(root, body.path)
        await mkdir(dirname(file), { recursive: true })
        const content = String(body.content ?? '')
        await writeFile(file, content, body.append === true ? { flag: 'a' } : undefined)
        send(response, 200, { bytes: Buffer.byteLength(content), path: relative(root, file).split(sep).join('/') })
        return
      }

      if (request.method === 'DELETE' && url.pathname === '/file') {
        const file = resolveInside(root, url.searchParams.get('path'))
        if (file === root) { send(response, 400, { error: '不能删除 root 本身' }); return }
        await rm(file, { recursive: true, force: true })
        send(response, 200, { removed: true })
        return
      }

      if (request.method === 'GET' && url.pathname === '/tree') {
        const target = resolveInside(root, url.searchParams.get('path') ?? '')
        const info = await stat(target).catch(() => null)
        if (info === null) { send(response, 404, { error: '目录不存在' }); return }
        if (!info.isDirectory()) { send(response, 400, { error: '不是目录' }); return }
        const depth = Math.min(Math.max(Number(url.searchParams.get('depth') ?? 2) || 2, 1), 6)
        const entries = []
        await walk(root, target, 1, entries, depth)
        entries.sort((left, right) => left.path.localeCompare(right.path))
        send(response, 200, { root, entries: entries.slice(0, 2000) })
        return
      }

      send(response, 404, { error: `没有这个端点：${request.method} ${url.pathname}` })
    } catch (cause) {
      const status = cause && typeof cause.status === 'number' ? cause.status : 500
      send(response, status, { error: String(cause?.message ?? cause) })
    }
  })
}

// 直接运行时才启动；被 import 时不启动（测试要 import 它拿 createExecAgent）。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const argOf = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : args[index + 1]
  }
  const port = Number(argOf('port', process.env.DSH_EXEC_PORT ?? 7717))
  const host = argOf('host', process.env.DSH_EXEC_HOST ?? '127.0.0.1')
  const root = argOf('root', process.env.DSH_EXEC_ROOT ?? join(homedir(), 'dsh-workspace'))
  const token = argOf('token', process.env.DSH_EXEC_TOKEN ?? '')

  await mkdir(root, { recursive: true })
  const server = createExecAgent({ root, token, allowExec: process.env.DSH_EXEC_NO_EXEC !== '1' })
  server.listen(port, host, () => {
    console.log(`dsh-exec-agent ${VERSION} 监听 http://${host}:${port}`)
    console.log(`工作目录 ${root}`)
    console.log(token === '' ? '警告：没有 token，任何请求都会 401' : '鉴权：Bearer token 已启用')
  })
}
