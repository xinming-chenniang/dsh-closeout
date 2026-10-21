/**
 * 关闭 DSH（整个应用）之前的自检 —— `closeout app`。
 *
 * 与 `closeout session` 的分工：
 *   - session：**这个会话**里做的东西有没有落盘、该不该写交接件；
 *   - app：**这个应用**现在能不能退、退之前有哪些东西只活在运行态里、下次启动会不会起不来。
 *
 * 判据只取外部可验证的事实（文件系统、进程表、profile 配置、会话库），
 * 不臆造宿主内存里的状态：后台 jobs / 终端 / 未回答的审批读不到就写进「没查的」。
 *
 * 为什么"待重启"是一项：dsh-plugin-restart 会把待重启标记落盘（pending-restart.json）。
 * 有标记 = 改了配置或插件但还没生效；它不是"关了会丢"的东西，但会让人误以为已经生效。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultSessionsDir, hasZstd, listSessionFiles, readSession } from './session.mjs'
import { localGates } from './checks.mjs'
import { fmtTime, shortId } from './render.mjs'

const item = (id, text, extra = {}) => ({ id, text, ...extra })
const home = () => process.env.USERPROFILE || process.env.HOME || ''

/** DSH 的 profile 根目录（跨平台：USERPROFILE → HOME）。 */
export function defaultProfilesDir() {
  return join(home(), '.dsh', 'profiles')
}

/** dsh-plugin-restart 的落盘目录。 */
export function defaultRestartDir() {
  return join(home(), '.dsh', 'dsh-plugin-restart')
}

/**
 * 解析 `tasklist` 的内存列（形如 `123,456 K`）→ KB。解析不出来返回 null。
 * @param {string} s
 * @returns {number|null}
 */
export function parseMem(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/([\d.]+)\s*([KMGT]?)/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || '').toUpperCase()
  if (!Number.isFinite(n)) return null
  if (unit === 'G') return Math.round(n * 1048576)
  if (unit === 'M') return Math.round(n * 1024)
  if (unit === 'K') return Math.round(n)
  return Math.round(n / 1024)
}

/**
 * 当前运行的应用进程（只看映像名 / comm，不解析 Electron 的 --type）。
 * 只读：不杀、不 attach。
 * @param {string} appName 映像名里要匹配的片段（默认 `DeepSeek Harness`）
 * @returns {{ok: boolean, procs: {name: string, pid: number, memKB: number|null}[], error?: string}}
 */
export function listProcesses(appName = 'DeepSeek Harness') {
  if (process.platform === 'win32') {
    let out
    try {
      out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    } catch (e) {
      return { ok: false, procs: [], error: String((e && e.message) || e) }
    }
    const procs = []
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const cells = line.replace(/^"/, '').replace(/"$/, '').split('","')
      if (cells.length < 2) continue
      const name = cells[0]
      if (!name.toLowerCase().includes(String(appName).toLowerCase())) continue
      const pid = Number(cells[1])
      if (!Number.isFinite(pid)) continue
      procs.push({ name, pid, memKB: parseMem(cells[4]) })
    }
    return { ok: true, procs }
  }
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,comm='], { encoding: 'utf8', timeout: 15000 })
    const procs = []
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      if (!/deepseek|dsh/i.test(m[3])) continue
      procs.push({ name: m[3].trim(), pid: Number(m[1]), memKB: Number(m[2]) })
    }
    return { ok: true, procs }
  } catch (e) {
    return { ok: false, procs: [], error: String((e && e.message) || e) }
  }
}

/**
 * 读待重启标记。三种结果要分开：没有标记 / 有标记 / 标记坏了（读不出 ≠ 没有）。
 * @param {string} [dir]
 * @returns {{found: boolean, path: string, rec?: object, error?: string}}
 */
export function readPendingRestart(dir = defaultRestartDir()) {
  const p = join(dir, 'pending-restart.json')
  if (!existsSync(p)) return { found: false, path: p }
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return { found: true, path: p, error: String((e && e.message) || e) }
  }
  try {
    return { found: true, path: p, rec: JSON.parse(text) }
  } catch (e) {
    return { found: true, path: p, error: String((e && e.message) || e) }
  }
}

/**
 * 读**上次重启的结果**（dsh-plugin-restart 每次重启都写）。与 pending 标记分开：
 * pending 说的是"有改动没生效"，result 说的是"上一次重启到底成没成"。
 * `phase` 里的 `relaunched-no-window` 是它诚实分级出来的"进程起来了但没有窗口"。
 * @param {string} [dir]
 * @returns {{found: boolean, path: string, rec?: object, error?: string}}
 */
