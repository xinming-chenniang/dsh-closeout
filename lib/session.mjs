/**
 * 会话元数据的只读读取（不碰对话正文）。
 *
 * 为什么这件事可以做：DSH 的会话库是「多个可独立解压、各自带校验和的 zstd 帧」拼接的
 * `session.jsonl.zstd`，每行一个 JSON 事件。我们要的只是**计数与时间**：
 *   - `type: 'session'`         → id / cwd / createdAt / delegationDepth（子会话）
 *   - `type: 'tool/call'`       → 调用次数
 *   - `type: 'turn/start'`      → 轮数
 *   - `type: 'turn/end'`        → `data.reason.kind`（completed / error / aborted / interrupted）
 *   - `type: 'session/end-seed'`→ 结束种子时间
 *   - `type: 'user/message'` 含 `<goal_blocked>` / `goal/*` → 目标是否 blocked
 *
 * **刻意不读 `data.content`**（对话正文）。跨版本不碎，也不把人家的聊天内容带进工具。
 *
 * 依赖：`zlib.zstdDecompressSync` 需要 Node ≥ 22。低版本不是报错，而是**整项降级**
 * （`supported: false`），其余检查照跑 —— 这条降级判据必须显式暴露，否则用户会把
 * 「读不到会话」误当成「会话没问题」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const zlib = require('node:zlib')
/** Node < 22 没有它；undefined 时整项降级，不抛。 */
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null

/** 对外暴露「会话那项能不能查」：false = 整项降级，不能当成"没问题"。 */
export const hasZstd = zstdDecompressSync !== null

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 算作「有工作」的事件类型（与 handoffs 的口径一致）。 */
const WORK_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'])

/** 会话库默认位置（跨平台：USERPROFILE → HOME）。 */
export function defaultSessionsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.dsh', 'sessions')
}

/**
 * 把一个 .jsonl.zstd 里的**所有帧**解出来。
 * 流式解压只吃第一帧（后续帧报 ZSTD_error_prefix_unknown），所以按帧魔数切分后逐帧解，
 * 解失败就与下一帧候选合并重试（作者实测口径，见工作区 tools/sessions-length.js）。
 * @param {string} file
 * @returns {string[]} 每帧解压后的文本
 */
