/**
 * 文件侧的事实采集（只读）。
 *
 * 这里修过一版语义坑：旧实现「遇到第 N 个新文件就 return」，于是返回的是**目录遍历序**的前 N 个，
 * 而不是**最新的** N 个 —— 临时目录里文件一多，真正刚写出来的那几个根本不会出现在输出里。
 * 现在：先收集（有总上限，避免扫爆），最后按 mtime 降序取前 `limit` 个。
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
  const maxDepth = opt.maxDepth ?? 6
  const maxScan = opt.maxScan ?? 20000
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
        if (SKIP_DIRS.has(e.name)) continue
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
  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}