export function readRestartResult(dir = defaultRestartDir()) {
  const p = join(dir, 'restart-result.json')
  if (!existsSync(p)) return { found: false, path: p }
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return { found: true, path: p, error: String((e && e.message) || e) }
  }
  try {
    return { found: true, path: p, rec: JSON.parse(text) }
  } catch (e) {
    return { found: true, path: p, error: String((e && e.message) || e) }
  }
}

/**
 * 找要检查的 profile：`--profile` 优先，否则取 `~/.dsh/profiles/*` 里 package.json 最新的那个。
 * @param {string|null} explicit
 * @returns {{dir: string, mtime?: number, source: string}|null}
 */
export function findProfile(explicit) {
  if (explicit) return { dir: resolve(explicit), source: '--profile' }
  const root = defaultProfilesDir()
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(root, e.name, 'package.json')
    if (!existsSync(p)) continue
    let mtime = 0
    try {
      mtime = statSync(p).mtimeMs
    } catch {
      continue
    }
    if (best === null || mtime > best.mtime) best = { dir: join(root, e.name), mtime }
  }
  return best ? { ...best, source: '最近修改的 profile' } : null
}

/**
 * profile 配置完整性 —— 这一项答的是「**下次启动会不会起不来**」。
 * 判据：package.json 可解析 / bundles 非空 / 每个 bundle 在 dependencies 里、
 * link·file 目标存在、node_modules 里能解析。断了就是必须处理（不是"顺手看一眼"）。
 * @param {string} dir
 */
export function checkProfile(dir) {
  const must = []
  const glance = []
  const fine = []
  const skipped = []
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    skipped.push(item('app-profile-missing', `${dir} 里没有 package.json，配置完整性这项没查`))
    return { must, glance, fine, skipped }
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    must.push(item('app-profile-json', `${pkgPath} 不是合法 JSON：${String((e && e.message) || e)}`, {
      next: `node -e "JSON.parse(require('fs').readFileSync('${pkgPath.replace(/\\/g, '\\\\')}','utf8'))"`,
    }))
    return { must, glance, fine, skipped }
  }
  const deps = pkg.dependencies ?? {}
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.length === 0) {
    must.push(item('app-profile-bundles', `${pkgPath} 没有 dsh.profile.bundles —— 宿主不会装载任何插件`))
    return { must, glance, fine, skipped }
  }
  const broken = []
  // 宿主内置的官方包（@deepseek-ai/*）打在 app.asar 里，不会出现在 profile 的 node_modules，
  // 也不该被要求写进 profile 的 dependencies —— 这一条是实测踩出来的，否则桌面 profile 会全员误报。
  const builtin = (b) => String(b).startsWith('@deepseek-ai/')
  for (const b of bundles) {
    const inDeps = Object.prototype.hasOwnProperty.call(deps, b)
    const spec = inDeps ? String(deps[b]) : ''
    if (inDeps && (spec.startsWith('link:') || spec.startsWith('file:'))) {
      const target = resolve(dir, spec.slice(5))
      if (!existsSync(target)) {
        broken.push(`${b}（${spec} 目标不存在：${target}）`)
        continue
      }
    }
    if (existsSync(join(dir, 'node_modules', b, 'package.json'))) continue
    if (!inDeps && builtin(b)) continue
    if (!inDeps) broken.push(`${b}（不在 dependencies，也没装）`)
    else broken.push(`${b}（node_modules 里没装）`)
  }
  if (broken.length > 0) {
    must.push(item('app-profile-broken', `profile 有 ${broken.length} 个 bundle 重启后装载不了：${broken.slice(0, 3).join('；')}${broken.length > 3 ? ' 等' : ''}`, {
      next: `cd "${dir}" && pnpm install；装不上时先在 cordis.patch.yml 里给坏 bundle 加 disabled: true，先启动再修`,
    }))
  } else {
    fine.push(item('app-profile-ok', `profile：${bundles.length} 个 bundle 全部可解析`))
  }
  const unloaded = Object.keys(deps).filter((d) => !bundles.includes(d))
  if (unloaded.length > 0) {
    glance.push(item('app-profile-unloaded', `${unloaded.length} 个依赖装了但不在 bundles（不会装载）：${unloaded.slice(0, 5).join('、')}`))
  }
  return { must, glance, fine, skipped }
}