export function decodeFrames(file) {
  const buf = readFileSync(file)
  const offs = [0]
  for (let i = 1; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  const out = []
  let i = 0
  while (i < offs.length) {
    let ok = false
    for (let j = i + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length
      try {
        out.push(zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'))
        i = j
        ok = true
        break
      } catch {
        // 试探式：单帧失败就合并下一帧重试，全部失败才算坏文件（下面 ok=false 退出）
      }
    }
    if (!ok) break
  }
  return out
}

/**
 * 列出会话库里的会话文件：`<root>/<slug>/<session-id>/session*.jsonl.zstd`。
 * 只读目录名与 mtime，不解压 —— 用来按 id 精确定位，或找「最近一个」。
 * @param {string} root
 * @returns {{id: string, slug: string, file: string, mtime: number}[]}
 */
export function listSessionFiles(root) {
  const hits = []
  let slugs = []
  try {
    slugs = readdirSync(root, { withFileTypes: true })
  } catch {
    return hits
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = join(root, slug.name)
    let ids = []
    try {
      ids = readdirSync(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue
      const idDir = join(slugDir, id.name)
      let files = []
      try {
        files = readdirSync(idDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!/^session.*\.jsonl\.zstd$/.test(f)) continue
        const p = join(idDir, f)
        let mtime = 0
        try {
          mtime = statSync(p).mtimeMs
        } catch {
          continue
        }
        hits.push({ id: id.name, slug: slug.name, file: p, mtime })
      }
    }
  }
  return hits
}

/**
 * 从已解压的行里抽元数据（与 zstd 解耦：低版本 Node 也能测这一半）。
 * @param {string[]} lines
 * @returns {object}
 */
export function parseSessionLines(lines) {
  const meta = {
    id: null, cwd: null, title: null, calls: 0, turns: 0,
    first: null, last: null, lastSeed: null, segStart: null, lastReason: null,
    depth: 0, parent: null, goalBlocked: false,
    lastUsage: null, maxTotalTokens: null,
  }
  // 「本会话」的起点 = **最早一条 `turn/start`**（这一轮开始干活的时刻）。
  // 为什么不能用 `first`：DSH 的会话文件是**续写复用**的，`session.createdAt` 可能是几天前 ——
  // 拿它当「本会话开始」，会把前几天的临时文件、跨天的判断全算进来
  // （2026-10-25 实测：一个当天只干了半小时的会话，createdAt 停在 4 天前，tmp 因此多报 422 个）。
  // 为什么也不能用 `session/end-seed`：它**不是每轮写**，只在会话中断/空闲时写
  // （2026-10-26 实测：5 轮会话只有 2 条 seed，取「最后 seed 之后」会把前面几轮全漏掉）。
  // `turn/start` 才是一轮真正开始的标记；会话文件里的轮次就是本会话的轮次（更早的历史已被裁剪）。
  // 没有 turn/start 时依次退到 lastSeed → first。
  let firstTurnStart = null
  for (const line of lines) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const d = o.data ?? {}
    if (o.type === 'session') {
      meta.id = o.id ?? meta.id
      meta.cwd = o.cwd ?? meta.cwd
      meta.parent = o.parentSession ?? meta.parent
      meta.depth = o.delegationDepth ?? meta.depth
      if (meta.first === null && typeof o.createdAt === 'number') meta.first = o.createdAt
    } else if (o.type === 'session/title') {
      if (d.title && !meta.title) meta.title = d.title
    } else if (o.type === 'tool/call') {
      meta.calls++
    } else if (o.type === 'turn/start') {
      meta.turns++
    } else if (o.type === 'turn/end') {
      meta.lastReason = d.reason?.kind ?? (typeof d.reason === 'string' ? d.reason : meta.lastReason)
    } else if (o.type === 'assistant/message' && d.usage && typeof d.usage.totalTokens === 'number') {
      // 只取计数，不碰消息正文：这是「上下文占用」的唯一稳定来源。
      meta.lastUsage = {
        inputTokens: d.usage.inputTokens ?? null,
        outputTokens: d.usage.outputTokens ?? null,
        totalTokens: d.usage.totalTokens,
      }
      if (meta.maxTotalTokens === null || d.usage.totalTokens > meta.maxTotalTokens) meta.maxTotalTokens = d.usage.totalTokens
    } else if (o.type === 'user/message' && /<goal_blocked>/.test(JSON.stringify(d))) {
      meta.goalBlocked = true
    } else if (String(o.type).startsWith('goal/')) {
      const g = d.goal ?? d
      const phase = g.phase ?? d.phase
      if (d.operation === 'block' || phase === 'blocked') meta.goalBlocked = true
      else if (d.operation === 'complete' || phase === 'complete' || d.operation === 'resume') meta.goalBlocked = false
    }
    if (typeof o.time === 'number') {
      if (WORK_TYPES.has(o.type)) {
        if (meta.first === null || o.time < meta.first) meta.first = o.time
        if (meta.last === null || o.time > meta.last) meta.last = o.time
      }
      if (o.type === 'turn/start' && (firstTurnStart === null || o.time < firstTurnStart)) {
        firstTurnStart = o.time
      }
      if (o.type === 'session/end-seed' && (meta.lastSeed === null || o.time > meta.lastSeed)) {
        meta.lastSeed = o.time
      }
    }
  }
  meta.segStart = firstTurnStart ?? meta.lastSeed ?? meta.first
  return meta
}

/**
 * 读一个会话文件，只取元数据。
 * @param {string} file
 * @returns {object|null}
 */
export function readSession(file) {
  if (zstdDecompressSync === null) return null
  let lines
  try {
    lines = decodeFrames(file).join('').split('\n')
  } catch {
    return null
  }
  return parseSessionLines(lines)
}

/** 写类工具：调用一次就说明「本会话改过这个文件」。 */
const WRITE_TOOLS = new Set(['write', 'edit'])
/**
 * pwsh 命令里出现这些，就当「可能写了文件」。
 * 刻意**不收** `>` / `>>`：`git -C <仓> status > 日志` 这种只读查询会因此被误判成"改过仓"
 * （2026-10-25 实测过这个误判），而真正的写文件基本都走 write/edit 或下面这些 cmdlet。
 */
const WRITE_CMD_RE = /Out-File|Set-Content|Add-Content|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|git\s+(?:add|commit|push|stash|reset|checkout|restore|rm|mv|apply)\b/i
/** Windows 盘符绝对路径（截到空白/引号/分隔符为止；标点后面通常不是路径的一部分）。 */
const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|;,*?]*/g

/** 路径最后一段是不是「像个文件」（有扩展名）。目录级路径不参与归属匹配 —— */
/** 命令里常带工作目录（如 `cd D:\dsh\tmp`），把它当成写路径会让整个目录都算"本会话写的"。 */
const looksLikeFile = (p) => /\.[A-Za-z0-9]{1,8}$/.test(String(p).split(/[\\/]/).pop() ?? '')

/** 把一个对象里所有字符串值摊平（scan 路径用；不打印、不落盘）。 */
function flattenStrings(o, out = []) {
  if (typeof o === 'string') out.push(o)
  else if (o && typeof o === 'object') for (const v of Object.values(o)) flattenStrings(v, out)
  return out
}

/**
 * 从会话的**工具调用参数**里收「本会话写过哪些路径」。
 *
 * 为什么需要它：收尾体检以前用时间窗判断「这个仓/这些临时文件是不是这个会话弄的」，
 * 但同一时段往往还开着别的会话 —— 时间窗分不出谁是谁（用户 2026-10-25 报的
 * 「提醒与本会话无关的仓的未提交/未推」）。工具调用参数里带的是**这个会话自己的**
 * 文件路径，才是真正的归属证据。
 *
 * 隐私边界：只读 `tool/call.data.arguments`（工具参数），**不读对话正文**；
 * 返回的是路径集合，只在内存里做匹配，不进任何输出、不落盘。
 * 读不到（老格式 / 非 zstd / 无参数）时 `ok:false`，调用方应退回时间窗并保守上报。
 * @param {string} file
 * @returns {{ok: boolean, writes: Set<string>}}
 */
export function collectCallRefs(file) {
  const writes = new Set()
  if (zstdDecompressSync === null) return { ok: false, writes }
  let text
  try {
    text = decodeFrames(file).join('')
  } catch {
    return { ok: false, writes }
  }
  let sawToolCall = false
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type !== 'tool/call') continue
    sawToolCall = true
    const name = String(o.data?.name ?? '')
    const rawArgs = o.data?.arguments
    if (typeof rawArgs !== 'string') continue
    const isWrite = WRITE_TOOLS.has(name) || (name === 'pwsh' && WRITE_CMD_RE.test(rawArgs))
    if (!isWrite) continue
    let parsed = null
    try {
      parsed = JSON.parse(rawArgs)
    } catch {
      // 试探式：参数不是 JSON 时退化成纯文本扫描（下面那步照样能收路径）
    }
    // write/edit 的 file_path 是明确的文件（可能是相对 cwd 的路径，调用方负责 resolve）
    for (const key of ['file_path', 'path', 'filePath']) {
      const v = parsed?.[key]
      if (typeof v === 'string' && v.trim()) writes.add(v.trim())
    }
    // 命令文本里的绝对路径：**必须用解析后的字符串**（单反斜杠）。
    // 直接在 rawArgs（JSON 源）上扫会拿到 `D:\\dsh\\tmp`（双反斜杠），
    // resolve 后变成 `D:\dsh\tmp`，于是整个 tmp 都被判成「本会话写的」（2026-10-25 实测）。
    const texts = parsed === null ? [rawArgs] : flattenStrings(parsed)
    for (const t of texts) {
      for (const m of t.matchAll(ABS_PATH_RE)) {
        const p = m[0].replace(/[.。]+$/, '') // 句末的句号不是路径的一部分
        if (looksLikeFile(p)) writes.add(p)
      }
    }
  }
  return { ok: sawToolCall, writes }
}

