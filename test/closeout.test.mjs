/**
 * dsh-closeout 的冒烟测试（无需浏览器 / 无需联网 / 无第三方依赖）。
 *
 * 重点钉三类最容易写错、且错了看不出来的东西：
 *   1. **判据的边界**（超线、未收口、子会话、短会话）—— 错了会让"该交接"漏报；
 *   2. **「最新 N 个」不是「遍历序前 N 个」** —— v0.1 的真 bug，见 listRecentFiles；
 *   3. **输出模型**：结论先行、三档结论、交接件骨架里有 `原会话：`（机器靠它对账）。
 *
 * 会话元数据的解析与 zstd 解耦（`parseSessionLines`），所以 Node 18/20 也能跑完这些用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync, rmdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseArgs } from '../bin/closeout.mjs'
import { parsePorcelain } from '../lib/git.mjs'
import { listRecentFiles } from '../lib/files.mjs'
import { parseSessionLines, handoffVerdict, daysSpan, readHandoffs } from '../lib/session.mjs'
import { collect, conclude, sameTree, localGates } from '../lib/checks.mjs'
import { checkProfile, concludeApp, parseMem, readPendingRestart, readRestartResult, scanSessions } from '../lib/app.mjs'
import { render, TEXT } from '../lib/render.mjs'
import { buildHandoff, writeHandoff, stampOf, safeName } from '../lib/handoff.mjs'
import { buildReport, findSyncScript } from '../lib/report.mjs'

const HOUR = 3600e3

/** 临时目录 + 保证清理。 */
function withTmp(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'closeout-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 造一条会话事件行。 */
const ev = (type, time, data) => JSON.stringify({ type, time, data })

/* ------------------------------------------------------------------ git */

test('parsePorcelain：暂存 / 修改 / 未跟踪 分开数', () => {
  const r = parsePorcelain(['M  a.txt', ' M b.txt', '?? c.txt', 'MM d.txt', 'R  old -> new'].join('\n'))
  assert.equal(r.staged, 3) // M, MM, R
  assert.equal(r.modified, 2) // ' M' 一处 + 'MM' 的工作区那一半
  assert.equal(r.untracked, 1)
  assert.equal(r.files.length, 5)
})

test('parsePorcelain：空输入不炸', () => {
  assert.deepEqual(parsePorcelain(''), { staged: 0, modified: 0, untracked: 0, files: [] })
  assert.deepEqual(parsePorcelain(undefined), { staged: 0, modified: 0, untracked: 0, files: [] })
})

/* ---------------------------------------------------------------- files */

test('listRecentFiles：只收「够新」的，且跳过 node_modules', withTmp(async (dir) => {
  const fresh = join(dir, 'fresh.txt')
  const old = join(dir, 'old.txt')
  writeFileSync(fresh, 'x')
  writeFileSync(old, 'y')
  const longAgo = new Date(Date.now() - 48 * HOUR)
  utimesSync(old, longAgo, longAgo)
  const hits = listRecentFiles(dir, Date.now() - 12 * HOUR)
  assert.deepEqual(hits.map((h) => h.path.split(/[\\/]/).pop()), ['fresh.txt'])

  const nm = join(dir, 'node_modules')
  mkdirSync(nm)
  writeFileSync(join(nm, 'dep.js'), 'z')
  assert.equal(listRecentFiles(dir, 0).filter((h) => h.path.includes('node_modules')).length, 0)
}))

test('listRecentFiles：返回**最新**的 N 个，而不是目录遍历序的前 N 个', withTmp(async (dir) => {
  // 造 20 个文件：名字按 a00…a19，mtime 依次变新
  const now = Date.now()
  for (let i = 0; i < 20; i++) {
    const p = join(dir, `a${String(i).padStart(2, '0')}.txt`)
    writeFileSync(p, String(i))
    const t = new Date(now - (19 - i) * 60e3)
    utimesSync(p, t, t)
  }
  const hits = listRecentFiles(dir, 0, 3)
  assert.deepEqual(hits.map((h) => h.path.split(/[\\/]/).pop()), ['a19.txt', 'a18.txt', 'a17.txt'])
}))

/* ------------------------------------------------------------ 会话元数据 */

test('parseSessionLines：调用数 / 跨天 / 结束原因 / 子会话标记', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: 1000, cwd: 'D:\\x', delegationDepth: 0 }),
    ev('tool/call', 1000),
    ev('tool/call', 2000),
    ev('turn/start', 3000),
    ev('turn/end', 4000, { reason: { kind: 'error' } }),
  ]
  const m = parseSessionLines(lines)
  assert.equal(m.id, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(m.calls, 2)
  assert.equal(m.turns, 1)
  assert.equal(m.lastReason, 'error', 'turn/end 的 data.reason.kind 要能被读到')
  assert.equal(m.depth, 0)
})

