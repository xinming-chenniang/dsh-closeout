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
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverRepos, gitStatus } from './git.mjs'
import { listRecentFiles } from './files.mjs'
import { fmtTime } from './render.mjs'
import { defaultSessionsDir, collectCallRefs, daysSpan, handoffVerdict, locateSession, readHandoffs, readSession } from './session.mjs'
import { decideShape, findWorkspaceRoot, resolveLedgerDir } from './workspace.mjs'

const item = (id, text, extra = {}) => ({ id, text, ...extra })

/**
 * 两个路径是否在同一棵树里（相等，或一个是另一个的祖先）。
 * Windows 不区分大小写；其余平台原样比较（区分）。
 */
export function sameTree(a, b) {
  const x = normPath(a)
  const y = normPath(b)
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

/** 路径归一化：反斜杠统一成正斜杠、去掉尾部分隔符、Windows 小写。 */
function normPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 这个会话有没有碰过这个仓库？只用文件系统时间判断，不读对话内容：
 *   1. 有改动文件的 mtime ≥ 锚点（本段会话起点）→ 是这次改的
 *   2. 有未推提交的提交时间 ≥ 锚点 → 是这次提交的
 * 判不出来的情况（改名行、已删除文件）一律当作「是」：收尾场景漏报比多报糟得多 ——
 * 多报只是多一行，漏报是把没落盘的东西删掉。
 * @param {object} r gitStatus 的结果
 * @param {number} since 锚点（毫秒）；调用方保证是数字
 * @returns {boolean}
 */
export function touchedBySession(r, since) {
  if (typeof since !== 'number') return true
  for (const p of r.paths ?? []) {
    // 改名行是 `old -> new`，拿不到单个可 stat 的路径 —— 判不出来就当是（见上）
    if (String(p).includes(' -> ')) return true
    try {
      if (statSync(join(r.dir, p)).mtimeMs >= since) return true
    } catch {
      // 试探式：已删除 / 无权限的文件没有 mtime，跳过这一个文件，不影响其他判据
    }
  }
  for (const t of r.unpushedTimes ?? []) if (t >= since) return true
  return false
}

/**
 * 工具调用里出现过的路径是否落在仓内（相对路径按会话 cwd 解析）。
 * 这是「这个会话自己」的归属证据 —— 比时间窗准，能区分同一时段并发的别的会话。
 * 注意方向是**单向**的：只看「这个路径在仓里」，不看「仓在这个路径里」——
 * 命令里几乎都会带上工作目录（如 `cd D:\dsh`），双向比较会把 `D:\dsh\dsh-worklog`
 * 误判成「碰过」（2026-10-25 实测踩过）。
 * @param {Set<string>} writes collectCallRefs 的结果
 * @param {string} dir 仓根
 * @param {string} cwd 会话工作目录（解析相对路径用）
 */
export function touchedByCalls(writes, dir, cwd) {
  const root = normPath(dir)
  for (const p of writes) {
    const abs = normPath(resolve(cwd, p))
    if (abs === root || abs.startsWith(root + '/')) return true
  }
  return false
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
 * 本机侧的门：跑 `--local` 指定工作区自己的三个脚本（存在才跑，不存在就明说没查）。
 * 抽成函数是为了 `closeout session` 与 `closeout app` 共用同一套判据，不各写一份。
 * @param {string} localDir
 * @returns {{must: object[], glance: object[], fine: object[], skipped: object[]}}
 */
export function localGates(localDir) {
  const must = []
  const glance = []
  const fine = []
  const skipped = []

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

  return { must, glance, fine, skipped }
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

  // 时间锚点：**本段会话的起点**（显式给 --hours 时不采用，那是有意要固定窗口）。
  // 仓库归属与临时文件窗口共用同一个锚点：判断「这是这次会话弄的吗」只看时间，
  // 不读对话内容。读不到会话时退回 --hours 小时窗（此时无法区分并发会话，文案会说清）。
  // 2026-10-25 用户报的「提醒与本会话无关的仓的未提交/未推」就是这条缺了的结果。
  const sessionSince = !opts.hoursExplicit && typeof session?.segStart === 'number' ? session.segStart : null
  const anchor = sessionSince ?? Date.now() - opts.hours * 3600 * 1000

  // ---------- 1) 仓库 ----------
  const repoDirs = opts.repos.length ? opts.repos.map((p) => resolve(cwd, p)) : discoverRepos(cwd)
  const repos = repoDirs.map((d) => gitStatus(d)).filter((r) => r.ok)
  // 归属证据：本会话**自己的工具调用**里写过的路径（读不到会话时才退回时间锚点）。
  // 时间锚点分不出同一时段并发的会话 —— 用户 2026-10-25 报的正是这个。
  const callRefs = located.entry ? collectCallRefs(located.entry.file) : { ok: false, writes: new Set() }
  // 显式 `--hours N` = 用户要「原始窗口模式」：窗口内一律算，不做归属过滤
  // （自动化/脚本靠这个行为，比如 --strict 的冒烟测试）。
  const useAttribution = !opts.hoursExplicit && callRefs.ok
  for (const r of repos) {
    const mine = useAttribution ? touchedByCalls(callRefs.writes, r.dir, cwd) : touchedBySession(r, anchor)
    r.touchedBySession = mine
    const changes = r.staged + r.modified + r.untracked
    if (changes > 0) {
      const bits = []
      if (r.staged) bits.push(`${r.staged} 已暂存`)
      if (r.modified) bits.push(`${r.modified} 已修改`)
      if (r.untracked) bits.push(`${r.untracked} 未跟踪`)
      if (mine) {
        must.push(item('repo-dirty', `${r.dir} → ${bits.join(' / ')}`, {
          repo: r,
          // 只给「先看清楚」的命令：改什么、要不要提交，工具不知道，也不该替你 add。
          next: `git -C "${r.dir}" diff --stat`,
        }))
      } else {
        // 本会话的工具调用里没有它 → 之前留下的，删这个会话不会让它更糟，不该拦关会话
        fine.push(item('repo-dirty-old', `${r.dir} → ${bits.join(' / ')}，但本会话的工具调用里没有它（之前留下的，不计入）`, { repo: r }))
      }
    } else {
      fine.push(item('repo-clean', `${r.dir} 干净`))
    }
    if (r.ahead && r.ahead > 0) {
      if (mine) {
        must.push(item('repo-ahead', `${r.dir} → ${r.ahead} 个提交没推`, {
          repo: r,
          next: `git -C "${r.dir}" push`,
        }))
      } else {
        fine.push(item('repo-ahead-old', `${r.dir} → ${r.ahead} 个提交没推，但本会话没提交/推送过它（之前留下的，不计入）`, { repo: r }))
      }
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
  const since = anchor
  // 归属：本会话工具调用写过的绝对路径（归一化后做前缀匹配）。
  // 读不到会话时无法区分 → 全算本会话的（宁可多报，不能把真留下的当别人的）。
  const writeAbs = []
  if (useAttribution) for (const p of callRefs.writes) writeAbs.push(normPath(resolve(cwd, p)))
  const inWrites = (abs) => {
    const a = normPath(abs)
    return writeAbs.some((w) => a === w || a.startsWith(w + '/'))
  }
  const temp = tempDirs.map((d) => {
    const all = listRecentFiles(d, since, Infinity)
    const mine = useAttribution ? all.filter((f) => inWrites(f.path)) : all
    return { dir: d, files: mine.slice(0, 12), total: mine.length, otherTotal: all.length - mine.length, scannedTotal: all.length }
  })
  for (const t of temp) {
    const window = sessionSince !== null ? `本段会话自 ${fmtTime(sessionSince)} 起` : `最近 ${opts.hours} 小时`
    if (t.total) {
      const cut = t.total > t.files.length ? `，明细只列最新 ${t.files.length} 个` : ''
      must.push(item('temp-files', `${t.dir} → ${window}写了 ${t.total} 个文件${cut}`, {
        temp: t,
        next: { textKey: 'nextTemp' },
      }))
    } else if (t.scannedTotal) {
      fine.push(item('temp-clean', `${t.dir}：${window}没有本会话写的文件（另有 ${t.otherTotal} 个是别的会话写的，不计入）`))
    } else {
      fine.push(item('temp-clean', `${t.dir} 没有新文件`))
    }
    if (t.total && t.otherTotal > 0) {
      fine.push(item('temp-others', `${t.dir}：另有 ${t.otherTotal} 个文件落在本段窗口内，但本会话的工具调用里没有（并发会话/之前留下的，不计入）`))
    }
  }
  if (tempDirs.length === 0) skipped.push(item('temp-none', `没有 --temp，当前目录下也没有 tmp/，临时文件这项没查`))

  // ---------- 3) 会话元数据已在最前面读过（见「0)」），这里只做交接判定 ----------

  // ---------- 4) 交接件 ----------
  // 落点按工作区分（v0.7）：显式 --handoffs → 工作区自己的 handoffs/ → ~/.dsh/handoffs/<工作区名>/。
  // v0.6 一律落到全局 ~/.dsh/handoffs，多工作区时 A 项目的交接件与 B 项目的混在同一个台账里。
  const workspace = findWorkspaceRoot(cwd)
  const handoffsDir = resolveLedgerDir({ workspaceRoot: workspace.root, cwd, explicit: opts.handoffs })
  const ledger = readHandoffs(handoffsDir)
  const verdict = handoffVerdict(session, { threshold: opts.threshold, minCalls: opts.minCalls, days: opts.days, tokenThreshold: opts.tokenThreshold })
  const handoff = {
    needed: verdict.needed,
    reasons: verdict.reasons,
    exists: session?.id ? ledger.ids.has(session.id) : false,
    dir: handoffsDir,
    files: ledger.files,
    note: null,
  }
  if (session) {
    // 跨几天按**本段**算：resume 过的会话 first 停在创建日，按它算会把当天干完的活报成「跨 5 天」。
    const span = daysSpan(session.segStart ?? session.first, session.last)
    sessionInfo = { ...sessionInfo, span, calls: session.calls, turns: session.turns, last: session.last, first: session.first, segStart: session.segStart ?? null, cwd: session.cwd, title: session.title, maxTotalTokens: session.maxTotalTokens }
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

  // ---------- 4b) 台账格式（2026-11-09 加） ----------
  // 交接件必须是「文件名带状态段 + 件首三行块」。只写正文行内状态的件会被旧兜底读成"已完成"，
  // 账面分不出完成没 —— 这种要在收尾时拦住（2026-11-08/09 三份件就是被兜底盖住的）。
  const ledgerFiles = ledger.files.filter((f) => f.ids.length > 0 && !/^README\.md$/i.test(f.name))
  const noStatusName = ledgerFiles.filter((f) => !f.statusName)
  if (noStatusName.length) {
    must.push(item('handoff-name-status', `交接件文件名缺状态段 ${noStatusName.length} 份：${noStatusName.slice(0, 3).map((f) => f.name).join('、')}${noStatusName.length > 3 ? ` 等 ${noStatusName.length} 份` : ''}（工具靠正文里的状态兜底，账面分不出完成没）`, {
      next: '文件名最前加 （进行中）/（已完成）/（已废弃） 段，再跑一次复核',
    }))
  }
  const badBlock = ledgerFiles.filter((f) => f.statusName && !(f.hasStatusLine && f.hasUpdated && f.hasCriteria))
  if (badBlock.length) {
    const missOf = (f) => [!f.hasStatusLine && '状态', !f.hasUpdated && '更新', !f.hasCriteria && '完成判据'].filter(Boolean).join('/')
    glance.push(item('handoff-block', `交接件件首状态块不全 ${badBlock.length} 份：${badBlock.slice(0, 3).map((f) => `${f.name}（缺${missOf(f)}）`).join('、')}${badBlock.length > 3 ? ` 等 ${badBlock.length} 份` : ''}`, {
      next: '按 handoffs/README.md ③-3 补三行：> 状态： / > 更新： / > 完成判据：',
    }))
  }

  // ---------- 5) 本机侧的门（只有给了 --local 才跑） ----------
  if (opts.local) {
    const g = localGates(resolve(cwd, opts.local))
    must.push(...g.must)
    glance.push(...g.glance)
    fine.push(...g.fine)
    skipped.push(...g.skipped)
  } else {
    skipped.push(item('local-off', 'cwd 里没有 tools/rules-audit.js，本机门（规则锁 / 根级登记 / 规则审计）无脚本可跑'))
  }

  return {
    cwd, hours: opts.hours, repos, temp, session, sessionInfo, handoff, must, glance, fine, skipped,
    // v0.7：产物形态与落点由工作区决定 —— 上层（bin / render / --json）需要知道它是怎么判的。
    workspace: { ...workspace, shape: decideShape(workspace) },
  }
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
