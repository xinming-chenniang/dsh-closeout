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
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { collect, conclude } from '../lib/checks.mjs'
import { collectApp, concludeApp } from '../lib/app.mjs'
import { TEXT, render } from '../lib/render.mjs'
import { buildHandoff, safeName, writeHandoff } from '../lib/handoff.mjs'
import { buildReport } from '../lib/report.mjs'
import { resolveArtifactOut } from '../lib/workspace.mjs'
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
    repos: [], temp: [], hours: 12, hoursExplicit: false, json: false, strict: false, zh: false, help: false,
    session: null, sessionsDir: null, handoffs: null,
    threshold: 300, minCalls: 50, days: 3,
    local: null, handoff: false, task: null, force: false, dryRun: false, cwdFromSession: false,
    cwd: null, report: false, reportOut: null, explain: false,
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
    else if (a === '--hours') { o.hours = Number(next()); o.hoursExplicit = true }
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
    else if (a === '--explain') o.explain = true
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
  --hours <n>         force a fixed scratch-file window in hours
                      (default: since this session segment started — see --explain)
  --session <id>      session to inspect (default: $DSH_SESSION_ID, else the most recently written one)
  --sessions-dir <d>  DSH session store (default: ~/.dsh/sessions)
  --handoffs <d>      handoff ledger to check against
                      (default: <workspace>/handoffs, else ~/.dsh/handoffs/<workspace>/)
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
  --explain           print how this tool decides (data sources, order, every override)
  --report            print a wrap-up report skeleton (stdout only)
  --report-out <f>    write the report to this file (relative paths resolve against the
                      workspace root, NOT the cwd)

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


/* ---------------------------------------------------------------- 自述 */

/** 读自己的版本号：--explain 输出的第一行要能对上 npm 上的版本。 */
function selfVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return JSON.parse(raw).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * `--explain`：把「数据从哪来、按什么顺序判、每条怎么覆盖」打成一段可复读的文本。
 * 目的不是文档，而是**让工具回答关于它自己的问题** —— 用户不需要记住阈值和分支。
 */