test('handoffVerdict：超线要交接，短会话不要，子会话不点名', () => {
  const long = { calls: 400, turns: 10, lastReason: 'completed', depth: 0, parent: null, first: 0, last: 0 }
  assert.equal(handoffVerdict(long, { threshold: 300, minCalls: 50 }).needed, true)

  const short = { calls: 20, turns: 2, lastReason: 'completed', depth: 0, parent: null, first: 0, last: 0 }
  assert.equal(handoffVerdict(short, { threshold: 300, minCalls: 50 }).needed, false)

  const child = { calls: 400, turns: 10, lastReason: 'completed', depth: 1, parent: 'session-x', first: 0, last: 0 }
  assert.equal(handoffVerdict(child, { threshold: 300, minCalls: 50 }).needed, false, '子会话不该被点名')

  const broken = { calls: 80, turns: 3, lastReason: 'error', depth: 0, parent: null, first: 0, last: 5 * HOUR }
  const v = handoffVerdict(broken, { threshold: 300, minCalls: 50 })
  assert.equal(v.needed, true, '末尾未收口的长会话要交接')
  assert.match(v.reasons.join(' '), /未收口/)
})

test('daysSpan：同一天记 1，跨天按自然日向上取整', () => {
  assert.equal(daysSpan(0, 1000), 1)
  assert.equal(daysSpan(0, 30 * HOUR), 2)
})

test('readHandoffs：只认 `原会话：` 行，跳过「非单会话收口」', withTmp(async (dir) => {
  const id = 'session-11111111-2222-3333-4444-555555555555'
  writeFileSync(join(dir, 'a.md'), `# 交接\n\n> 原会话：${id}\n\n正文里提到别的 id 不算。\n`)
  writeFileSync(join(dir, 'b.md'), `# 索引件\n\n非单会话收口\n\n正文顺带提 ${id}\n`)
  writeFileSync(join(dir, 'c.md'), `# 随手记\n\n正文提一下 ${id}\n`, 'utf8')
  const ledger = readHandoffs(dir)
  assert.equal(ledger.ids.has(id), true, 'a.md 应当认领这个会话')
  assert.equal(ledger.files.length, 2, 'b.md 被跳过、c.md 没有原会话行但也不叠加 id')
  assert.equal(ledger.files.find((f) => f.name === 'c.md').ids.length, 0, '正文里顺带提到的 id 不算')
}))

/* -------------------------------------------------------------- 采集与结论 */

test('collect：空环境（无仓库 / 无临时目录 / 无会话）不该报必须处理', withTmp(async (dir) => {
  const opts = parseArgs(['--sessions-dir', join(dir, 'nope'), '--handoffs', join(dir, 'none')])
  const r = collect(opts, dir)
  assert.deepEqual(r.repos, [])
  assert.deepEqual(r.temp, [])
  assert.equal(r.must.length, 0)
  assert.ok(r.skipped.length >= 1, '读不到会话必须落在 skipped，而不是静默当成没问题')
}))

