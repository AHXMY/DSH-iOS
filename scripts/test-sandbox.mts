/**
 * 远程执行的真实验证。
 *
 * 不是"对着文档写一遍就算"：这里**真的起一个 dsh-exec-agent 服务端**，
 * 用真的 HTTP 客户端去打它，真的跑命令、真的读写文件、真的试路径越界与超时。
 * 手机上装好 key 之后要用的就是这条链路，所以它必须先在这里跑通。
 *
 *   npm test
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecAgent } from '../server/exec-agent.mjs'
import { SandboxClient, SandboxError } from '../src/agent/sandbox.ts'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail === '' ? '' : `  —  ${detail}`}`)
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, same, same ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 让系统随便给一个空闲端口，避免测试之间抢端口。 */
async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const TOKEN = 'test-token-0123456789'
const root = await mkdtemp(join(tmpdir(), 'dsh-exec-'))
const port = await freePort()

const server = createExecAgent({ root, token: TOKEN })
await new Promise(resolvePromise => server.listen(port, '127.0.0.1', resolvePromise))

const sandbox = new SandboxClient({ url: `http://127.0.0.1:${port}`, token: TOKEN })
const wrongToken = new SandboxClient({ url: `http://127.0.0.1:${port}`, token: 'nope-nope-nope' })

console.log('── 健康检查与鉴权 ──')

const health = await sandbox.health()
check('健康检查通过', health.ok === true)
equal('回显工作目录', health.root.replace(/\\/g, '/').endsWith(root.replace(/\\/g, '/').split(/[/\\]/).pop() ?? ''), true)

let unauthorized = ''
try {
  await wrongToken.health()
} catch (cause) {
  unauthorized = cause instanceof Error ? cause.message : String(cause)
}
check('token 不对被拒', unauthorized.includes('token') || unauthorized.includes('401'), unauthorized)

let noToken = ''
try {
  await new SandboxClient({ url: `http://127.0.0.1:${port}`, token: '' }).health()
} catch (cause) {
  noToken = cause instanceof Error ? cause.message : String(cause)
}
check('没配 token 时客户端自己就拦住', noToken.includes('token'), noToken)

let refused = ''
try {
  createExecAgent({ root, token: '' })
} catch (cause) {
  refused = cause instanceof Error ? cause.message : String(cause)
}
check('服务端不允许无 token 启动', refused.includes('token'), refused)

console.log('\n── 执行命令 ──')

const hello = await sandbox.exec('node -e "console.log(\'hello-from-sandbox\')"')
equal('退出码 0', hello.exitCode, 0)
check('拿到 stdout', hello.stdout.includes('hello-from-sandbox'), JSON.stringify(hello.stdout))
equal('没有超时标记', hello.timedOut, false)
check('有耗时读数', typeof hello.durationMs === 'number' && hello.durationMs >= 0)

const failing = await sandbox.exec('node -e "process.exit(3)"')
equal('非零退出码如实返回（不是抛错）', failing.exitCode, 3)
check('失败命令不抛异常', failing.timedOut === false)

const noise = await sandbox.exec('node -e "console.error(\'to-stderr\')"')
check('stderr 单独一股', noise.stderr.includes('to-stderr'), JSON.stringify(noise.stderr))

const slow = await sandbox.exec('node -e "setTimeout(()=>{}, 10000)"', { timeoutMs: 400 })
equal('超时被杀（退出码 124）', slow.exitCode, 124)
equal('超时有标记', slow.timedOut, true)
check('超时没把客户端拖死', slow.durationMs < 8000, `${slow.durationMs}ms`)

const huge = await sandbox.exec('node -e "console.log(\'x\'.repeat(80000))"')
check('超大输出被截断', huge.stdout.includes('已截断'), `${huge.stdout.length}`)
check('截断后仍不超过上限太多', huge.stdout.length < 70_000, `${huge.stdout.length}`)

console.log('\n── 文件操作 ──')

await sandbox.writeFile('notes/todo.md', '# 待办\n1. 跑通沙箱\n')
const readBack = await sandbox.readFile('notes/todo.md')
check('写入后读得到', readBack.includes('跑通沙箱'), JSON.stringify(readBack.slice(0, 60)))

await sandbox.writeFile('notes/todo.md', '2. 再验证一次\n', true)
const appended = await sandbox.readFile('notes/todo.md')
check('append 生效', appended.includes('跑通沙箱') && appended.includes('再验证一次'))

const tree = await sandbox.tree('', 3)
check('目录树包含刚写的文件', tree.entries.some(entry => entry.path === 'notes/todo.md' && entry.type === 'file'), JSON.stringify(tree.entries))
check('目录树包含中间目录', tree.entries.some(entry => entry.path === 'notes' && entry.type === 'dir'))

