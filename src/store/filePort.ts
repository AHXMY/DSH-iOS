/**
 * 文件端口：存储层与"手机文件系统"之间唯一的缝。
 *
 * 为什么要多这一层 —— 因为**手机上的数据丢失是最不能靠"看着对"来保证的事**。
 * 会话日志要是写坏了、索引要是和日志对不上，用户下次打开 App 就是历史没了，
 * 而这种 bug 在真机上根本没法稳定复现：它出在"写到一半被杀"、出在"索引比日志旧一行"，
 * 不是出在某个按钮点下去的那一刻。
 *
 * 所以这一层把"文件系统"缩成 8 个同步方法，于是三件事成为可能：
 *
 *   1. **整套存储逻辑能在 Node 里跑完整测试**：内存端口一插，就能精确制造
 *      "最后一行写到一半被杀"（撕裂尾）、"中间某行坏了"、"索引写入失败"这类现场，
 *      而这些现场在真机上几乎造不出来。
 *   2. **真机与测试跑的是同一份逻辑**：`sessionStore.ts` 只认 `FilePort`，不 import expo，
 *      所以在 Node 里验过的路径就是手机上跑的路径，不是"另一套简化实现"。
 *   3. **换后端不动业务**：以后要换成异步 API、SQLite 或加密容器，只改这一个文件。
 *
 * 命名上刻意用同步方法：`expo-file-system` 的新 API（`File` / `Directory`）本身就是同步的，
 * 我们不需要为了"看起来现代"把它包成 Promise —— 事件日志的追加是顺序且必须立刻完成的，
 * 同步反而让"先写日志行、再更新索引"的次序在代码里一眼可见。
 */

/** 只取类型：`import type` 编译期就消失，所以本文件在 Node 下不会拖进 react-native。 */
import type { Directory, File } from 'expo-file-system'

export type FilePort = {
  /** 读文本；不存在返回 null */
  readText(path: string): string | null
  /** 整份写文本（覆盖） */
  writeText(path: string, text: string): void
  /** 追加一行（不覆盖）—— 事件日志靠它做到"只追加" */
  appendLine(path: string, line: string): void
  /** 列目录下的文件名（不含路径）；目录不存在返回 [] */
  list(dir: string): string[]
  exists(path: string): boolean
  remove(path: string): void
  /** 建目录（含中间层级），已存在不报错 */
  ensureDir(dir: string): void
}

// ─────────────────────────────────────────────────────────────
// 内存端口（Node 测试专用）
//
// 故意不做"半吊子模拟"：这里的实现要能支撑撕裂尾、损坏行、写入失败这些注入测试，
// 所以它就是个老老实实的 Map<string, string>，路径一律当作不透明字符串处理
// （测试里用 '/' 拼路径，和真机 URL 的观感也一致）。

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '' : path.slice(0, index)
}