test('sameTree：子目录算同一棵树，同名前缀的兄弟目录不算', () => {
  assert.equal(sameTree('D:\\dsh', 'D:\\dsh\\sub'), true, '在子目录里跑是正常用法')
  assert.equal(sameTree('D:\\dsh\\sub', 'D:\\dsh'), true)
  assert.equal(sameTree('D:\\dsh', 'D:\\dsh2'), false, 'dsh2 不是 dsh 的子目录')
  assert.equal(sameTree('/a/b', '/a/b/c'), true)
  assert.equal(sameTree('/a/b', '/a/c'), false)
})

test('render：会话的 cwd 与当前目录不同树时，必须出现提示', () => {
  const r = {
    cwd: 'D:/other/place', hours: 12, repos: [], temp: [],
    session: {}, sessionInfo: { id: 'session-x', calls: 1, span: 1 },
    handoff: { needed: false, exists: false, reasons: [], note: '未超线', cwdMismatch: 'D:\\dsh' },
    must: [], glance: [], fine: [], skipped: [],
  }
  assert.match(render(r, TEXT.zh, 'safe', TEXT.zh.verdictSafe), /记录的目录是 D:\\dsh/)
})

test('conclude：三档结论', () => {
  assert.equal(conclude({ must: [{ text: 'x' }], handoff: { needed: false, exists: false } }).level, 'no-delete')
  assert.equal(conclude({ must: [], handoff: { needed: true, exists: false } }).level, 'write-handoff')
  assert.equal(conclude({ must: [], handoff: { needed: true, exists: true } }).level, 'safe')
  assert.equal(conclude({ must: [], handoff: { needed: false, exists: false } }).level, 'safe')
})

test('render：结论句在最前，且三档各有自己的措辞', () => {
  const r = {
    cwd: 'D:/x', hours: 12, repos: [], temp: [],
    session: null, sessionInfo: {}, handoff: { needed: false, exists: false, reasons: [], note: null },
    must: [{ id: 'repo-dirty', text: 'repo 脏' }], glance: [], fine: [], skipped: [],
  }
  const out = render(r, TEXT.zh, 'no-delete', TEXT.zh.verdictNoDelete(1))
  const lines = out.split('\n')
  assert.ok(lines.findIndex((l) => l.startsWith('结论')) < lines.findIndex((l) => l.startsWith('必须处理')), '结论必须先出现')
  assert.match(out, /先别删/)

  const safe = render({ ...r, must: [] }, TEXT.zh, 'safe', TEXT.zh.verdictSafe)
  assert.match(safe, /可以直接归档或删除/)

  const hf = render({ ...r, must: [] }, TEXT.zh, 'write-handoff', TEXT.zh.verdictHandoff('超线（400 次 > 300）'))
  assert.match(hf, /删之前先写交接件/)
})

/* ---------------------------------------------------------------- 交接件 */

