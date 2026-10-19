import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, parsePorcelain, listRecentFiles, collect, render } from '../bin/closeout.mjs'

const TEXT = {
  title: 'T', repos: 'R', repo: 'r', branch: 'b', staged: 's', modified: 'm', untracked: 'u',
  ahead: 'a', behind: 'be', clean: 'clean', noRepos: 'norepos', temp: 'temp', noTemp: 'notemp',
  warning: 'warn', ok: 'ok', next: 'next', nextDirty: 'd', nextTemp: 't', nextClean: 'c',
  summary: 'sum', none: '-',
}

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

test('listRecentFiles：只收"够新"的，且跳过 node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-'))
  try {
    const fresh = join(dir, 'fresh.txt')
    const old = join(dir, 'old.txt')
    writeFileSync(fresh, 'x')
    writeFileSync(old, 'y')
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    utimesSync(old, longAgo, longAgo)
    const hits = listRecentFiles(dir, Date.now() - 12 * 3600 * 1000)
    assert.deepEqual(hits.map((h) => h.path.split(/[\\/]/).pop()), ['fresh.txt'])

    const nm = join(dir, 'node_modules')
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(nm)})`])
    writeFileSync(join(nm, 'dep.js'), 'z')
    assert.equal(listRecentFiles(dir, 0).filter((h) => h.path.includes('node_modules')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collect：没有仓库、没有临时目录时，警告为 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-empty-'))
  try {
    const r = collect({ repos: [], temp: [], hours: 12 }, dir)
    assert.deepEqual(r.repos, [])
    assert.deepEqual(r.temp, [])
    assert.deepEqual(r.warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('render：有警告时汇报条数并给出下一步', () => {
  const out = render({
    repos: [{ dir: 'D:/x/repo', branch: 'main', staged: 1, modified: 0, untracked: 2, ahead: 1, behind: 0, dirty: true, files: ['a.txt'] }],
    temp: [],
    warnings: ['w1', 'w2'],
    hours: 12,
  }, TEXT)
  assert.match(out, /2 warn/)
  assert.match(out, /a.txt/)
  assert.match(out, /d/) // nextDirty 文案出现
})

test('CLI 直接跑：退出码 0，输出是合法 JSON（无 git 环境也不崩）', () => {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const out = execFileSync(process.execPath, ['bin/closeout.mjs', '--json'], { cwd: here, encoding: 'utf8' })
  const j = JSON.parse(out)
  assert.ok(Array.isArray(j.repos))
  assert.ok(Array.isArray(j.warnings))
})

test('parseArgs：未知参数报错，--hours 必须是正数', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--hours', '0']), /positive/)
  assert.throws(() => parseArgs(['--repo']), /missing value/)
  assert.deepEqual(parseArgs(['--repo', 'a', '--repo', 'b', '--zh']).repos, ['a', 'b'])
})