export function createMemoryFilePort(initial?: Record<string, string>): FilePort {
  const files = new Map<string, string>()
  for (const [path, text] of Object.entries(initial ?? {})) files.set(path, text)

  return {
    readText(path: string): string | null {
      const text = files.get(path)
      return text === undefined ? null : text
    },

    writeText(path: string, text: string): void {
      const parent = parentOf(path)
      // 与真机一致：父目录不在就直接失败，不替调用方"顺手建目录"。
      // 否则"忘了 ensureDir"这类错误在测试里会被藏起来，到手机上才炸。
      if (parent !== '' && ![...files.keys()].some(key => key.startsWith(`${parent}/`))) {
        throw new Error(`目录不存在：${parent}`)
      }
      files.set(path, text)
    },

    appendLine(path: string, line: string): void {
      const previous = files.get(path) ?? ''
      const separator = previous !== '' && !previous.endsWith('\n') ? '\n' : ''
      files.set(path, `${previous}${separator}${line}\n`)
    },

    list(dir: string): string[] {
      const prefix = `${dir}/`
      const names = new Set<string>()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (rest === '' || rest.includes('/')) continue
        names.add(rest)
      }
      return [...names]
    },

    exists(path: string): boolean {
      if (files.has(path)) return true
      // 目录存在的判据：有文件挂在它下面
      const prefix = `${path}/`
      return [...files.keys()].some(key => key.startsWith(prefix))
    },

    remove(path: string): void {
      if (files.delete(path)) return
      const prefix = `${path}/`
      const children = [...files.keys()].filter(key => key.startsWith(prefix))
      if (children.length === 0) throw new Error(`要删的东西不存在：${path}`)
      for (const child of children) files.delete(child)
    },

    ensureDir(dir: string): void {
      if (dir === '' || files.has(`${dir}/`)) return
      // 用一个空目录标记把"目录存在但空"表达出来，否则 ensureDir 之后 exists 还是 false。
      files.set(`${dir}/`, '')
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Expo 端口（真机）
//
// 新 API 的几个坑都在这里收掉：
//   · `File.write` 只覆盖、不追加 —— 追加要走 `write(text, { append: true })`；
//   · 追加到**不存在**的文件容易踩平台差异（iOS 上 append 语意是"打开并定位到尾部"），
//     所以第一次写先 `create({ intermediates: true })`，再 append，别赌；
//   · `Directory.list()` 在目录不存在时**抛错**，而端口约定是返回 [] —— 自己兜住；
//   · `File` / `Directory` 的构造函数只做路径拼接、不碰盘，所以可以随便 new。
//
// 还有一条更要紧的纪律：**`expo-file-system` 只能延迟加载，不能写成顶层 import**。
// 它一路会拽进 `react-native`（Flow 语法写的源码），而我们的测试跑在 Node 里，
// 顶层 import 会让整个测试脚本在转译阶段就炸 —— 那样"存储逻辑能在 Node 里被测试"
// 这件事就白设计了。延迟加载让本文件在 Node 下只做纯类型工作（`import type` 编译期即消失）。

type ExpoFileSystem = typeof import('expo-file-system')

let cachedExpo: ExpoFileSystem | null = null

/**
 * 只在真机真的要用文件时才去加载原生模块。
 *
 * 除了上面的 Node 兼容问题，它还有个附带好处：App 冷启动时不必为了读一次会话列表
 * 就把整个原生文件系统模块拖进内存。
 */
function expoFileSystem(): ExpoFileSystem {
  if (cachedExpo === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedExpo = require('expo-file-system') as ExpoFileSystem
  }
  return cachedExpo
}

/**
 * 把端口里的"相对路径"接到一个根目录上（默认 `Paths.document/dsh-store`）。
 *
 * 已经是绝对路径（`file://`、`/x`）的原样放行 —— 测试与调试要能指到任意位置，
 * 而"路径长什么样"这件事只在这一层需要知道。
 */
function joinPath(baseDir: string, path: string): string {
  if (path === '') return baseDir
  if (path.startsWith('file://') || path.startsWith('/')) return path
  return baseDir.endsWith('/') ? `${baseDir}${path}` : `${baseDir}/${path}`
}

export function createExpoFilePort(baseDir = 'dsh-store'): FilePort {
  const fileFor = (path: string) => {
    const { File } = expoFileSystem()
    return new File(joinPath(baseDir, path))
  }
  const dirFor = (path: string) => {
    const { Directory } = expoFileSystem()
    return new Directory(joinPath(baseDir, path))
  }

  return {
    readText(path: string): string | null {
      const file = fileFor(path)
      if (!file.exists) return null
      return file.textSync()
    },

    writeText(path: string, text: string): void {
      const file = fileFor(path)
      // 不存在就先建（含中间目录），存在则直接覆盖 —— write 的默认语义就是覆盖。
      if (!file.exists) file.create({ intermediates: true })
      file.write(text)
    },

    appendLine(path: string, line: string): void {
      const file = fileFor(path)
      const raw = file.exists ? file.textSync() : ''
      if (!file.exists) file.create({ intermediates: true })
      // 上一次写到一半被杀的话，文件末尾会留一个没有换行的半行。
      // 先补一个换行，让那半行独占一行 —— 这样加载时它会被判成"撕裂尾"丢弃，
      // 而不是和我们刚写的这行粘成一行、把两条事件一起毁掉。
      const separator = raw !== '' && !raw.endsWith('\n') ? '\n' : ''
      file.write(`${separator}${line}\n`, { append: true })
    },

    list(dir: string): string[] {
      const directory = dirFor(dir)
      if (!directory.exists) return []
      return directory.list().map(entry => entry.name)
    },

    exists(path: string): boolean {
      return fileFor(path).exists || dirFor(path).exists
    },

    remove(path: string): void {
      const file = fileFor(path)
      if (file.exists) {
        file.delete()
        return
      }
      const directory = dirFor(path)
      if (directory.exists) {
        directory.delete()
        return
      }
      // 与内存端口一致：删不存在的东西是错误，不是静默放过。
      throw new Error(`要删的东西不存在：${path}`)
    },

    ensureDir(dir: string): void {
      const directory = dirFor(dir)
      // idempotent 才是"已存在不报错"，intermediates 只管中间层级。
      directory.create({ intermediates: true, idempotent: true })
    },
  }
}