test('buildHandoff：必须有 `原会话：` 一行（机器靠它对账）', () => {
  const id = 'session-99999999-8888-7777-6666-555555555555'
  const r = {
    cwd: 'D:/work/api', hours: 12,
    repos: [{ dir: 'D:/work/api', dirty: true, staged: 0, modified: 2, untracked: 1, ahead: 1, behind: 0, upstream: true, files: ['a.ts'] }],
    temp: [],
    session: { id, calls: 400 },
    sessionInfo: { id, calls: 400, span: 2, last: Date.now() },
    handoff: { needed: true, exists: false, reasons: ['超线（400 次 > 300）'], note: null },
    must: [{ id: 'repo-dirty', text: 'D:/work/api → 2 已修改' }],
    glance: [], fine: [], skipped: [],
  }
  const text = buildHandoff(r, { now: 1792448000000, task: 'api 收尾' })
  assert.match(text, new RegExp(`原会话：${id}`))
  assert.match(text, /## 做了什么/)
  assert.match(text, /## 当前状态/)
  assert.match(text, /## 回滚点/)
  assert.match(text, /未提交 3/, '表格里要有可复跑的事实')
  assert.match(text, /超线（400 次 > 300）/)
})

test('writeHandoff：默认不覆盖已有文件', withTmp(async (dir) => {
  const now = 1792448000000
  const name = `${stampOf(now)}-${safeName('任务')}.md`
  writeFileSync(join(dir, name), 'old')
  const w = writeHandoff(dir, 'new', { task: '任务', now })
  assert.equal(w.written, false)
  assert.equal(w.reason, 'exists')

  const w2 = writeHandoff(dir, 'new', { task: '任务', now, force: true })
  assert.equal(w2.written, true)
}))

test('safeName：挡掉路径分隔符与非法字符', () => {
  assert.equal(safeName('a/b\\c:d*?"<>|e'), 'a-b-c-d-e')
  assert.equal(safeName('   '), 'session')
})

/* ---------------------------------------------------------------- CLI */

test('parseArgs：未知参数 / 非法数值 / 缺值 都报错', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--hours', '0']), /positive/)
  assert.throws(() => parseArgs(['--threshold', '-5']), /positive/)
  assert.throws(() => parseArgs(['--repo']), /missing value/)
  assert.deepEqual(parseArgs(['--repo', 'a', '--repo', 'b', '--zh']).repos, ['a', 'b'])
  const o = parseArgs(['--handoff', '--task', 'x', '--dry-run', '--session', 'last'])
  assert.equal(o.handoff, true)
  assert.equal(o.task, 'x')
  assert.equal(o.dryRun, true)
  assert.equal(o.session, 'last')
})

test('CLI 直接跑：退出码 0，--json 是合法 JSON 且含结论字段', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const out = execFileSync(process.execPath, ['bin/closeout.mjs', '--json'], { cwd: here, encoding: 'utf8' })
  const j = JSON.parse(out)
  assert.ok(Array.isArray(j.repos))
  assert.ok(['no-delete', 'write-handoff', 'safe'].includes(j.verdict), `verdict 取值意外：${j.verdict}`)
  assert.equal(typeof j.verdictText, 'string')
  assert.ok(Array.isArray(j.must) && Array.isArray(j.skipped))
})

test('CLI --explain：自述给出判定顺序与覆盖开关，且不依赖会话', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const out = execFileSync(process.execPath, ['bin/closeout.mjs', '--explain', '--zh'], { cwd: here, encoding: 'utf8' })
  assert.match(out, /判定顺序/)
  assert.match(out, /--threshold/)
  assert.match(out, /不读对话正文/)
  assert.match(out, /sessions-handoff\.mjs/)
  assert.ok(!/SyntaxError/.test(out), '--explain 输出不该包含语法错误')
})

test('CLI 通过 junction / symlink 调用也能跑（invokedDirectly 不能用路径字符串比较）', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'closeout-junction-'))
  const link = join(dir, 'pkg')
  try {
    symlinkSync(here, link, 'junction')
    let out = ''
    try {
      out = execFileSync(process.execPath, [join(link, 'bin', 'closeout.mjs'), '--json'], { encoding: 'utf8' })
    } catch (e) {
      out = e && e.stdout ? String(e.stdout) : ''
    }
    assert.ok(out.trim().startsWith('{'), '通过 junction 调用必须有输出；空输出 + 退出码 0 就是那个静默失败')
    JSON.parse(out)
  } finally {
    // junction 只删链接本身：先 rmdir 链接，再删临时目录，最后确认源目录还在
    if (existsSync(link)) {
      try {
        rmdirSync(link)
      } catch {
        // 试探式清理：不阻断测试，但下面会断言源目录仍在
      }
    }
    rmSync(dir, { recursive: true, force: true })
    assert.equal(existsSync(join(here, 'bin', 'closeout.mjs')), true, '清理 junction 时不能误删源目录')
  }
})