/**
 * 按 id 找会话；id 为 'last' 时取 mtime 最新的那个（**推测**，调用方要在输出里标注）。
 * @param {string} root
 * @param {string} id
 * @returns {{entry: object|null, guessed: boolean, supported: boolean}}
 */
export function locateSession(root, id) {
  if (zstdDecompressSync === null) return { entry: null, guessed: false, supported: false }
  const files = listSessionFiles(root)
  if (files.length === 0) return { entry: null, guessed: false, supported: true }
  if (!id || id === 'last') {
    const sorted = files.slice().sort((a, b) => b.mtime - a.mtime)
    return { entry: sorted[0] ?? null, guessed: true, supported: true }
  }
  const exact = files.find((f) => f.id === id) ?? files.find((f) => f.id.endsWith(id)) ?? null
  return { entry: exact, guessed: false, supported: true }
}

/**
 * 读交接件台账：每份单会话交接件必须在开头写 `原会话：session-...`；
 * 开头 15 行内写 `非单会话收口` 的（常驻参考件 / 跨会话索引件）跳过。
 * @param {string} dir
 * @returns {{ids: Set<string>, files: {name: string, ids: string[], statusName: string|null, hasStatusLine: boolean, hasUpdated: boolean, hasCriteria: boolean}[], dir: string}}
 */
