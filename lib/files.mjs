/**
 * 文件侧的事实采集（只读）。
 *
 * 这里修过两版语义坑：
 *   1. 旧实现「遇到第 N 个新文件就 return」，返回的是**目录遍历序**的前 N 个，
 *      而不是**最新的** N 个 —— 临时目录里文件一多，真正刚写出来的那几个根本不会出现。
 *      现在：先收集（有总上限，避免扫爆），最后按 mtime 降序取前 `limit` 个。
 *   2. 扫描上限曾是 20000 个文件，而本机 `tmp\` 有 9 万+ —— 扫到上限就停，
 *      排在后面的任务目录整个不会被看到（2026-10-25 实测：本会话刚写的探针目录
 *      被判成「没有新文件」）。上限提到 300000，并跳过 `_` 前缀目录（tmp 的隔离/备份区约定）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 依赖、缓存、隔离区：一律不进「最近写出来的文件」清单。 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '_trash', '__pycache__', '.venv', 'dist', 'build', 'target'])

/**
 * 递归列出 dir 下 mtime 晚于 sinceMs 的文件，按新 → 旧排序取前 limit 个。
 * @param {string} dir
 * @param {number} sinceMs
 * @param {number} [limit]
 * @param {{maxDepth?: number, maxScan?: number}} [opt]
 * @returns {{path: string, mtime: number, size: number}[]}
 */
export function listRecentFiles(dir, sinceMs, limit = 12, opt = {}) {
  return collectRecentFiles(dir, sinceMs, opt).slice(0, limit)
}

/**
 * 时间窗内文件**总数**。
 * 为什么要单独一个：`listRecentFiles` 默认只返回最新 12 个，拿它的 `length` 当计数会把
 * 「51 个」说成「12 个」（2026-10-25 实测）—— 假精确比不给数更糟：人会照这个数决定要不要处理。
 * @param {string} dir
 * @param {number} sinceMs
 * @param {{maxDepth?: number, maxScan?: number}} [opt]
 * @returns {number}
 */
export function countRecentFiles(dir, sinceMs, opt = {}) {
  return collectRecentFiles(dir, sinceMs, opt).length
}

/**
 * 收集（不截断）时间窗内的文件，按新 → 旧排序。
 * @param {string} dir
 * @param {number} sinceMs
 * @param {{maxDepth?: number, maxScan?: number}} opt
 * @returns {{path: string, mtime: number, size: number}[]}
 */
function collectRecentFiles(dir, sinceMs, opt = {}) {
  const maxDepth = opt.maxDepth ?? 6
  const maxScan = opt.maxScan ?? 300000
  const hits = []
  let scanned = 0
  const walk = (d, depth) => {
    if (depth > maxDepth || scanned >= maxScan) return
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      // 试探式：无权限/已删除的目录跳过即可，不值得让整个检查失败
      return
    }
    for (const e of entries) {
      if (scanned >= maxScan) return
      if (e.isDirectory()) {
        // `_` 前缀 = 隔离/备份区约定（tmp\_trash、_backup-* 等），扫它只会拖慢并把历史算进来
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('_')) continue
        walk(join(d, e.name), depth + 1)
      } else if (e.isFile()) {
        scanned++
        let st
        try {
          st = statSync(join(d, e.name))
        } catch {
          continue
        }
        if (st.mtimeMs >= sinceMs) hits.push({ path: join(d, e.name), mtime: st.mtimeMs, size: st.size })
      }
    }
  }
  walk(dir, 0)
  return hits.sort((a, b) => b.mtime - a.mtime)
}
