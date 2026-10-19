/**
 * git 侧的事实采集（只读）。
 *
 * 判据只用 git 的稳定接口：`rev-parse --show-toplevel`（从子目录也能归一到根）、
 * `status --porcelain`（XY 位分暂存/修改/未跟踪）、`rev-list --left-right --count @{u}...HEAD`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 跑一条命令；失败返回 null（而不是抛）—— 所有 git 调用都走它，"查不到"与"没有"由调用方区分。 */
export function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

/**
 * 解析 `git status --porcelain` 的输出。
 * 首列 = 暂存区状态，次列 = 工作区状态；`??` 是未跟踪；重命名的 path 会带 `old -> new`。
 * @param {string} text
 * @returns {{staged: number, modified: number, untracked: number, files: string[]}}
 */
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

/**
 * 一个目录的 git 状态。
 * @param {string} dir
 * @returns {object}
 */
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
  // upstream 要单独暴露：没有上游时 ahead/behind 都是 null，渲染层若只看数值会与「完全同步」同形。
  return { dir: root, ok: true, branch, ...status, dirty, ahead, behind, upstream: ab !== null }
}

/**
 * 自动发现：当前目录若是仓库就收它；否则收一级子目录里带 `.git` 的（最多 12 个）。
 * 只到一级是刻意的 —— 再深就会在 monorepo 里把几百个包全扫一遍。
 * @param {string} cwd
 * @returns {string[]}
 */
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