test('CLI --strict：有必须处理项时退出码 1', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  // 在一个「自身未提交」的仓库里跑：仓库干净与否取决于工作区，这里改用必然命中的临时目录
  const dir = mkdtempSync(join(tmpdir(), 'closeout-strict-'))
  try {
    writeFileSync(join(dir, 'fresh.ts'), 'x')
    let code = 0
    try {
      execFileSync(process.execPath, [join(here, 'bin', 'closeout.mjs'), '--strict', '--temp', dir, '--hours', '1'], { cwd: dir, encoding: 'utf8' })
    } catch (e) {
      code = e.status
    }
    assert.equal(code, 1, '有必须处理项时 --strict 应当 exit 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------------- report */

test('buildReport：四段齐全，且不写「原会话：」行', withTmp(async (dir) => {
  const r = {
    cwd: dir,
    repos: [{ dir, branch: 'main', staged: 0, modified: 0, untracked: 0, dirty: false, ahead: 0, behind: 0, upstream: true, files: [] }],
    temp: [{ dir: join(dir, 'tmp'), files: [] }],
    hours: 12,
    sessionInfo: { id: 'session-abc', calls: 12, span: 1, last: Date.now() },
    must: [],
    glance: [],
    fine: [],
    skipped: [],
    session: null,
    handoff: { needed: false, reasons: [], exists: false, dir: join(dir, 'handoffs') },
  }
  const text = buildReport(r, { level: 'safe', blockers: 0 })
  for (const h of ['## 结论', '## 做了什么', '## 当前状态', '## 未决 / 下一步', '## 回滚点']) {
    assert.ok(text.includes(h), `缺少 ${h}`)
  }
  assert.ok(!text.includes('原会话：'), '报告不能带原会话行，否则会被 handoffs 台账当成交接件')
  assert.ok(text.includes(dir))
}))

test('findSyncScript：只探测 tools/dsh-sync.*，不调用', withTmp(async (dir) => {
  assert.equal(findSyncScript(dir), null)
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'tools', 'dsh-sync.ps1'), '# stub')
  const hit = findSyncScript(dir)
  assert.ok(hit && hit.name === 'dsh-sync.ps1')
}))

test('parseArgs：--cwd / --report / --report-out', () => {
  const o = parseArgs(['--cwd', 'D:/w', '--report', '--report-out', 'r.md'])
  assert.equal(o.cwd, 'D:/w')
  assert.equal(o.report, true)
  assert.equal(o.reportOut, 'r.md')
})

/* --------------------------------------------------------- app 口径（关闭 DSH） */

test('parseArgs：子命令 app / session；默认仍是 session（向后兼容）', () => {
  assert.equal(parseArgs([]).scope, 'session')
  assert.equal(parseArgs(['session', '--json']).scope, 'session')
  assert.equal(parseArgs(['app', '--zh']).scope, 'app')
  assert.equal(parseArgs(['app', '--recent-minutes', '5']).recentMinutes, 5)
  assert.equal(parseArgs(['app']).appName, 'DeepSeek Harness')
  assert.throws(() => parseArgs(['app', '--max-sessions', '0']), /positive/)
})

test('parseMem：tasklist 的内存列（带千分位 / 单位）', () => {
  assert.equal(parseMem('123,456 K'), 123456)
  assert.equal(parseMem('1.5 G'), Math.round(1.5 * 1048576))
  assert.equal(parseMem('2 M'), 2048)
  assert.equal(parseMem(''), null)
  assert.equal(parseMem('n/a'), null)
})

test('checkProfile：坏 JSON / 空 bundles / link 目标不存在 = 必须处理（下次起不来）', withTmp(async (dir) => {
  const p = join(dir, 'profile')
  mkdirSync(p, { recursive: true })

  writeFileSync(join(p, 'package.json'), '{ not json')
  assert.equal(checkProfile(p).must.length, 1)

  writeFileSync(join(p, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
  assert.match(checkProfile(p).must[0].text, /bundles/)

  writeFileSync(join(p, 'package.json'), JSON.stringify({
    dependencies: { a: 'link:D:/no-such-dir' },
    dsh: { profile: { bundles: ['a'] } },
  }))
  const c = checkProfile(p)
  assert.ok(c.must.some((m) => /目标不存在/.test(m.text)), `应报 link 断开：${JSON.stringify(c.must)}`)
}))

test('checkProfile：第三方可解析即通过；@deepseek-ai 内置包不落 node_modules 也不误报', withTmp(async (dir) => {
  const p = join(dir, 'profile')
  mkdirSync(join(p, 'node_modules', 'ok'), { recursive: true })
  writeFileSync(join(p, 'node_modules', 'ok', 'package.json'), '{}')
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    dependencies: { ok: '1.0.0' },
    dsh: { profile: { bundles: ['ok', '@deepseek-ai/dsh-base'] } },
  }))
  const c = checkProfile(p)
  assert.equal(c.must.length, 0, `内置包不该被要求出现在 dependencies：${JSON.stringify(c.must)}`)
  assert.ok(c.fine.some((f) => /全部可解析/.test(f.text)))
}))