/**
 * 扫会话库：哪些会话最近还在写、哪些末尾没收口。
 * 只解最近 `maxSessions` 个（解压有成本），其余只按 mtime 算。
 * @param {{sessionsDir?: string, recentMinutes?: number, maxSessions?: number, minCalls?: number}} opt
 */
export function scanSessions(opt = {}) {
  const must = []
  const glance = []
  const fine = []
  const skipped = []
  const root = opt.sessionsDir || defaultSessionsDir()
  const recentMinutes = opt.recentMinutes ?? 15
  const maxSessions = opt.maxSessions ?? 20
  const minCalls = opt.minCalls ?? 50
  const files = listSessionFiles(root)
  const stats = { total: files.length, recent: 0, open: 0, scanned: 0 }
  if (files.length === 0) {
    skipped.push(item('app-sessions-none', `${root} 里没有会话文件，会话收口状态这项没查`))
    return { must, glance, fine, skipped, stats }
  }
  const now = Date.now()
  const recent = files.filter((f) => now - f.mtime < recentMinutes * 60000)
  stats.recent = recent.length
  if (!hasZstd) {
    skipped.push(item('app-sessions-nostd', `当前 Node（${process.version}）没有 zlib.zstdDecompressSync（需 ≥ 22），会话收口状态这项没查`))
    return { must, glance, fine, skipped, stats }
  }
  const sorted = files.slice().sort((a, b) => b.mtime - a.mtime)
  const open = []
  let unreadable = 0
  for (const f of sorted.slice(0, maxSessions)) {
    stats.scanned++
    const meta = readSession(f.file)
    if (!meta) {
      unreadable++
      continue
    }
    // 子会话不点名（与 session 口径一致）
    if ((meta.depth ?? 0) > 0 || meta.parent !== null) continue
    if (meta.lastReason && meta.lastReason !== 'completed' && meta.calls >= minCalls) {
      open.push({ id: meta.id ?? f.id, calls: meta.calls, reason: meta.lastReason, mtime: f.mtime })
    }
  }
  stats.open = open.length
  if (recent.length > 0) {
    glance.push(item('app-sessions-recent', `最近 ${recentMinutes} 分钟有 ${recent.length} 个会话在写：${recent.slice(0, 5).map((f) => `${shortId(f.id)}（${fmtTime(f.mtime)}）`).join('、')}`))
  }
  if (open.length > 0) {
    glance.push(item('app-sessions-open', `${open.length} 个会话末尾没收口：${open.slice(0, 5).map((o) => `${shortId(o.id)}（${o.reason}）`).join('、')}`))
  }
  if (unreadable > 0) {
    skipped.push(item('app-sessions-broken', `${unreadable} 个会话文件解不开，它们的收口状态没查`))
  }
  if (recent.length === 0 && open.length === 0) {
    fine.push(item('app-sessions-calm', `会话库：${files.length} 个会话，最近没有正在写或未收口的`))
  }
  return { must, glance, fine, skipped, stats }
}

/**
 * 采集 app 口径的全部事实。
 * @param {object} opts parseArgs 的结果
 * @param {string} [cwd]
 */
