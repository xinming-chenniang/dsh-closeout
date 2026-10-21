/**
 * 收尾报告骨架（`--report`）。
 *
 * 和 `--handoff` 的分工：交接件是**写给下一个会话**的接力件；收尾报告是**本次收尾的对外结论**
 * （做了什么 / 当前状态 / 未决 / 回滚点）。两者共享同一批已知事实，但用途不同，不合并。
 *
 * 机器契约：报告**不参与** handoffs 台账，所以刻意**不写** `原会话：` 行 —— 否则下一个会话
 * 会把它当成一份交接件，与 `handoffs/README.md` 的对账规则打架。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fmtTime } from './render.mjs'

const SYNC_SCRIPTS = ['dsh-sync.sh', 'dsh-sync.ps1']

/** 找当前工作区的跨端同步器（只探测，不调用）。 */
export function findSyncScript(cwd) {
  for (const name of SYNC_SCRIPTS) {
    const p = join(cwd, 'tools', name)
    if (existsSync(p)) return { name, path: p }
  }
  return null
}

/**
 * @param {object} r collect 的结果
 * @param {{level: string, blockers?: any[]}} v conclude 的结果
 * @param {{task?: string, now?: number}} [opt]
 * @returns {string}
 */
export function buildReport(r, v, opt = {}) {
  const now = opt.now ?? Date.now()
  const s = r.sessionInfo
  const sync = findSyncScript(r.cwd)
  const lines = []

  lines.push(`# 收尾报告${opt.task ? ` · ${opt.task}` : ''}（${fmtTime(now).slice(0, 10)}）`)
  lines.push('')
  lines.push(`> 生成：dsh-closeout v0.3 · ${fmtTime(now)}（本地时间）`)
  lines.push(`> 工作目录：${r.cwd}${s?.id ? ` · 会话：${s.id}` : ''}`)
  if (s?.calls !== undefined) {
    lines.push(`> 会话：${s.calls} 次调用 / 跨 ${s.span} 天 / 末次 ${fmtTime(s.last)}`)
  }
  lines.push('')

  lines.push('## 结论')
  lines.push('')
  lines.push(
    v.level === 'no-delete'
      ? `- 可以归档；先别删 —— ${v.blockers} 件东西只活在磁盘上（见「当前状态」）`
      : v.level === 'write-handoff'
        ? '- 可以归档；删之前先写交接件（`closeout --handoff` 出骨架）'
        : '- 可以直接归档或删除',
  )
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
    const syncState = !repo.upstream ? '无上游' : `领先 ${repo.ahead ?? 0} / 落后 ${repo.behind ?? 0}`
    lines.push(`| 仓库 ${repo.dir} | ${state}；${syncState} | \`git -C "${repo.dir}" status --porcelain\` |`)
  }
  for (const t of r.temp) {
    lines.push(`| 临时目录 ${t.dir} | 最近 ${r.hours} 小时 ${t.files.length} 个文件 | \`closeout --temp "${t.dir}" --hours ${r.hours}\` |`)
  }
  lines.push('')
  lines.push('（已验证 / 未验证分开写；上面每条命令都要能直接复制跑。）')
  lines.push('')

  lines.push('## 未决 / 下一步')
  lines.push('')
  if (r.must.length) {
    for (const m of r.must) lines.push(`- [ ] ${m.text}${m.next ? `（${m.next}）` : ''}`)
  } else {
    lines.push('- （无必须处理项）')
  }
  lines.push('')

  lines.push('## 收尾·同步（可选）')
  lines.push('')
  if (sync) {
    lines.push(`- 检测到同步器 \`${sync.name}\`：先 \`status\` 再按需 \`push\`（家机默认只 commit 不 push）`)
    lines.push(`- \`${sync.path} status\` / \`${sync.path} push\``)
  } else {
    lines.push('- 未检测到工作区的跨端同步器（`tools/dsh-sync.*`）；同步按该工作区自己的纪律。')
  }
  lines.push('')

  lines.push('## 回滚点')
  lines.push('')
  lines.push('（改了哪些东西、怎么退回；没有就写"无"。）')
  lines.push('')
  return lines.join('\n') + '\n'
}