test('scanSessions：60 次调用且末尾 interrupted 的会话进「顺手看一眼」', withTmp(async (dir) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function') return // Node < 22：会话这项本来整项降级
  const root = join(dir, 'sessions')
  const id = 'session-11111111-2222-3333-4444-555555555555'
  const sdir = join(root, '--x--', id)
  mkdirSync(sdir, { recursive: true })
  const now = Date.now()
  const lines = [JSON.stringify({ type: 'session', id, createdAt: now - 60000, cwd: dir, delegationDepth: 0 })]
  for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ type: 'tool/call', time: now - 50000 + i * 10 }))
  lines.push(JSON.stringify({ type: 'turn/end', time: now - 40000, data: { reason: { kind: 'interrupted' } } }))
  writeFileSync(join(sdir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n'))))

  const r = scanSessions({ sessionsDir: root, recentMinutes: 15, maxSessions: 5, minCalls: 50 })
  assert.equal(r.stats.total, 1)
  assert.equal(r.glance.filter((g) => g.id === 'app-sessions-open').length, 1, JSON.stringify(r))
  assert.equal(r.must.length, 0)
}))

test('readPendingRestart：没标记 / 标记坏了 要分开', withTmp(async (dir) => {
  assert.equal(readPendingRestart(join(dir, 'none')).found, false)
  writeFileSync(join(dir, 'pending-restart.json'), '{ broken')
  const r = readPendingRestart(dir)
  assert.equal(r.found, true)
  assert.ok(r.error, '解析失败必须暴露出来，不能当成"没有标记"')
}))

test('concludeApp：三档结论', () => {
  assert.equal(concludeApp({ must: [{}], glance: [] }).level, 'no-exit')
  assert.equal(concludeApp({ must: [], glance: [{}] }).level, 'check-first')
  assert.equal(concludeApp({ must: [], glance: [] }).level, 'safe-exit')
})

