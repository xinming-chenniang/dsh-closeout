#!/usr/bin/env node
/**
 * closeout —— 关会话之前的体检。
 *
 * v0.2 相对 v0.1 的三处改动（都是被实际使用逼出来的，不是功能堆砌）：
 *
 *   1. **答案先行**：输出第一行是判断（能不能删），清单只是依据。以前输出「3 个警告」，
 *      但被问的问题是「我该不该关」。
 *   2. **接上会话**：读 DSH 会话库的**元数据**（调用次数 / 跨天 / 末尾是否收口 / goal 是否 blocked），
 *      于是「这个会话该不该交接」有数可依。**只读事件类型与时间，不读对话正文。**
 *   3. **能出交接件**：`--handoff` 直接生成骨架，把工具已知的事实（会话 id、次数、跨天、
 *      未提交的仓、临时文件）填进「当前状态」一节，只留「做了什么 / 未决 / 回滚点」给人。
 *
 * 零依赖 · 跨平台 · Node ≥ 18（会话那项需 ≥ 22，低版本自动降级并**显式说明**）。
 *
 * 用法：
 *   closeout                                   # 自动发现当前仓库 + ./tmp + 当前会话
 *   closeout --local D:\dsh                    # 额外跑工作区自己的门（规则锁 / 根级登记 / 规则审计）
 *   closeout --session <id> --handoffs ./handoffs
 *   closeout --handoff --task 收尾工具           # 生成交接件骨架
 *   closeout --zh | --json | --strict | --help
 *
 * 退出码：0 = 跑完了（有必须处理项也返回 0）；1 = 加了 --strict 且存在必须处理项；2 = 参数错误。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync, writeFileSync } from 'node:fs'
import { collect, conclude } from '../lib/checks.mjs'
import { collectApp, concludeApp } from '../lib/app.mjs'
import { TEXT, render } from '../lib/render.mjs'
import { buildHandoff, safeName, writeHandoff } from '../lib/handoff.mjs'
import { buildReport } from '../lib/report.mjs'
import { parsePorcelain, gitStatus, discoverRepos } from '../lib/git.mjs'
import { listRecentFiles } from '../lib/files.mjs'

export { parsePorcelain, gitStatus, discoverRepos, listRecentFiles, collect, conclude }

/* ---------------------------------------------------------------- 参数 */