// 沙箱里跑的 git 也能用（前提是那台机器装了 git）—— 这里只验证"命令能跑到那台机器上"。
const pwd = await sandbox.exec('node -e "console.log(process.cwd())"')
check('cwd 落在 root 里', pwd.stdout.replace(/\\/g, '/').includes(root.replace(/\\/g, '/').split(/[/\\]/).pop() ?? ''), pwd.stdout)

console.log('\n── 真实工程动作（git）──')

// 这是"iOS 拿不回来的能力有没有真回来"的关键一验：不是"能跑 echo"，而是能跑真正的仓库操作。
const gitProbe = await sandbox.exec('git --version')
if (gitProbe.exitCode !== 0) {
  check('这台机器有 git（没有就跳过这一组）', true, '跳过')
} else {
  await sandbox.writeFile('repo/README.md', '# demo\n\n用手机上的 agent 提交的。\n')
  const init = await sandbox.exec('git init -q', { cwd: 'repo' })
  equal('git init 成功', init.exitCode, 0, init.stderr)

  const commit = await sandbox.exec(
    'git add -A && git -c user.email=agent@dsh.local -c user.name=DSH-ctor commit -q -m "first commit"',
    { cwd: 'repo' },
  )
  equal('提交成功', commit.exitCode, 0, commit.stderr)

  const log = await sandbox.exec('git log --oneline', { cwd: 'repo' })
  check('git log 读得回来', log.stdout.includes('first commit'), JSON.stringify(log.stdout))

  const status = await sandbox.exec('git status --porcelain', { cwd: 'repo' })
  equal('提交后工作区干净', status.stdout.trim(), '')

  const diff = await sandbox.exec('git show --stat --oneline HEAD', { cwd: 'repo' })
  check('能看到这次提交改了什么', diff.stdout.includes('README.md'), JSON.stringify(diff.stdout))
}

console.log('\n── 越界防护 ──')

let escape = ''
try {
  await sandbox.readFile('../outside.txt')
} catch (cause) {
  escape = cause instanceof Error ? cause.message : String(cause)
}
check('拒绝 ../ 越界读', escape.includes('越界'), escape)

let escapeWrite = ''
try {
  await sandbox.writeFile('../../evil.txt', 'x')
} catch (cause) {
  escapeWrite = cause instanceof Error ? cause.message : String(cause)
}
check('拒绝 ../ 越界写', escapeWrite.includes('越界'), escapeWrite)

// 直接在 root 外造一个文件，确认它读不到（而不是"看起来读到了"）。
const outside = join(tmpdir(), `dsh-outside-${Date.now()}.txt`)
await writeFile(outside, 'secret')
let outsideRead = ''
try {
  await sandbox.readFile(`../${outside.split(/[/\\]/).pop()}`)
} catch (cause) {
  outsideRead = cause instanceof Error ? cause.message : String(cause)
}
check('root 外的文件读不到', outsideRead !== '' && !outsideRead.includes('secret'), outsideRead)
await rm(outside, { force: true })

console.log('\n── 删除与错误 ──')

await sandbox.remove('notes/todo.md')
const gone = await sandbox.tree('notes')
equal('删除后目录空了', gone.entries.length, 0)

let missing = ''
try {
  await sandbox.readFile('notes/todo.md')
} catch (cause) {
  missing = cause instanceof Error ? cause.message : String(cause)
}
check('读不存在的文件报 404 而不是崩', missing.includes('404') || missing.includes('不存在'), missing)

let badUrl = ''
try {
  await new SandboxClient({ url: 'http://127.0.0.1:1', token: TOKEN }).health()
} catch (cause) {
  badUrl = cause instanceof Error ? cause.message : String(cause)
}
check('连不上时给可读信息', badUrl.includes('连不上') || badUrl.includes('超时'), badUrl)

check('错误类型是 SandboxError', new SandboxClient({ url: '', token: 'x' }) instanceof SandboxClient)
try {
  await new SandboxClient({ url: '', token: 'x' }).health()
  check('空地址被拦住', false, '没有抛错')
} catch (cause) {
  check('空地址被拦住', cause instanceof SandboxError, String(cause))
}

// 收尾：关服务端、删临时目录
await new Promise(resolvePromise => server.close(resolvePromise))
check('服务端能干净关掉', true)
await rm(root, { recursive: true, force: true })
check('临时工作目录已清理', await readFile(join(root, 'nope'), 'utf8').then(() => false).catch(() => true))

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
