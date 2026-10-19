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
import { collect, conclude } from '../lib/checks.mjs'
import { TEXT, render } from '../lib/render.mjs'
import { buildHandoff, safeName, writeHandoff } from '../lib/handoff.mjs'
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
    repos: [], temp: [], hours: 12, json: false, strict: false, zh: false, help: false,
    session: null, sessionsDir: null, handoffs: null,
    threshold: 300, minCalls: 50, days: 3,
    local: null, handoff: false, task: null, force: false, dryRun: false,
  }
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
  return o
}

const HELP = `closeout — checks you want to run before archiving or deleting an agent session.

  --repo <dir>        repository to check (repeatable; default: cwd, or its direct children that are repos)
  --temp <dir>        directory of scratch files (repeatable; default: ./tmp when it exists)
  --hours <n>         how "recent" a scratch file must be (default: 12)
  --session <id>      session to inspect (default: $DSH_SESSION_ID, else the most recently written one)
  --sessions-dir <d>  DSH session store (default: ~/.dsh/sessions)
  --handoffs <d>      handoff ledger to check against (default: ~/.dsh/handoffs)
  --threshold <n>     tool calls above which a handoff is expected (default: 300)
  --min-calls <n>     below this a short session never needs a handoff (default: 50)
  --days <n>          a session touched within n days counts as active (default: 3)
  --local <dir>       also run that workspace's own gates (rules-lock / hygiene-structure / rules-audit)
  --handoff           write a handoff skeleton (great with --task <name>)
  --task <name>       handoff file name segment (default: basename of cwd)
  --force             overwrite an existing handoff file
  --dry-run           print the handoff skeleton instead of writing it
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

  const t = opts.zh ? TEXT.zh : TEXT.en
  const r = collect(opts)
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
    must: r.must.map((m) => m.text),
    glance: r.glance.map((m) => m.text),
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

  if (opts.strict && v.level !== 'safe') process.exit(1)
  process.exit(0)
}

// 只在「被直接执行」时跑 main；被测试 import 时不跑（否则 --test 会把进程参数当 CLI 参数）。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) main(process.argv.slice(2))