/**
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const o = {
    scope: 'session',
    repos: [], temp: [], hours: 12, json: false, strict: false, zh: false, help: false,
    session: null, sessionsDir: null, handoffs: null,
    threshold: 300, minCalls: 50, days: 3,
    local: null, handoff: false, task: null, force: false, dryRun: false, cwdFromSession: false,
    cwd: null, report: false, reportOut: null,
    recentMinutes: 15, maxSessions: 20, appName: 'DeepSeek Harness', profile: null, restartDir: null,
    tokenThreshold: 0,
  }
  let args = argv
  // 子命令：`closeout session`（默认）/ `closeout app`。放在最前面，别的参数照旧。
  if (args.length > 0 && (args[0] === 'session' || args[0] === 'app')) {
    o.scope = args[0]
    args = args.slice(1)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => {
      const v = args[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === '--repo' || a === '--repos') o.repos.push(next())
    else if (a === '--temp') o.temp.push(next())
    else if (a === '--hours') o.hours = Number(next())
    else if (a === '--session') o.session = next()
    else if (a === '--sessions-dir') o.sessionsDir = next()
    else if (a === '--handoffs') o.handoffs = next()
    else if (a === '--threshold') o.threshold = Number(next())
    else if (a === '--min-calls') o.minCalls = Number(next())
    else if (a === '--days') o.days = Number(next())
    else if (a === '--local') o.local = next()
    else if (a === '--handoff') o.handoff = true
    else if (a === '--task') o.task = next()
    else if (a === '--force') o.force = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--cwd-from-session') o.cwdFromSession = true
    else if (a === '--cwd') o.cwd = next()
    else if (a === '--report') o.report = true
    else if (a === '--report-out') o.reportOut = next()
    else if (a === '--recent-minutes') o.recentMinutes = Number(next())
    else if (a === '--max-sessions') o.maxSessions = Number(next())
    else if (a === '--app-name') o.appName = next()
    else if (a === '--profile') o.profile = next()
    else if (a === '--restart-dir') o.restartDir = next()
    else if (a === '--token-threshold') o.tokenThreshold = Number(next())
    else if (a === '--json') o.json = true
    else if (a === '--strict') o.strict = true
    else if (a === '--zh' || a === '--cn') o.zh = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!Number.isFinite(o.hours) || o.hours <= 0) throw new Error('--hours must be a positive number')
  if (!Number.isFinite(o.threshold) || o.threshold <= 0) throw new Error('--threshold must be a positive number')
  if (!Number.isFinite(o.minCalls) || o.minCalls < 0) throw new Error('--min-calls must be >= 0')
  if (!Number.isFinite(o.days) || o.days <= 0) throw new Error('--days must be a positive number')
  if (!Number.isFinite(o.recentMinutes) || o.recentMinutes <= 0) throw new Error('--recent-minutes must be a positive number')
  if (!Number.isFinite(o.maxSessions) || o.maxSessions <= 0) throw new Error('--max-sessions must be a positive number')
  if (!Number.isFinite(o.tokenThreshold) || o.tokenThreshold < 0) throw new Error('--token-threshold must be >= 0')
  return o
}

const HELP = `closeout — checks you want to run before archiving or deleting an agent session,
or before closing DSH itself.

  closeout [session] [options]   session self-check (default)
  closeout app [options]         app self-check (closing the whole DSH)

session options:
  --repo <dir>        repository to check (repeatable; default: cwd, or its direct children that are repos)
  --temp <dir>        directory of scratch files (repeatable; default: ./tmp when it exists)
  --hours <n>         how "recent" a scratch file must be (default: 12)
  --session <id>      session to inspect (default: $DSH_SESSION_ID, else the most recently written one)
  --sessions-dir <d>  DSH session store (default: ~/.dsh/sessions)
  --handoffs <d>      handoff ledger to check against (default: ~/.dsh/handoffs)
  --threshold <n>     tool calls above which a handoff is expected (default: 300)
  --token-threshold <n>  context tokens above which a handoff is expected (default: 0 = off)
  --min-calls <n>     below this a short session never needs a handoff (default: 50)
  --days <n>          a session touched within n days counts as active (default: 3)
  --handoff           write a handoff skeleton (great with --task <name>)
  --task <name>       handoff file name segment (default: basename of cwd)
  --force             overwrite an existing handoff file
  --dry-run           print the handoff skeleton instead of writing it
  --cwd-from-session  use the session's recorded cwd as the working directory
                      (the desktop client cannot read cwd from the event window)
  --report            print a wrap-up report skeleton (four sections)
  --report-out <f>    write the report to this file instead of stdout

app options (closing DSH itself):
  --app-name <s>      process image to look for (default: DeepSeek Harness)
  --profile <dir>     DSH profile to verify (default: the most recently changed one)
  --restart-dir <d>   where dsh-plugin-restart keeps pending-restart.json
  --recent-minutes <n> sessions written within n minutes count as live (default: 15)
  --max-sessions <n>  how many recent sessions to decompress (default: 20)

shared options:
  --local <dir>       also run that workspace's own gates (rules-lock / hygiene-structure / rules-audit)
  --cwd <dir>         working directory to inspect (default: cwd)
  --json              machine-readable output
  --strict            exit 1 when something must be handled
  --zh                Chinese labels
  --help              this text
`

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
    process.stdout.write(HELP)
    process.exit(0)
  }

  const cwd0 = opts.cwd ? resolve(opts.cwd) : process.cwd()
  if (opts.scope === 'app') runApp(opts, cwd0)
  runSession(opts, cwd0)
}

/** 关本会话的自检（默认口径）：会话元数据 + 交接判定 + 该目录的磁盘事实。 */
function runSession(opts, cwd0) {
  const t = opts.zh ? TEXT.zh : TEXT.en
  const r = collect(opts, cwd0)
  const v = conclude(r)
  const verdictText = v.level === 'no-delete'
    ? t.verdictNoDelete(v.blockers)
    : v.level === 'write-handoff'
      ? t.verdictHandoff(r.handoff.reasons.join(' / ') || `${r.sessionInfo.calls} 次调用`)
      : t.verdictSafe

  const payload = {
    verdict: v.level,
    verdictText,
    cwd: r.cwd,
    hours: r.hours,
    repos: r.repos,
    temp: r.temp,
    session: r.session,
    sessionInfo: r.sessionInfo,
    handoff: { needed: r.handoff.needed, reasons: r.handoff.reasons, exists: r.handoff.exists, dir: r.handoff.dir },
    must: r.must.map((m) => ({ text: m.text, next: m.next ?? null })),
    glance: r.glance.map((m) => ({ text: m.text, next: m.next ?? null })),
    fine: r.fine.map((m) => m.text),
    skipped: r.skipped.map((m) => m.text),
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    process.stdout.write(render(r, t, v.level, verdictText, { color: process.stdout.isTTY === true }) + '\n')
  }

  if (opts.handoff) {
    const text = buildHandoff(r, { task: opts.task ? safeName(opts.task) : undefined })
    if (opts.dryRun) {
      process.stdout.write(`\n===== 交接件骨架（--dry-run，未写盘）=====\n\n${text}\n`)
    } else {
      const w = writeHandoff(r.handoff.dir, text, { task: opts.task ? safeName(opts.task) : undefined, force: opts.force })
      if (w.written) process.stdout.write(`\n已写交接件：${w.path}\n`)
      else if (w.reason === 'exists') process.stdout.write(`\n交接件已存在，未覆盖（要覆盖加 --force）：${w.path}\n`)
      else process.stdout.write(`\n交接件写失败：${w.reason}（${w.path}）\n`)
    }
  }

  if (opts.report) {
    const text = buildReport(r, v, { task: opts.task ? safeName(opts.task) : undefined })
    if (opts.reportOut) {
      const out = resolve(cwd0, opts.reportOut)
      writeFileSync(out, text)
      process.stdout.write(`\n已写收尾报告：${out}\n`)
    } else {
      process.stdout.write(`\n===== 收尾报告（--report，未写盘）=====\n\n${text}`)
    }
  }

  if (opts.strict && v.level !== 'safe') process.exit(1)
  process.exit(0)
}

