#!/usr/bin/env node
/**
 * closeout —— 关会话之前的体检。
 *
 * 查三件"人一关窗口就会丢"的事：
 *   1. 有 git 仓库里还有没提交的改动（含未跟踪文件）；
 *   2. 配置的「临时目录」里还有刚写出来、只在磁盘上的文件；
 *   3. 顺带报一下每个仓库相对上游是领先还是落后。
 *
 * 它**故意不碰**会话日志：那是各家的内部格式，解析它就是给自己埋一颗升级即碎的雷。
 * 会话层面的"该不该交接"由技能（skills/closeout/SKILL.md）里的判据处理。
 *
 * 零依赖 · 跨平台（Windows / macOS / Linux）· Node >= 18。
 *
 * 用法：
 *   closeout                                  # 自动发现：当前仓库 + 一级子目录里的仓库
 *   closeout --repo ../a --repo ../b          # 指定仓库（可重复）
 *   closeout --temp ./tmp --hours 6           # 指定临时目录与"多新算新"
 *   closeout --json | --strict | --zh | --help
 *
 * 退出码：0 = 跑完了（有警告也返回 0）；1 = 加 --strict 时存在警告；2 = 参数错误。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------------------------------------------------------------- 文案 */

const TEXT = {
  en: {
    title: 'closeout — pre-close checks',
    repos: 'Repositories',
    repo: 'repo',
    branch: 'branch',
    staged: 'staged',
    modified: 'modified',
    untracked: 'untracked',
    ahead: 'ahead',
    behind: 'behind',
    clean: 'clean',
    noRepos: 'no git repository found (pass --repo <dir>)',
    temp: 'Recently written files',
    noTemp: 'no --temp directory given and ./tmp does not exist',
    warning: 'warning',
    ok: 'ok',
    next: 'Next steps',
    nextDirty: 'commit or stash the changes above — archiving a session does not save them',
    nextTemp: 'move one-off experiments out of the temp dir, or delete them on purpose',
    nextClean: 'nothing to rescue — safe to close the session',
    summary: 'summary',
    none: 'none',
  },
  zh: {
    title: 'closeout —— 关会话之前的体检',
    repos: '仓库',
    repo: '仓库',
    branch: '分支',
    staged: '已暂存',
    modified: '已修改',
    untracked: '未跟踪',
    ahead: '领先',
    behind: '落后',
    clean: '干净',
    noRepos: '没找到 git 仓库（用 --repo <目录> 指定）',
    temp: '最近写出来的文件',
    noTemp: '没有给 --temp，当前目录下也没有 tmp\\',
    warning: '警告',
    ok: '正常',
    next: '下一步',
    nextDirty: '把上面的改动提交或 stash —— 归档会话不会替你保存它们',
    nextTemp: '把一次性实验从临时目录挪走，或明确删掉',
    nextClean: '没有要抢救的东西，可以安全关闭会话',
    summary: '汇总',
    none: '无',
  },
}

const SKIP_DIRS = new Set(['node_modules', '.git', '_trash', '__pycache__', '.venv', 'dist', 'build', 'target'])

/* ---------------------------------------------------------------- 参数 */

export function parseArgs(argv) {
  const o = { repos: [], temp: [], hours: 12, json: false, strict: false, zh: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === '--repo' || a === '--repos') o.repos.push(next())
    else if (a === '--temp') o.temp.push(next())
    else if (a === '--hours') o.hours = Number(next())
    else if (a === '--json') o.json = true
    else if (a === '--strict') o.strict = true
    else if (a === '--zh' || a === '--cn') o.zh = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!Number.isFinite(o.hours) || o.hours <= 0) throw new Error('--hours must be a positive number')
  return o
}

/* ---------------------------------------------------------------- git */

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return null
  }
}

export function parsePorcelain(text) {
  const out = { staged: 0, modified: 0, untracked: 0, files: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const x = line[0]
    const y = line[1]
    const path = line.slice(3).trim()
    if (x === '?' && y === '?') out.untracked++
    else {
      if (x !== ' ' && x !== '?') out.staged++
      if (y !== ' ' && y !== '?') out.modified++
    }
    if (out.files.length < 20) out.files.push(path)
  }
  return out
}

export function gitStatus(dir) {
  const top = run('git', ['rev-parse', '--show-toplevel'], dir)
  if (top === null) return { dir, ok: false, error: 'not a git repository' }
  const root = top.trim()
  const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root) ?? '').trim() || '(detached)'
  const status = parsePorcelain(run('git', ['status', '--porcelain'], root) ?? '')
  let ahead = null
  let behind = null
  const ab = run('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], root)
  if (ab !== null) {
    const [l, r] = ab.trim().split(/\s+/).map(Number)
    behind = Number.isFinite(l) ? l : null
    ahead = Number.isFinite(r) ? r : null
  }
  const dirty = status.staged + status.modified + status.untracked > 0
  return { dir: root, ok: true, branch, ...status, dirty, ahead, behind }
}

/** 自动发现：当前目录若是仓库就收它；否则收一级子目录里带 .git 的（最多 12 个）。 */
export function discoverRepos(cwd) {
  const here = gitStatus(cwd)
  if (here.ok) return [here.dir]
  let entries = []
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(cwd, e.name)
    if (existsSync(join(p, '.git'))) found.push(p)
    if (found.length >= 12) break
  }
  return found
}

