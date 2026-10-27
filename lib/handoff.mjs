/**
 * 交接件骨架生成。
 *
 * 为什么由工具生成骨架而不是人从空白写：**判据它已经有了**（会话 id、调用次数、跨天、末次、
 * 未提交的仓、临时文件清单）。这些正好是交接件「当前状态」那一节的主体，抄错了就等于没交接。
 * 需要人写的只有「做了什么 / 未决 / 回滚点」—— 那三节留空，且给出明确的写法要求。
 *
 * 机器契约（抄自工作区 handoffs\README.md，工具靠它把会话与交接件对上）：
 *   ① 必须有 `原会话：session-...` 一行；
 *   ② 不是单会话收口的文件，在开头 15 行内写 `非单会话收口`，工具会跳过。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fmtTime } from './render.mjs'
import { writeLedgerStamp } from './workspace.mjs'

const pad = (n) => String(n).padStart(2, '0')

/** 文件名用的日期戳（本地时区）。 */
export function stampOf(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 把任意字符串变成安全的文件名段。 */
export function safeName(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'session'
}

/**
 * 生成交接件正文。
 * @param {object} r collect 的结果
 * @param {{task?: string, now?: number}} [opt]
 * @returns {string}
 */
export function buildHandoff(r, opt = {}) {
  const now = opt.now ?? Date.now()
  const task = opt.task || safeName(r.cwd.split(/[\\/]/).filter(Boolean).pop())
  const s = r.sessionInfo
  const lines = []

  lines.push(`# ${task} · 交接（${fmtTime(now).slice(0, 10)}）`)
  lines.push('')
  if (s?.id) lines.push(`> 原会话：${s.id} · 状态：进行中`)
  lines.push(`> 生成：dsh-closeout v0.6 · ${fmtTime(now)}（本地时间）`)
  if (s?.calls !== undefined) {
    lines.push(`> 判据：${s.calls} 次调用 / 跨 ${s.span} 天${s.maxTotalTokens ? ` / 上下文 ${Math.round(s.maxTotalTokens / 1000)}k` : ''} / 末次 ${fmtTime(s.last)}${r.handoff?.reasons?.length ? ' / ' + r.handoff.reasons.join(' / ') : ''}`)
  }
  lines.push('')

  lines.push('## 目标')
  lines.push('')
  lines.push(s?.title ? `（会话标题：${s.title}；补一句这个会话要达成什么。）` : '（一行：这个会话要达成什么。工具不知道，留给人填。）')
  lines.push('')

  lines.push('## 做了什么')
  lines.push('')
  lines.push('（3–6 条，一行一条，带证据：命令 + 实际输出。**这一节只能由会话自己填** —— 工具不知道你干了什么。）')
  lines.push('')
  lines.push('- ')
  lines.push('')

  lines.push('## 当前状态（可复跑验证）')
  lines.push('')
  lines.push('| 项 | 结果 | 怎么复核 |')
  lines.push('|---|---|---|')
  for (const repo of r.repos) {
    const state = repo.dirty
      ? `未提交 ${repo.staged + repo.modified + repo.untracked}（暂存 ${repo.staged} / 修改 ${repo.modified} / 未跟踪 ${repo.untracked}）`
      : '干净'
    const sync = !repo.upstream ? '无上游' : `领先 ${repo.ahead ?? 0} / 落后 ${repo.behind ?? 0}`
    lines.push(`| 仓库 ${repo.dir} | ${state}；${sync} | \`git -C "${repo.dir}" status --porcelain\` |`)
  }
  for (const t of r.temp) {
    // 口径与 checks.mjs 一致：`total` 是**本会话写的**总数（`files` 只是明细前 12 个），
    // `otherTotal` 是同窗口别的会话写的。别再写 `r.hours` —— 那是旧措辞，
    // 而且拿 `files.length` 当计数会少报（2026-10-25 改）。
    const mine = t.total ?? (t.files?.length ?? 0)
    const other = t.otherTotal ?? 0
    const state = mine === 0
      ? `本会话没有写文件${other ? `（同窗口另有 ${other} 个是别的会话写的）` : ''}`
      : `本会话写了 ${mine} 个文件${other ? `（同窗口另有 ${other} 个是别的会话写的）` : ''}`
    lines.push(`| 临时目录 ${t.dir} | ${state} | \`closeout --temp "${t.dir}" --json\`（看 files / total / otherTotal） |`)
  }
  if (s?.id) {
    lines.push(`| 会话长度 | ${s.calls} 次调用 / 跨 ${s.span} 天 | 重跑本工具的收口检查 |`)
    lines.push(`| 交接判据 | ${r.handoff?.needed ? r.handoff.reasons.join(' / ') : '未超线，不需要交接件'} | 同上 |`)
  }
  lines.push('')
  lines.push('（已验证 / 未验证分开写；上面每条命令都要能直接复制跑。）')
  lines.push('')

  lines.push('## 关键文件')
  lines.push('')
  const keyFiles = (r.repos ?? [])
    .flatMap((x) => (x.files ?? []).map((f) => `- ${f}`))
    .slice(0, 10)
  if (keyFiles.length > 0) {
    lines.push('（来自未提交清单，按需补/删）')
    lines.push('')
    lines.push(...keyFiles)
  } else {
    lines.push('（按需填：改了哪些文件、为什么关键。）')
  }
  lines.push('')

  lines.push('## 未决 / 下一步')
  lines.push('')
  lines.push('（接手的人第一步该干什么。不要写「继续完善」这种没有动作的话。）')
  lines.push('')
  lines.push('- ')

  const unhandled = r.must.map((m) => m.text)
  if (unhandled.length) {
    lines.push('')
    lines.push('收尾时仍未处理（工具查出）：')
    for (const u of unhandled) lines.push(`- ${u}`)
  }
  lines.push('')

  lines.push('## 开放问题')
  lines.push('')
  lines.push('（接手的人会卡住的地方：没定的事、没验证的假设、需要问用户的决定。）')
  lines.push('')
  lines.push('- ')
  lines.push('')

  lines.push('## 回滚点')
  lines.push('')
  lines.push('（改了哪些东西、怎么退回；没有就写「无」。）')
  lines.push('')
  lines.push('- 无')
  lines.push('')
  return lines.join('\n')
}

/**
 * 写交接件。默认**不覆盖**已有文件（交接件被覆盖 = 丢掉别人写的东西）。
 * @param {string} dir
 * @param {string} text
 * @param {{task?: string, now?: number, force?: boolean, workspaceRoot?: string}} [opt]
 * @returns {{path: string, written: boolean, reason?: string}}
 */
export function writeHandoff(dir, text, opt = {}) {
  const now = opt.now ?? Date.now()
  // 命名规范（2026-10-26 起，与 D:\dsh\handoffs\README.md 一致）：`（<状态>）<YYYYMMDD>-<主题>.md`，状态段在最前
  const name = `（进行中）${stampOf(now)}-${safeName(opt.task)}.md`
  const path = join(dir, name)
  if (!opt.force && existsSync(path)) return { path, written: false, reason: 'exists' }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, text, 'utf8')
    // 全局工作区分目录（~/.dsh/handoffs/<工作区名>/）留一份归属戳：同名工作区撞车时，
    // 下一次能靠它认出"是不是同一个项目"，而不是把两个项目的交接件混进一个目录。
    if (opt.workspaceRoot) writeLedgerStamp(dir, opt.workspaceRoot)
    return { path, written: true }
  } catch (e) {
    return { path, written: false, reason: String(e && e.message ? e.message : e) }
  }
}