/**
 * 关闭 DSH 的自检（app 口径）：能不能退、退之前有什么只活在运行态里、下次启动会不会起不来。
 * 只读：不杀进程、不改配置、不写文件。交接件与报告是「关本会话」的产物，这里不做。
 */
function runApp(opts, cwd0) {
  const t = opts.zh ? { ...TEXT.zh, ...TEXT.app.zh } : { ...TEXT.en, ...TEXT.app.en }
  const r = collectApp(opts, cwd0)
  const v = concludeApp(r)
  const verdictText = v.level === 'no-exit'
    ? t.verdictNoExit(v.blockers)
    : v.level === 'check-first'
      ? t.verdictCheck(r.glance.length)
      : t.verdictSafeExit

  const payload = {
    scope: 'app',
    verdict: v.level,
    verdictText,
    cwd: r.cwd,
    profile: r.app.profile,
    sessions: r.app.sessions,
    processes: r.app.processes.procs.map((p) => ({ name: p.name, pid: p.pid, memKB: p.memKB })),
    pendingRestart: r.app.restart.pending,
    lastRestart: r.app.restart.last,
    must: r.must.map((m) => ({ text: m.text, next: m.next ?? null })),
    glance: r.glance.map((m) => ({ text: m.text, next: m.next ?? null })),
    fine: r.fine.map((m) => m.text),
    skipped: r.skipped.map((m) => m.text),
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    process.stdout.write(render(r, t, v.level, verdictText, { color: process.stdout.isTTY === true }) + '\n')
  }

  if (opts.handoff || opts.report) {
    process.stdout.write('\n（app 自检不出交接件/报告：那是「关本会话」产出的东西）\n')
  }

  if (opts.strict && v.level !== 'safe-exit') process.exit(1)
  process.exit(0)
}

// 只在「被直接执行」时跑 main；被测试 import 时不跑（否则 --test 会把进程参数当 CLI 参数）。
//
// 判据不能用路径字符串相等：`npm link` 在全局目录建的是 **junction**，Node 会把
// `import.meta.url` 解析成真实路径，而 `process.argv[1]` 仍是 junction 路径 —— 两者不相等，
// main 就整个被跳过，于是「退出码 0 + 空输出」。那正是本工具最该避免的静默失败，实测踩过。
// 所以两边都先做 realpath 归一，再比。
function realOf(p) {
  try {
    return realpathSync.native(p)
  } catch {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
}
const invokedDirectly = process.argv[1] !== undefined && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))
if (invokedDirectly) main(process.argv.slice(2))