export function readHandoffs(dir) {
  const ids = new Set()
  const files = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { ids, files, dir }
  }
  const ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  for (const e of entries) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue
    let text = ''
    try {
      text = readFileSync(join(dir, e.name), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    const head = lines.slice(0, 15).join('\n')
    if (/非单会话收口/.test(head)) continue
    const hits = []
    for (const line of lines) {
      if (!/原会话/.test(line)) continue
      for (const m of line.matchAll(ID_RE)) hits.push(m[0])
    }
    for (const id of hits) ids.add(id)
    // 台账格式（2026-11-09 加）：文件名状态段 + 件首三行块（`handoffs/README.md` ③-3）。
    // 只写正文行内状态的件会被旧兜底读成"已完成"，账面分不出完成没 —— 上层据此在收尾体检里点名。
    const head40 = lines.slice(0, 40).join('\n')
    const statusName = (e.name.match(/[（(](进行中|已完成|已废弃|参考)[）)]/) ?? [])[1] ?? null
    files.push({
      name: e.name,
      ids: hits,
      statusName,
      hasStatusLine: /^>\s*(?:\*\*)?状态(?:\*\*)?[：:]/m.test(head40),
      hasUpdated: /^>\s*(?:\*\*)?更新(?:\*\*)?[：:]/m.test(head40),
      hasCriteria: /^>\s*(?:\*\*)?完成判据(?:\*\*)?[：:]/m.test(head40),
    })
  }
  return { ids, files, dir }
}

/**
 * 会话是否「该写交接件」——判据抄自工作区 `tools/sessions-handoff.mjs`（有实测依据），不另立一套：
 *   超线（calls > threshold）/ 末尾未收口（turn/end 的 reason 不是 completed）/ goal blocked /
 *   跨天且未完成收口。子会话不点名。
 * @param {object} meta readSession 的结果
 * @param {{threshold: number, minCalls: number, days: number}} opts
 * @returns {{needed: boolean, reasons: string[]}}
 */
export function handoffVerdict(meta, opts) {
  const reasons = []
  if (!meta) return { needed: false, reasons }
  const { threshold = 300, minCalls = 50, tokenThreshold = 0 } = opts
  if (meta.calls > threshold) reasons.push(`超线（${meta.calls} 次 > ${threshold}）`)
  // 上下文占用：默认关闭（模型窗口 128k / 200k / 1M 差异太大，硬编码会误报）。
  // 给了 --token-threshold 才判；maxTotalTokens 取会话里最大的一次请求。
  if (tokenThreshold > 0 && typeof meta.maxTotalTokens === 'number' && meta.maxTotalTokens > tokenThreshold) {
    reasons.push(`上下文超线（${Math.round(meta.maxTotalTokens / 1000)}k > ${Math.round(tokenThreshold / 1000)}k）`)
  }
  const longEnough = meta.calls >= minCalls
  if (longEnough && meta.lastReason && meta.lastReason !== 'completed') reasons.push(`末尾未收口（${meta.lastReason}）`)
  if (meta.goalBlocked) reasons.push('goal blocked')
  // 「跨天未收口」看的是**本段**跨没跨自然日，不是会话文件活了多少天 ——
  // resume 过的会话 `first` 停在创建那天，拿它比会把每个续写会话都报成跨天。
  const segFirst = typeof meta.segStart === 'number' ? meta.segStart : meta.first
  if (longEnough && segFirst && meta.last && dayKey(meta.last) !== dayKey(segFirst) && meta.lastReason !== 'completed') {
    reasons.push('跨天未收口')
  }
  const isChild = (meta.depth ?? 0) > 0 || meta.parent !== null
  const deduped = reasons.filter((x) => !(x === '跨天未收口' && reasons.some((y) => y.startsWith('末尾未收口'))))
  return { needed: deduped.length > 0 && !isChild && !(meta.calls === 0 && meta.turns === 0), reasons: deduped }
}

/** 本地日历日的键（不用 UTC，否则跨小时会错天）。 */
export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 会话跨越的自然日数（向上取整，同一天记 1）。 */
export function daysSpan(first, last) {
  // 不能用 `!first` 判空：时间戳 0 是合法值，falsy 判断会把它当成「没有」。
  if (typeof first !== 'number' || typeof last !== 'number') return 1
  return Math.max(1, Math.ceil((last - first) / 86400000))
}
