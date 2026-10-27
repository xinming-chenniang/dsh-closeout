/**
 * 工作区契约探测（v0.7）。
 *
 * 为什么要有这一层：同一个技能、同一句「收尾」，在不同工作区该产出不同的东西。
 * v0.6 之前，产物形态（交接件 / 报告）由**命令行开关**决定，落点由**调用时的 cwd**决定 ——
 * 于是同一件事在 D:\dsh 落到 `tmp\<任务>\`、在个人项目落到项目目录、在手写路径时落到家目录。
 * 那不是规则，是运气。
 *
 * 这一层的判据只有一条：**产物形态与落点由工作区自己的结构决定，技能只探测 + 允许显式覆盖。**
 *
 *   工作区根（向上找到的第一处含 `handoffs/` 或 `AGENTS.md` / `.git` 的目录）
 *   ├─ 有 `handoffs/`                    → 形态 = 交接件；落点 = 该目录
 *   └─ 没有                              → 形态 = 报告（不是台账，别混进台账）；
 *                                          落点 = 显式 --report-out（相对路径解析到工作区根）
 *
 * 工作区根往上找不到任何标记（外部用户随便一个目录）时，根 = cwd，行为与 v0.6 一致。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'

/** 台账目录名。存在即视为「这个工作区用交接件」。 */
export const LEDGER_DIRNAME = 'handoffs'

/** 工作区标记：没有台账时，用它们确定工作区根（落点相对路径的基准）。 */
const MARKERS = ['AGENTS.md', '.git']

/**
 * 向上找工作区根。**台账优先**：先遇到 `handoffs/` 的目录就是根，不再往上；
 * 否则记下第一个带 AGENTS.md / .git 的目录，走到盘根为止。
 *
 * @param {string} cwd
 * @returns {{root: string, reason: string, ledger: string|null}}
 */
export function findWorkspaceRoot(cwd) {
  const start = resolve(cwd)
  const stop = parse(start).root
  let dir = start
  let firstMarker = null
  for (;;) {
    if (existsSync(join(dir, LEDGER_DIRNAME))) {
      return { root: dir, reason: `有 ${LEDGER_DIRNAME}/`, ledger: join(dir, LEDGER_DIRNAME) }
    }
    if (!firstMarker && MARKERS.some((m) => existsSync(join(dir, m)))) firstMarker = dir
    const parent = dirname(dir)
    if (parent === dir || dir === stop) break
    dir = parent
  }
  if (firstMarker) return { root: firstMarker, reason: '有 AGENTS.md 或 .git', ledger: null }
  return { root: start, reason: '向上没有找到工作区标记', ledger: null }
}

/**
 * 产物形态。**一个工作区只产出一份**：有台账就交接件，没台账就报告 ——
 * 这样「一个技能产出两份文档」在多工作区下不会出现。
 *
 * @param {{root: string, ledger: string|null}} ws findWorkspaceRoot 的返回
 * @returns {'handoff'|'report'}
 */
export function decideShape(ws) {
  return ws.ledger ? 'handoff' : 'report'
}

/** 目录名安全的短串（工作区名当子目录名用）。 */
export function safeDirName(s) {
  const t = String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return t || 'workspace'
}

/** 工作区路径的短哈希：同名工作区（都叫 workspace）撞车时用来区分。 */
function shortHash(p) {
  return createHash('sha1').update(resolve(p)).digest('hex').slice(0, 8)
}

/**
 * 台账目录。
 *
 * 优先级：显式 `--handoffs` → 工作区自己的 `handoffs/` → `~/.dsh/handoffs/<工作区名>/`。
 * 最后那一档是给「没有台账但确实要交接」的外部项目用的：**按工作区分目录**，
 * 不把 A 项目的交接件倒进 B 项目的台账（v0.6 的全局单目录在多工作区下就是这个问题）。
 *
 * 只读：不创建目录（体检承诺不写盘），目录由 writeHandoff 建。
 *
 * @param {{workspaceRoot: string, cwd: string, explicit?: string|null}} o
 * @returns {string}
 */
export function resolveLedgerDir(o) {
  if (o.explicit) return resolve(o.cwd, o.explicit)
  const local = join(o.workspaceRoot, LEDGER_DIRNAME)
  if (existsSync(local)) return local

  const base = join(homedir(), '.dsh', 'handoffs')
  const plain = join(base, safeDirName(basename(o.workspaceRoot)))
  if (!existsSync(base) || !existsSync(plain)) return plain

  // 同名目录已存在：认 `.workspace` 戳。没有戳（旧版本留下的）也走哈希分支 ——
  // 宁可多一个目录，也不要把两个项目的历史混在一起。
  const stamp = join(plain, '.workspace')
  if (existsSync(stamp)) {
    try {
      if (resolve(readFileSync(stamp, 'utf8').trim()) === resolve(o.workspaceRoot)) return plain
    } catch {
      // 试探式读取：戳坏了就按"不是同一个工作区"处理，下面走哈希分支。
    }
  }
  return join(base, `${safeDirName(basename(o.workspaceRoot))}-${shortHash(o.workspaceRoot)}`)
}

/** 给全局台账子目录写归属戳（只有真的写文件时才调用，体检路径不碰）。 */
export function writeLedgerStamp(dir, workspaceRoot) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.workspace'), resolve(workspaceRoot) + '\n', 'utf8')
    return true
  } catch {
    // 试探式：写不了戳不影响交接件本身；下次落点会退回哈希目录（可接受）。
    return false
  }
}

/**
 * 报告落点。相对路径解析到**工作区根**，不是 cwd ——
 * v0.6 用 `resolve(cwd0, ...)`：在 `tmp\<任务>\` 里收尾，报告就落在那个一次性目录里。
 *
 * @param {string} out 用户给的路径
 * @param {{workspaceRoot: string}} o
 * @returns {string} 绝对路径
 */
export function resolveArtifactOut(out, o) {
  return resolve(o.workspaceRoot, String(out))
}