/* ---------------------------------------------------------------- 临时文件 */

/** 递归列出 dir 下 mtime 晚于 sinceMs 的文件（跳过依赖/缓存/隔离区）。 */
export function listRecentFiles(dir, sinceMs, limit = 12) {
  const hits = []
  const walk = (d, depth) => {
    if (depth > 6 || hits.length >= 400) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(d, e.name), depth + 1)
      } else if (e.isFile()) {
        let st
        try {
          st = statSync(join(d, e.name))
        } catch {
          continue
        }
        if (st.mtimeMs >= sinceMs) hits.push({ path: join(d, e.name), mtime: st.mtimeMs, size: st.size })
        if (hits.length >= limit) return
      }
    }
  }
  walk(dir, 0)
  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/* ---------------------------------------------------------------- 汇总与渲染 */

export function collect(opts, cwd = process.cwd()) {
  const repoDirs = opts.repos.length ? opts.repos.map((p) => resolve(cwd, p)) : discoverRepos(cwd)
  const repos = repoDirs.map((d) => gitStatus(d)).filter((r) => r.ok)
  const tempDirs = opts.temp.length ? opts.temp.map((p) => resolve(cwd, p)) : [join(cwd, 'tmp')].filter((p) => existsSync(p))
  const since = Date.now() - opts.hours * 3600 * 1000
  const temp = tempDirs.map((d) => ({ dir: d, files: listRecentFiles(d, since) }))
  const warnings = []
  for (const r of repos) if (r.dirty) warnings.push(`${r.dir}: ${r.staged + r.modified + r.untracked} uncommitted change(s)`)
  for (const t of temp) if (t.files.length) warnings.push(`${t.dir}: ${t.files.length} file(s) written in the last ${opts.hours}h`)
  return { repos, temp, warnings, hours: opts.hours, cwd }
}

export function render(result, t, { color = false } = {}) {
  const lines = []
  const bad = color ? '\u001b[33m' : ''
  const off = color ? '\u001b[0m' : ''
  lines.push(`${t.title}`)
  lines.push('')
  lines.push(`${t.repos}:`)
  if (result.repos.length === 0) lines.push(`  - ${t.noRepos}`)
  for (const r of result.repos) {
    const bits = []
    if (r.staged) bits.push(`${t.staged} ${r.staged}`)
    if (r.modified) bits.push(`${t.modified} ${r.modified}`)
    if (r.untracked) bits.push(`${t.untracked} ${r.untracked}`)
    if (r.ahead) bits.push(`${t.ahead} ${r.ahead}`)
    if (r.behind) bits.push(`${t.behind} ${r.behind}`)
    const state = bits.length ? `${bad}${bits.join(', ')}${off}` : t.clean
    lines.push(`  ${r.dirty ? '!' : '+'} ${r.dir}  [${r.branch}]  ${state}`)
    if (r.dirty && r.files.length) {
      for (const f of r.files.slice(0, 8)) lines.push(`      ${f}`)
      if (r.files.length > 8) lines.push('      ...')
    }
  }
  lines.push('')
  lines.push(`${t.temp} (last ${result.hours}h):`)
  if (result.temp.length === 0) lines.push(`  - ${t.noTemp}`)
  for (const tdir of result.temp) {
    lines.push(`  ${tdir.files.length ? '!' : '+'} ${tdir.dir}`)
    for (const f of tdir.files.slice(0, 10)) {
      lines.push(`      ${relative(tdir.dir, f.path)}  ${Math.round(f.size / 1024)} KB`)
    }
  }
  lines.push('')
  lines.push(`${t.summary}: ${result.warnings.length ? `${result.warnings.length} ${t.warning}` : t.ok}`)
  lines.push('')
  lines.push(`${t.next}:`)
  if (result.repos.some((r) => r.dirty)) lines.push(`  - ${t.nextDirty}`)
  if (result.temp.some((x) => x.files.length)) lines.push(`  - ${t.nextTemp}`)
  if (result.warnings.length === 0) lines.push(`  - ${t.nextClean}`)
  return lines.join('\n')
}

/* ---------------------------------------------------------------- main */

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`closeout: ${e.message}\n`)
    process.exit(2)
  }
  if (opts.help) {
    process.stdout.write(`closeout — checks you want to run before archiving or deleting an agent session.

  --repo <dir>     repository to check (repeatable; default: cwd, or its direct children that are repos)
  --temp <dir>     directory of scratch files (repeatable; default: ./tmp when it exists)
  --hours <n>      how "recent" a scratch file must be (default: 12)
  --json           machine-readable output
  --strict         exit 1 when there is at least one warning
  --zh             Chinese labels
  --help           this text
`)
    process.exit(0)
  }
  const t = opts.zh ? TEXT.zh : TEXT.en
  const result = collect(opts)
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else process.stdout.write(render(result, t) + '\n')
  if (opts.strict && result.warnings.length > 0) process.exit(1)
  process.exit(0)
}

// 只在"被直接执行"时跑 main；被测试 import 时不跑（否则 --test 会把进程参数当 CLI 参数）。
const selfPath = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(selfPath)
if (invokedDirectly) main(process.argv.slice(2))