export function explainText(opts) {
  const v = selfVersion()
  const tokenLine = opts.tokenThreshold > 0 ? String(opts.tokenThreshold) : '关闭（--token-threshold 开启）'
  if (!opts.zh) {
    return `closeout ${v} — how this works (--explain)

What it is
  A read-only judge. One run answers either "can this session be archived/deleted, and does it need a
  handoff?" (default scope) or "can the whole DSH app be closed?" (closeout app).

Where the facts come from (all read-only)
  git    git status --porcelain; rev-list --left-right --count @{u}...HEAD
  files  files under --temp newer than this session segment's start; when --hours N is given,
         newer than N hours instead (node_modules/.git/_trash/__pycache__/.venv/dist/build skipped)
  session event METADATA in ~/.dsh/sessions: call count, turns, peak tokens, last turn reason,
          first/last/segment-start timestamps, depth/parent — the conversation text is never read
  attribution  tool/call **arguments** only (write/edit file_path, absolute paths in pwsh write
          commands): decides which repos / scratch files belong to THIS session, so another
          session's leftovers are listed but never counted. Message bodies are never read.
  ledger <workspace>/handoffs (else ~/.dsh/handoffs/<workspace>/): when a handoff is needed, is there a file claiming this session ('原会话：' line)
  gates  --local <dir>: that workspace's rules-lock / root-registry / rules-audit, only if present

Decision order (session scope)
  1. any blocker touched by THIS session (dirty repo / untracked / unpushed / new scratch files)
     -> "archive, but do not delete"
  2. need a handoff?  calls > ${opts.threshold} (--threshold)
                 or  calls >= ${opts.minCalls} and last turn not completed (--min-calls)
                 or  goal blocked
                 or  crossed a calendar day without closing
                 or  context > ${tokenLine}
  3. handoff needed but no matching file in the ledger -> "write the handoff first"
  4. none of the above -> "safe to archive"
  Child sessions (depth > 0 or with a parent) are never flagged; 0 calls / 0 turns never count.

Every judgement has an override
  --threshold N · --min-calls N · --token-threshold N · --hours N · --temp/--repo · --handoffs DIR
  --local DIR · --json (machine readable) · --strict (exit 1 when something must be handled)

Where the artifacts go (workspace contract)
  A workspace root is the first directory up from cwd that has handoffs/; when no directory on the way
  up has one, it is the nearest directory with AGENTS.md or .git.
    has handoffs/   -> the artifact is a HANDOFF (7 sections + an '原会话：' line); written into that ledger
    no  handoffs/   -> the artifact is a REPORT (6 sections, no '原会话：' line); stdout only unless --report-out
  One workspace yields one artifact, so "a skill that produces two documents" does not happen.
  --report-out resolves against the workspace root, never the cwd (v0.6 used the cwd: a report written
  while standing in tmp/<task>/ landed in a scratch directory nobody reads).
  --handoff / --report stay explicit overrides; with neither, this tool writes no file.

What it deliberately never does
  It does not commit, push, delete, restart, or edit anything (except the files you explicitly ask for
  with --handoff / --report-out). It gives you a verdict, a list and copy-pasteable next steps.
`
  }
  return `closeout ${v} —— 行为自述（--explain）

它是什么
  只读判定器。跑一次，回答两件事之一：「这个会话能不能归档 / 删除、该不该写交接件」（默认口径），
  或者「整个 DSH 能不能退出」（closeout app）。

数据从哪来（全部只读）
  git    git status --porcelain；rev-list --left-right --count @{u}...HEAD
  文件   --temp 里写于「本会话起点」之后的文件；显式给 --hours N 时改为 N 小时内
         （跳过 node_modules/.git/_trash/__pycache__/.venv/dist/build）
         本会话起点 = 最早一条 turn/start（多轮会话覆盖全部轮次；没有则退到 end-seed / 创建时间）
  会话   ~/.dsh/sessions 里的**事件元数据**：调用次数、轮数、token 峰值、末尾 reason、首末/本段起点时间、depth/parent
         —— 不读对话正文
  归属   只读 tool/call 的**参数**（write/edit 的 file_path、pwsh 写命令里的绝对路径）：
         判断哪些仓 / 临时文件是**这个会话**弄的；别的会话留下的照实列出但不计入 —— 正文不读
  台账   <工作区>/handoffs（没有则 ~/.dsh/handoffs/<工作区名>/）：判定该交接时，是否已有声明本会话的交接件（认「原会话：」一行）
  本机门 --local <dir>：该工作区的 规则锁 / 根级登记 / 规则审计，文件存在才跑

判定顺序（会话口径）
  1. 有**本会话碰过**的 blocker（脏仓 / 未跟踪 / 未推 / 临时目录里刚写出来的文件）→「可以归档；先别删」
  2. 该不该交接：calls > ${opts.threshold}（--threshold）
              或 calls ≥ ${opts.minCalls} 且末尾未收口（--min-calls）
              或 goal blocked
              或 跨自然日且未收口
              或 上下文 > ${tokenLine}
  3. 该交接、但台账里没有对应的交接件 →「删之前先写交接件」
  4. 都没有 →「可以归档」
  子会话（depth > 0 或有 parent）不点名；0 调用 0 轮的不算。

每条判据都能覆盖
  --threshold N · --min-calls N · --token-threshold N · --hours N · --temp / --repo · --handoffs DIR
  --local DIR · --json（机读）· --strict（有必须处理项时退出码 1）

产物落在哪（工作区契约）
  工作区根 = 从 cwd 往上，第一处有 handoffs/ 的目录；没有就取最近的 AGENTS.md / .git 那层。
    有 handoffs/  → 产物形态是**交接件**（七节 + 「原会话：」行），写进那个台账
    没有          → 产物形态是**收尾报告**（六节，无「原会话：」行），默认只打到 stdout，--report-out 才写盘
  一个工作区只产出一份 —— 所以「一个技能产出两份文档」不会发生。
  --report-out 的相对路径解析到**工作区根**，不是 cwd（v0.6 用 cwd：在 tmp/<任务>/ 里收尾，
  报告就落进那个没人读的一次性目录）。
  --handoff / --report 仍是显式覆盖；两个都不给，本工具不写任何文件。

它故意不做什么
  不提交、不推送、不删除、不重启、不改文件（除非你显式要 --handoff / --report-out）。
  它给的是「结论 + 清单 + 可复跑的下一步」，不是替你执行。

判据从哪来
  阈值 300 / 50 与五条判据来自本机工作区 tools/sessions-handoff.mjs（有实测依据）；
  交接件的流程与模板来自 shared-handoff-dsh（MIT）。详见 README「来源与借鉴」。
`
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
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (opts.explain) {
    process.stdout.write(explainText(opts))
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
    workspace: r.workspace,
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
    const text = buildHandoff(r, { task: opts.task ? safeName(opts.task) : undefined, workspaceRoot: r.workspace?.root })
    if (opts.dryRun) {
      process.stdout.write(`\n===== 交接件骨架（--dry-run，未写盘）=====\n\n${text}\n`)
    } else {
      const w = writeHandoff(r.handoff.dir, text, {
        task: opts.task ? safeName(opts.task) : undefined,
        force: opts.force,
        workspaceRoot: r.workspace?.root,
      })
      if (w.written) process.stdout.write(`\n已写交接件：${w.path}\n`)
      else if (w.reason === 'exists') process.stdout.write(`\n交接件已存在，未覆盖（要覆盖加 --force）：${w.path}\n`)
      else process.stdout.write(`\n交接件写失败：${w.reason}（${w.path}）\n`)
      // 形态提示：工作区没有台账时，交接件落在全局工作区分目录里 —— 那是给"确实要交接"用的，
      // 只想要一份结论存进项目，报告才是对的形态。
      if (r.workspace && r.workspace.shape === 'report') {
        process.stdout.write(`（本工作区没有 handoffs/ 台账，交接件写进了全局工作区分目录；只留一份结论请用 --report --report-out <文件>）\n`)
      }
    }
  }

  if (opts.report) {
    const text = buildReport(r, v, { task: opts.task ? safeName(opts.task) : undefined, workspaceRoot: r.workspace?.root })
    if (opts.reportOut) {
      // v0.7：相对路径解析到**工作区根**。v0.6 解析到 cwd —— 在 tmp\<任务>\ 里收尾时，
      // 报告就落进那个一次性目录，然后既没人引用、也不会被 tmp 清扫带走。
      const out = resolveArtifactOut(opts.reportOut, { workspaceRoot: r.workspace?.root ?? cwd0 })
      try {
        // 落点可能在工作区根下一个还不存在的子目录（如 docs/）—— v0.6 直接 writeFileSync 会抛栈，
        // 而这正是"验证没跑完"的典型：写失败还留着一条成功的错觉。这里建父目录，失败也明说。
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, text)
        process.stdout.write(`\n已写收尾报告：${out}\n`)
      } catch (e) {
        process.stdout.write(`\n收尾报告写失败：${e && e.message ? e.message : e}（${out}）\n`)
        process.exitCode = 1
      }
      if (r.workspace && r.workspace.shape === 'handoff') {
        process.stdout.write(`（本工作区有交接件台账 ${r.handoff.dir} —— 交接件才是该产出的形态，报告不参与台账；确需留结论再保留这个文件）\n`)
      }
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