export function collectApp(opts, cwd = process.cwd()) {
  const must = []
  const glance = []
  const fine = []
  const skipped = []

  // 1) 运行中的实例
  const proc = listProcesses(opts.appName)
  if (!proc.ok) {
    skipped.push(item('app-proc', `进程表读不到（${proc.error}），运行中的实例这项没查`))
  } else if (proc.procs.length === 0) {
    fine.push(item('app-proc', `当前没有运行中的「${opts.appName}」进程`))
  } else {
    const memKB = proc.procs.reduce((s, p) => s + (p.memKB ?? 0), 0)
    const pids = proc.procs.map((p) => p.pid)
    fine.push(item('app-proc', `运行中：${proc.procs.length} 个进程（PID ${pids.slice(0, 6).join('、')}${pids.length > 6 ? ' 等' : ''}），合计约 ${Math.round(memKB / 1024)} MB`))
  }

  // 2) 待重启
  const restartDir = opts.restartDir ? resolve(cwd, opts.restartDir) : defaultRestartDir()
  const restart = readPendingRestart(restartDir)
  let pending = false
  if (!restart.found) {
    fine.push(item('app-restart', '没有待重启标记'))
  } else if (restart.error) {
    skipped.push(item('app-restart', `${restart.path} 解析失败（${restart.error}），待重启状态没查清`))
  } else if (restart.rec && restart.rec.dismissedAt === null) {
    pending = true
    const at = restart.rec.atMs || (restart.rec.at ? Date.parse(restart.rec.at) : null)
    const why = restart.rec.reason || restart.rec.source || '未知原因'
    const count = restart.rec.count > 1 ? ` ×${restart.rec.count}` : ''
    glance.push(item('app-restart', `有改动待重启（${why}，${at ? fmtTime(at) : '时间未知'}${count}）—— 重启前它不会生效`, {
      next: restart.rec.pid ? `确认宿主 PID ${restart.rec.pid} 后重启应用` : null,
    }))
  } else {
    fine.push(item('app-restart', '没有待重启的改动'))
  }

  // 2.5) 上次重启结果：pending 说"没生效"，这里说"上次到底成没成"
  const last = readRestartResult(restartDir)
  const lastInfo = { ok: null, phase: null }
  if (last.found && last.rec) {
    lastInfo.ok = last.rec.ok === true
    lastInfo.phase = last.rec.phase ?? null
    const at = last.rec.finishedAt ? Date.parse(last.rec.finishedAt) : null
    if (last.rec.ok === true && last.rec.phase === 'relaunched') {
      fine.push(item('app-restart-last', `上次重启：成功（${at ? fmtTime(at) : '时间未知'}${last.rec.relaunchedPid ? `，PID ${last.rec.relaunchedPid}` : ''}）`))
    } else {
      must.push(item('app-restart-last', `上次重启没恢复好（ok=${last.rec.ok}，phase=${last.rec.phase ?? '?'}）—— 先查清再退`, {
        next: `看 "${join(restartDir, 'restart.log')}" 的末尾`,
      }))
    }
  } else if (last.found && last.error) {
    skipped.push(item('app-restart-last', `${last.path} 解析失败（${last.error}），上次重启结果没查`))
  } else {
    fine.push(item('app-restart-last', '没有上次重启记录'))
  }

  // 3) 会话库整体
  const sessions = scanSessions({
    sessionsDir: opts.sessionsDir ? resolve(cwd, opts.sessionsDir) : defaultSessionsDir(),
    recentMinutes: opts.recentMinutes,
    maxSessions: opts.maxSessions,
    minCalls: opts.minCalls,
  })
  must.push(...sessions.must)
  glance.push(...sessions.glance)
  fine.push(...sessions.fine)
  skipped.push(...sessions.skipped)

  // 4) profile 配置完整性
  const profile = findProfile(opts.profile ? resolve(cwd, opts.profile) : null)
  const profileInfo = { dir: null, ok: null }
  if (!profile) {
    skipped.push(item('app-profile', `找不到 DSH profile（${defaultProfilesDir()}），配置完整性这项没查`))
  } else {
    profileInfo.dir = profile.dir
    const c = checkProfile(profile.dir)
    must.push(...c.must)
    glance.push(...c.glance)
    fine.push(...c.fine)
    skipped.push(...c.skipped)
    profileInfo.ok = c.must.length === 0
  }

  // 5) 本机侧的门（与 session 口径共用同一套脚本，不另立）
  if (opts.local) {
    const g = localGates(resolve(cwd, opts.local))
    must.push(...g.must)
    glance.push(...g.glance)
    fine.push(...g.fine)
    skipped.push(...g.skipped)
  } else {
    skipped.push(item('local-off', '本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查'))
  }

  // 6) 宿主内存态：读不到就明说，不假装查过
  skipped.push(item('app-hoststate', '后台 jobs / 终端会话 / 未回答的审批只在宿主内存里，外部读不到 —— 关之前请在 UI 里看一眼'))

  return {
    cwd,
    hours: opts.hours,
    repos: [],
    temp: [],
    session: null,
    sessionInfo: {},
    app: {
      processes: proc,
      sessions: sessions.stats,
      profile: profileInfo,
      restart: { found: restart.found, pending, last: lastInfo },
    },
    must,
    glance,
    fine,
    skipped,
  }
}

/**
 * app 口径的结论：只拦"下次起不来"这种结构性风险；运行态提醒不阻止退出。
 * @param {object} r collectApp 的结果
 * @returns {{level: 'no-exit'|'check-first'|'safe-exit', blockers: number}}
 */
export function concludeApp(r) {
  if (r.must.length > 0) return { level: 'no-exit', blockers: r.must.length }
  if (r.glance.length > 0) return { level: 'check-first', blockers: 0 }
  return { level: 'safe-exit', blockers: 0 }
}
