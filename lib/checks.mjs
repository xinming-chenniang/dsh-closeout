/**
 * 采集层：把磁盘上的事实 + 会话元数据，整理成「四组 + 一个结论」。
 *
 * 分级不是按严重程度拍的，按的是**能不能删**：
 *   must   —— 没落盘、删了就没了：脏仓 / 没推的提交 / 临时目录里的新文件 / 该交接却没交接件
 *   glance —— 不阻止关，但归档前值得看一眼：落后上游 / 本机侧的门（规则锁、根级登记、规则审计）
 *   fine   —— 明确没事的（给"看过就知道了"的那一半，省得人反复怀疑）
 *   skipped—— 这次没查的，且**必须说明为什么**（读不到 ≠ 没问题）
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverRepos, gitStatus } from './git.mjs'
import { listRecentFiles } from './files.mjs'
import { defaultSessionsDir, daysSpan, handoffVerdict, locateSession, readHandoffs, readSession } from './session.mjs'

const item = (id, text, extra = {}) => ({ id, text, ...extra })

/**
 * 两个路径是否在同一棵树里（相等，或一个是另一个的祖先）。
 * Windows 不区分大小写；其余平台原样比较（区分）。
 */
export function sameTree(a, b) {
  const norm = (p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const x = norm(a)
  const y = norm(b)
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

/** 在 `--local` 指定的工作区里跑它自己的工具；脚本不存在就返回 null（调用方标 skipped）。 */
function runLocalTool(localDir, script, args) {
  const p = join(localDir, 'tools', script)
  if (!existsSync(p)) return null
  try {
    const out = execFileSync(process.execPath, [p, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true })
    return { ok: true, out }
  } catch (e) {
    // 工具用退出码表达结果（如 rules-audit 有错就非 0），所以这里要把 stdout 一起带回去
    return { ok: false, out: e && e.stdout ? String(e.stdout) : '' }
  }
}

/**
 * 采集全部事实。
 * @param {object} opts parseArgs 的结果
 * @param {string} [cwd]
 */
export function collect(opts, cwd = process.cwd()) {
  const must = []
  const glance = []
  const fine = []
  const skipped = []

  // ---------- 0) 会话元数据（先读：它可能决定工作目录） ----------
  // 只读事件计数与时间，不读对话正文。
  const sessionsDir = opts.sessionsDir ? resolve(cwd, opts.sessionsDir) : defaultSessionsDir()
  const wantId = opts.session ?? process.env.DSH_SESSION_ID ?? 'last'
  const located = locateSession(sessionsDir, wantId)
  let session = null
  let sessionInfo = { id: wantId, guessed: located.guessed, supported: located.supported, file: located.entry?.file ?? null }
  if (!located.supported) {
    skipped.push(item('session-nostd', `当前 Node（${process.version}）没有 zlib.zstdDecompressSync（需 ≥ 22），会话这项没查`))
  } else if (!located.entry) {
    skipped.push(item('session-missing', `在 ${sessionsDir} 里找不到会话 ${wantId}`))
  } else {
    session = readSession(located.entry.file)
    if (session === null) {
      skipped.push(item('session-unreadable', `会话文件读不出来：${located.entry.file}`))
    }
  }
  // `--cwd-from-session`：用会话自己记的工作目录。
  // 桌面端客户端拿不到 cwd（事件窗口里没有 session 头事件），只能把会话 id 交过来，由这里查库取 cwd。
  if (opts.cwdFromSession && session?.cwd) cwd = session.cwd

  // ---------- 1) 仓库 ----------
  const repoDirs = opts.repos.length ? opts.repos.map((p) => resolve(cwd, p)) : discoverRepos(cwd)
  const repos = repoDirs.map((d) => gitStatus(d)).filter((r) => r.ok)
  for (const r of repos) {
    const changes = r.staged + r.modified + r.untracked
    if (changes > 0) {
      const bits = []
      if (r.staged) bits.push(`${r.staged} 已暂存`)
      if (r.modified) bits.push(`${r.modified} 已修改`)
      if (r.untracked) bits.push(`${r.untracked} 未跟踪`)
      must.push(item('repo-dirty', `${r.dir} → ${bits.join(' / ')}`, {
        repo: r,
        // 只给「先看清楚」的命令：改什么、要不要提交，工具不知道，也不该替你 add。
        next: `git -C "${r.dir}" diff --stat`,
      }))
    } else {
      fine.push(item('repo-clean', `${r.dir} 干净`))
    }
    if (r.ahead && r.ahead > 0) {
      must.push(item('repo-ahead', `${r.dir} → ${r.ahead} 个提交没推`, {
        repo: r,
        next: `git -C "${r.dir}" push`,
      }))
    }
    if (r.behind && r.behind > 0) {
      glance.push(item('repo-behind', `${r.dir} → 落后上游 ${r.behind} 个提交（先 pull 再收尾）`, {
        repo: r,
        next: `git -C "${r.dir}" pull --rebase`,
      }))
    }
    if (!r.upstream) skipped.push(item('repo-upstream', `${r.dir} 没有配置上游分支，推没推无法判断`))
  }

  // ---------- 2) 临时目录 ----------
  const tempDirs = opts.temp.length ? opts.temp.map((p) => resolve(cwd, p)) : [join(cwd, 'tmp')].filter((p) => existsSync(p))
  const since = Date.now() - opts.hours * 3600 * 1000
  const temp = tempDirs.map((d) => ({ dir: d, files: listRecentFiles(d, since) }))
  for (const t of temp) {
    if (t.files.length) {
      must.push(item('temp-files', `${t.dir} → 最近 ${opts.hours} 小时写了 ${t.files.length} 个文件`, {
        temp: t,
        next: { textKey: 'nextTemp' },
      }))
    } else {
      fine.push(item('temp-clean', `${t.dir} 没有新文件`))
    }
  }
  if (tempDirs.length === 0) skipped.push(item('temp-none', `没有 --temp，当前目录下也没有 tmp/，临时文件这项没查`))

  // ---------- 3) 会话元数据已在最前面读过（见「0)」），这里只做交接判定 ----------

  // ---------- 4) 交接件 ----------
  const handoffsDir = opts.handoffs ? resolve(cwd, opts.handoffs) : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'handoffs')
  const ledger = readHandoffs(handoffsDir)
  const verdict = handoffVerdict(session, { threshold: opts.threshold, minCalls: opts.minCalls, days: opts.days })
  const handoff = {
    needed: verdict.needed,
    reasons: verdict.reasons,
    exists: session?.id ? ledger.ids.has(session.id) : false,
    dir: handoffsDir,
    files: ledger.files,
    note: null,
  }
  if (session) {
    const span = daysSpan(session.first, session.last)
    sessionInfo = { ...sessionInfo, span, calls: session.calls, turns: session.turns, last: session.last, first: session.first, cwd: session.cwd }
    // 会话记的是它自己的 cwd；和当前目录不一致时，统计说的不是这个目录的事 —— 必须在输出里讲明。
    // 但「在子目录里跑」是正常用法（会话在 D:\dsh、我在 D:\dsh\某子目录），不算不一致。
    handoff.cwdMismatch = session.cwd && !sameTree(session.cwd, cwd) ? session.cwd : null
    if (handoff.needed && !handoff.exists) {
      must.push(item('handoff-missing', `该写交接件（${handoff.reasons.join(' / ')}），${handoffsDir} 里没有对应文件`, {
        next: `closeout --handoff --handoffs "${handoffsDir}"`,
      }))
      handoff.note = `该写：${handoff.reasons.join(' / ')}`
    } else if (handoff.needed && handoff.exists) {
      const names = ledger.files.filter((f) => f.ids.includes(session.id)).map((f) => f.name).join('、')
      handoff.note = `该写，且已有：${names}`
    } else {
      handoff.note = `${session.calls} 次调用 / 跨 ${span} 天，未超线`
    }
  } else if (handoff.needed) {
    skipped.push(item('handoff-unknown', '会话读不到，交接件是否需要写无法判断（判据要调用次数）'))
  }

  // ---------- 5) 本机侧的门（只有给了 --local 才跑） ----------
  if (opts.local) {
    const localDir = resolve(cwd, opts.local)
    const lock = runLocalTool(localDir, 'rules-lock.mjs', ['status'])
    if (lock === null) skipped.push(item('local-lock', `${localDir} 里没有 tools/rules-lock.mjs，规则锁这项没查`))
    else if (/无锁|没有未释放/.test(lock.out)) fine.push(item('local-lock', '规则锁：没有未释放的锁'))
    else glance.push(item('local-lock', `规则锁：${lock.out.trim().split('\n').slice(0, 2).join(' / ')}`, {
      next: `node "${join(localDir, 'tools', 'rules-lock.mjs')}" release`,
    }))

    const hyg = runLocalTool(localDir, 'hygiene-structure.mjs', [localDir, '--depth', '1', '--json'])
    if (hyg === null) skipped.push(item('local-hygiene', `${localDir} 里没有 tools/hygiene-structure.mjs，根级登记这项没查`))
    else {
      try {
        const sum = (JSON.parse(hyg.out).summary ?? [])[0] ?? {}
        const viol = sum.violations ?? []
        const todos = sum.todos ?? []
        if (viol.length) glance.push(item('local-hygiene', `根级位置检查 ${viol.length} 项违规：${viol.slice(0, 3).map((v) => `${v.name}(${v.kind})`).join('、')}`))
        else fine.push(item('local-hygiene', '根级登记：通过'))
        if (todos.length) glance.push(item('local-hygiene-todo', `根级有 ${todos.length} 项待归档：${todos.slice(0, 3).map((x) => x.name).join('、')}`))
      } catch {
        skipped.push(item('local-hygiene', 'hygiene-structure 的 JSON 解析失败，根级登记这项没查'))
      }
    }

    const audit = runLocalTool(localDir, 'rules-audit.js', [])
    if (audit === null) skipped.push(item('local-audit', `${localDir} 里没有 tools/rules-audit.js，规则审计这项没查`))
    else if (audit.ok) fine.push(item('local-audit', '规则审计：通过'))
    else glance.push(item('local-audit', '规则审计：有问题（跑 node tools/rules-audit.js 看详情）'))
  } else {
    skipped.push(item('local-off', '本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查'))
  }

  return { cwd, hours: opts.hours, repos, temp, session, sessionInfo, handoff, must, glance, fine, skipped }
}

/**
 * 结论：能不能删。
 * 归档是可逆的（东西还在，只是不在列表里），删除不可逆 —— 所以只对删除设门槛。
 * @param {object} r collect 的结果
 * @returns {{level: 'no-delete'|'write-handoff'|'safe', blockers: number}}
 */
export function conclude(r) {
  const blockers = r.must.length
  if (blockers > 0) return { level: 'no-delete', blockers }
  if (r.handoff.needed && !r.handoff.exists) return { level: 'write-handoff', blockers: 0 }
  return { level: 'safe', blockers: 0 }
}
