/**
 * 产物脱敏：处理「要落盘给人看」的文本里的秘密与机器特定路径。
 *
 * 为什么要有这一层（2026-10-29 实测）：`buildHandoff` 直接把 `repo.dir` 写进交接件，
 * 原文是 `| 仓库 D:/dsh/tmp/.../demo-repo |`；仓在用户目录下时会带 `C:/Users/<用户名>`，
 * 换台机器也读不了。此前全仓没有任何打码逻辑。
 *
 * 为什么不做进采集层：判定用**原始路径**做前缀匹配（`checks.touchedByCalls` /
 * `touchedBySession`），改写路径会让「本会话碰过没有」判错。脱敏只作用于给人看的产物。
 *
 * 幂等：重复调用不会二次变形 —— 占位符不含任何规则的形态，相对路径里也没有 root 前缀。
 */

const SECRET_KEY = String.raw`(?:api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)`
// KEY=value 里的 value：不含空白/引号/逗号/分号/反引号，至少 8 字符
const SECRET_VALUE = String.raw`[^\s"',;\x60]{8,}`

/** 秘密 → 占位符。多行私钥块先处理，避免被单行规则切开。 */
export function redactSecrets(text) {
  let s = String(text ?? '')
  s = s.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY----- <redacted> -----END PRIVATE KEY-----',
  )
  s = s.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted>')
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted>')
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted>')
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>')
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer <redacted>')
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted>')
  // 必须带赋值号，否则「token 计数」「--token-threshold」会被误伤
  s = s.replace(new RegExp(String.raw`\b(${SECRET_KEY}\s*[=:]\s*)(["']?)(${SECRET_VALUE})\2`, 'gi'), '$1$2<redacted>$2')
  return s
}

/**
 * 路径归一：工作区内 → 相对（`.` 开头）；用户目录 → `<user>`。
 * 两种斜杠都认（Windows 的 `D:\x` 与 `D:/x`），大小写不敏感。
 */
export function redactPaths(text, workspaceRoot) {
  let s = String(text ?? '')
  if (workspaceRoot) {
    const root = String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '')
    if (root) {
      const segs = root.split('/').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const esc = segs.join(String.raw`[/\\]`)
      s = s.replace(new RegExp(`(?:${esc})(?=${String.raw`[/\\]`}|$)`, 'gi'), '.')
    }
  }
  s = s.replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'\x60|)]+)/gi, '$1<user>')
  return s
}

/** 对外唯一入口：先归一路径，再打码秘密（顺序不能反）。 */
export function redact(text, opt = {}) {
  return redactSecrets(redactPaths(text, opt.workspaceRoot))
}