test('CLI app：--json 是合法 JSON，scope=app，结论三档之一', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'closeout-app-'))
  try {
    const out = execFileSync(process.execPath, [
      join(here, 'bin', 'closeout.mjs'), 'app', '--json',
      '--sessions-dir', join(dir, 'no-sessions'),
      '--profile', join(dir, 'no-profile'),
      '--restart-dir', join(dir, 'no-restart'),
      '--app-name', '__no_such_app__',
    ], { cwd: dir, encoding: 'utf8' })
    const j = JSON.parse(out)
    assert.equal(j.scope, 'app')
    assert.ok(['no-exit', 'check-first', 'safe-exit'].includes(j.verdict), `verdict 取值意外：${j.verdict}`)
    assert.equal(typeof j.verdictText, 'string')
    assert.ok(Array.isArray(j.must) && Array.isArray(j.skipped))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('localGates：没有 tools/ 脚本时明说没查，而不是当成通过', withTmp(async (dir) => {
  const g = localGates(dir)
  assert.equal(g.fine.length, 0)
  assert.ok(g.skipped.some((s) => /没查/.test(s.text)), JSON.stringify(g.skipped))
}))

/* ------------------------------------------------- P0：token / 重启结果 / 交接三节 */

test('parseSessionLines：累计 usage 取最大值，且不碰正文', () => {
  const lines = [
    JSON.stringify({ type: 'session', id: 'session-x', createdAt: 1000 }),
    JSON.stringify({ type: 'assistant/message', time: 2000, data: { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } }),
    JSON.stringify({ type: 'assistant/message', time: 3000, data: { usage: { inputTokens: 5000, outputTokens: 20, totalTokens: 5020 } } }),
    JSON.stringify({ type: 'assistant/message', time: 4000, data: { usage: { inputTokens: 900, outputTokens: 10, totalTokens: 910 } } }),
  ]
  const m = parseSessionLines(lines)
  assert.equal(m.lastUsage.totalTokens, 910, 'lastUsage 取最后一条')
  assert.equal(m.maxTotalTokens, 5020, 'maxTotalTokens 取最大的一条')
})

test('handoffVerdict：上下文超线才算；tokenThreshold=0 时不触发', () => {
  const meta = { calls: 10, turns: 2, lastReason: 'completed', depth: 0, parent: null, first: 0, last: 0, maxTotalTokens: 200000 }
  assert.equal(handoffVerdict(meta, { threshold: 300, minCalls: 50 }).needed, false, '默认 0 = 关闭')
  const v = handoffVerdict(meta, { threshold: 300, minCalls: 50, tokenThreshold: 150000 })
  assert.equal(v.needed, true)
  assert.match(v.reasons.join(' '), /上下文超线（200k > 150k）/)
})

test('buildHandoff：目标 / 关键文件 / 开放问题三节齐全', () => {
  const r = {
    cwd: 'D:/w', hours: 12,
    repos: [{ dir: 'D:/w', dirty: true, staged: 0, modified: 1, untracked: 0, ahead: 0, behind: 0, upstream: true, files: ['src/a.ts'] }],
    temp: [],
    sessionInfo: { id: 'session-x', calls: 10, span: 1, last: 1, title: '修登录' },
    handoff: { needed: false, reasons: [], exists: false },
    must: [], glance: [], fine: [], skipped: [],
  }
  const text = buildHandoff(r, { now: 1792448000000, task: 't' })
  for (const h of ['## 目标', '## 关键文件', '## 开放问题']) assert.ok(text.includes(h), `缺 ${h}`)
  assert.ok(text.includes('修登录'), '会话标题要进「目标」')
  assert.ok(text.includes('src/a.ts'), '未提交文件要进「关键文件」')
})

test('readRestartResult：没有 / 坏了 / 成功 三种要分开', withTmp(async (dir) => {
  assert.equal(readRestartResult(join(dir, 'none')).found, false)
  writeFileSync(join(dir, 'restart-result.json'), '{ broken')
  assert.ok(readRestartResult(dir).error, '解析失败必须暴露，不能当成"没有"')
  writeFileSync(join(dir, 'restart-result.json'), JSON.stringify({ ok: true, phase: 'relaunched', relaunchedPid: 1 }))
  assert.equal(readRestartResult(dir).rec.ok, true)
}))

test('checkProfile：断裂时 next 给出 disabled: true 的恢复路径', withTmp(async (dir) => {
  const p = join(dir, 'profile')
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    dependencies: { a: 'link:D:/no-such-dir' },
    dsh: { profile: { bundles: ['a'] } },
  }))
  const c = checkProfile(p)
  assert.match(c.must[0].next, /disabled: true/)
}))
