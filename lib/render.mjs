/**
 * 渲染层：先给**结论**，再给分组清单。
 *
 * 为什么先给结论：这个工具被用到的时刻是「我要不要关掉它」，答案是一个判断，
 * 不是一串警告。清单只是判断的依据，所以放在判断下面。
 */

export const TEXT = {
  en: {
    title: 'closeout — pre-close checks',
    verdict: 'Verdict',
    must: 'Must handle',
    glance: 'Worth a look',
    fine: 'Nothing to do',
    skipped: 'Not checked (not the same as fine)',
    repos: 'Repositories',
    temp: 'Recently written files',
    handoff: 'Handoff',
    clean: 'clean',
    none: 'none',
    sessionLine: (s) => `session ${shortId(s.id)} · ${s.calls ?? '?'} tool calls · ${s.span ?? '?'} day(s) · last ${fmtTime(s.last)}`,
    guessed: '(latest session guessed by file time)',
    verdictNoDelete: (n) => `archive is fine; do NOT delete — ${n} item(s) still only live on disk`,
    verdictHandoff: (why) => `archive is fine; write the handoff before deleting (${why})`,
    verdictSafe: 'safe to archive or delete',
    cwdMismatch: (d) => `note: this session records ${d}, not the current directory — its counts may not apply here`,
    hint: 'Only deletions are gated: archiving is reversible, deleting is not.',
  },
  zh: {
    title: '收口 —— 关会话之前的体检',
    verdict: '结论',
    must: '必须处理',
    glance: '顺手看一眼',
    fine: '不用管',
    skipped: '没查的（不等于没问题）',
    repos: '仓库',
    temp: '最近写出来的文件',
    handoff: '该不该交接',
    clean: '干净',
    none: '无',
    sessionLine: (s) => `会话 ${shortId(s.id)} · ${s.calls ?? '?'} 次调用 · 跨 ${s.span ?? '?'} 天 · 末次 ${fmtTime(s.last)}`,
    guessed: '（按文件时间推测的「最近会话」）',
    verdictNoDelete: (n) => `可以归档；先别删 —— 还有 ${n} 件东西只活在磁盘上`,
    verdictHandoff: (why) => `可以归档；删之前先写交接件（${why}）`,
    verdictSafe: '可以直接归档或删除',
    cwdMismatch: (d) => `注意：这个会话记录的目录是 ${d}，不是当前目录 —— 它的计数未必适用于这里`,
    hint: '只对「删除」设门槛：归档可逆，删除不可逆。',
  },
}

/** 会话 id 的短形式：`session-` 前缀对辨认没有帮助，去掉后取前 8 位。 */
export function shortId(id) {
  if (!id) return '?'
  return String(id).replace(/^session-/, '').slice(0, 8) || '?'
}

/** 本地时间（不写 UTC，否则跨时区看会差一截）。 */
export function fmtTime(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const BAR = '─'.repeat(44)

/**
 * @param {object} r collect 的结果
 * @param {object} t 文案表
 * @param {'no-delete'|'write-handoff'|'safe'} level 结论级别
 * @param {string} verdictText 结论句
 * @param {{color?: boolean}} [opt]
 */
export function render(r, t, level, verdictText, opt = {}) {
  const color = opt.color === true
  const red = color ? '\u001b[31m' : ''
  const yel = color ? '\u001b[33m' : ''
  const grn = color ? '\u001b[32m' : ''
  const dim = color ? '\u001b[2m' : ''
  const off = color ? '\u001b[0m' : ''
  const out = []

  const head = r.session ? `${t.title} · ${t.sessionLine(r.sessionInfo)}${r.sessionInfo.guessed ? ' ' + t.guessed : ''}` : t.title
  out.push(head)
  out.push(BAR)
  const mark = level === 'safe' ? grn + '✓' : level === 'no-delete' ? red + '✗' : yel + '!'
  out.push(`${t.verdict}：${mark}${off} ${verdictText}`)
  out.push('')

  // 交接判断放第二位：它是「该不该结束」的另一半，和结论一起读才完整。
  if (r.session) {
    const v = r.handoff
    const ok = !v.needed || v.exists
    out.push(`${t.handoff}：${ok ? grn + '✓' + off : yel + '!' + off} ${v.note ?? ''}`)
    if (v.cwdMismatch) out.push(`  ${dim}${t.cwdMismatch(v.cwdMismatch)}${off}`)
    out.push('')
  }

  const section = (title, items, symbol, tint) => {
    out.push(`${title}：${items.length}`)
    for (const it of items) {
      out.push(`  ${tint}${symbol}${off} ${it.text}`)
      if (it.id === 'repo-dirty' && it.repo?.files?.length) {
        for (const f of it.repo.files.slice(0, 6)) out.push(`      ${dim}${f}${off}`)
        if (it.repo.files.length > 6) out.push(`      ${dim}…${off}`)
      }
      if (it.id === 'temp-files' && it.temp?.files?.length) {
        for (const f of it.temp.files.slice(0, 6)) out.push(`      ${dim}${f.path.replace(it.temp.dir + '/', '').replace(it.temp.dir + '\\', '')}  ${Math.round(f.size / 1024)} KB${off}`)
        if (it.temp.files.length > 6) out.push(`      ${dim}…${off}`)
      }
    }
    out.push('')
  }

  if (r.must.length) section(t.must, r.must, '✗', red)
  if (r.glance.length) section(t.glance, r.glance, '!', yel)
  if (r.fine.length) section(t.fine, r.fine, '✓', grn)
  if (r.skipped.length) section(t.skipped, r.skipped, '·', dim)

  out.push(`${dim}${t.hint}${off}`)
  return out.join('\n')
}
