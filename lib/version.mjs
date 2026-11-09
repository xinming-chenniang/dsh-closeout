/**
 * 工具版本号。
 *
 * 为什么单独一个模块：生成的交接件 / 报告里要写真实版本 —— 2026-11-09 实测，0.7.0 生成的文件
 * 还写着 `v0.6`（两处硬编码），交接件开头那句"哪个版本的 closeout 产的"就不可信了。
 * 读不到 package.json 时返回 `unknown`（包被拆开单独发布时）：显示不对，但不阻断生成。
 */
import { readFileSync } from 'node:fs'

export function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}
