# dsh-closeout

> 关掉任何东西之前先跑一遍：**哪些东西还只活在磁盘上，以及这次关闭该不该留个交接。**

一个零依赖命令行工具 + 一个技能（skill）。v0.5.0 起分成**两个口径**，先给答案再给清单：

| 子命令 | 回答的问题 | 什么时候跑 |
|---|---|---|
| `closeout`（默认，等价 `closeout session`） | **这个会话**能不能关、该不该写交接件 | 归档 / 删除一个对话之前 |
| `closeout app` | **整个 DSH** 能不能退、下次启动会不会起不来 | 退出应用 / 重启宿主之前 |

两个口径刻意不合并：会话口径答的是"这段工作落盘了没"，应用口径答的是"这个应用退得掉吗"。
混在一起会出现"关个会话却报进程内存"这种噪声。

> **本包不带任何按钮/UI**（2026-10-21 起）：输入框按钮（继续 / 收尾 / 按建议执行 / 重发上一条 + 收口面板）
> 拆到独立插件 `dsh-button`；它 spawn 本包 CLI 出结论，未安装本包时降级提示。

```bash
npx dsh-closeout --zh        # 关本会话：能不能归档/删除、该不该交接
npx dsh-closeout app --zh    # 关 DSH：能不能退、退之前确认什么
```

## 30 秒

```bash
$ closeout --zh
收口 —— 关会话之前的体检 · 会话 ba7ea134 · 401 次调用 · 跨 1 天 · 末次 2026-10-20 06:55
────────────────────────────────────────────
结论：✗ 可以归档；先别删 —— 还有 2 件东西只活在磁盘上

该不该交接：! 该写：超线（401 次 > 300）

必须处理：2
  ✗ D:\work\api → 1 已修改 / 2 未跟踪
      src/router.ts
  ✗ D:\work\tmp → 最近 12 小时写了 12 个文件
      probe.ts  4 KB   [脚本]

没查的（不等于没问题）：1
  · 本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查

只对「删除」设门槛：归档可逆，删除不可逆。
```

```bash
$ closeout app --zh
退出 —— 关闭 DSH 之前的自检
────────────────────────────────────────────
结论：! 可以退出；关之前先确认 4 件事

顺手看一眼：4
  ! 有改动待重启（config-reload，2026-10-22 00:56 ×2）—— 重启前它不会生效
  ! 最近 15 分钟有 8 个会话在写：41fa56d7（00:46）、669d9549（00:56）、…
  ! 4 个会话末尾没收口：d09eeb4d（error）、9c995298（error）、…
  ! 2 个依赖装了但不在 bundles（不会装载）：…

不用管：2
  ✓ 运行中：6 个进程（PID 28040、1972、…），合计约 1494 MB
  ✓ profile：30 个 bundle 全部可解析

没查的（不等于没问题）：2
  · 本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查
  · 后台 jobs / 终端会话 / 未回答的审批只在宿主内存里，外部读不到 —— 关之前请在 UI 里看一眼
```

## 口径一：关本会话（`closeout` / `closeout session`）

### 它查什么

| 检查 | 判据 | 落到哪 |
|---|---|---|
| 未提交改动 | `git status --porcelain`：XY 位拆暂存 / 修改 / 未跟踪 | 有改动 → **必须处理** |
| 相对上游领先 / 落后 | `git rev-list --left-right --count @{u}...HEAD` | ahead → **必须处理**；behind → 顺手看一眼；**没配上游 → 没查的**（不假装同步） |
| 临时目录里刚写出来的文件 | `mtime > now − N 小时`（默认 12），跳过 `node_modules/.git/_trash/__pycache__/.venv/dist/build/target`，按新→旧取前 12 个 | 有文件 → **必须处理** |
| 会话长度与收口状态 | 读 DSH 会话库的**事件计数与时间**：调用数 / 跨天 / `turn/end` 的 `reason.kind` / goal blocked | 只影响「该不该交接」 |
| 上下文占用 | `assistant/message` 的 `usage.totalTokens` 取最大值（只读计数，不读正文） | 给了 `--token-threshold` 且超线 → 该交接；不给只显示「上下文 280k」 |
| 交接件是否已有 | 扫 `handoffs/*.md`，开头 15 行有「非单会话收口」的跳过，只认 `原会话：session-…` 一行 | 该写而没写 → **必须处理** |
| 本机侧的门（可选） | `--local <工作区>`：`rules-lock.mjs` / `hygiene-structure.mjs` / `rules-audit.js`；脚本不存在 → 没查的 | 违规 / 有锁 → 顺手看一眼 |

**它不读什么**（刻意的）：

- ❌ **对话正文**（`data.content`）—— 只取事件类型与时间戳，跨版本不碎，也不把聊天内容带进工具；
- ❌ **atime** —— Windows 上通常被关掉，读不出"这个脚本跑过没"，所以只给 `.ps1/.sh/.py/.mjs` 标 `[脚本]`；
- ❌ **不替你提交、不删文件** —— 只给可复制的命令，动作留给你。

### 结论只有三档

| 结论 | 含义 | 依据 |
|---|---|---|
| `可以直接归档或删除` | 没有未落盘的东西，也不需要交接 | 必须处理为空且交接件已齐 |
| `可以归档；删之前先写交接件` | 归档可逆，删除不可逆 | 该交接但交接件不存在 |
| `可以归档；先别删` | 还有东西只活在磁盘上 | 脏仓 / 没推的提交 / 临时文件 |

**只对「删除」设门槛**：归档可逆，删除不可逆。

### 该不该写交接件：五条判据

抄自工作区 `tools/sessions-handoff.mjs`（有实测依据），不另立一套：

1. 调用数 > `--threshold`（默认 300）；
2. 调用数 ≥ `--min-calls`（默认 50）且末尾 `turn/end` 的 reason 不是 `completed`；
3. goal 处于 blocked；
4. 调用数 ≥ 50、跨自然日、且末尾未收口（与第 2 条去重）；
5. 上下文占用 > `--token-threshold`（**默认关闭**：模型窗口 128k / 200k / 1M 差异太大，硬编码会误报；按你模型的窗口取 50%–75%）。

子会话（`delegationDepth > 0` 或有 parent）不点名；0 调用 0 轮的会话不算。

### 交接件与收尾报告

```bash
closeout --zh --handoff --task 收尾工具          # 写 ~/.dsh/handoffs/<YYYYMMDD>-<任务名>.md
closeout --zh --handoff --task X --dry-run       # 只打印
closeout --zh --report                           # 打印四段骨架
closeout --zh --report --report-out 收尾报告.md   # 写盘
```

交接件是七节：**目标 / 做了什么 / 当前状态（可复跑验证）/ 关键文件 / 未决·下一步 / 开放问题 / 回滚点**。
工具能填的正好是「当前状态」（会话 id、次数、跨天、上下文占用、未提交的仓、临时文件清单）、
「目标」（会话标题）和「关键文件」（未提交文件清单）；「做了什么 / 未决 / 开放问题 / 回滚点」留空，因为只有会话自己知道。
默认**不覆盖**已有文件（覆盖等于丢掉别人写的东西），要覆盖加 `--force`。

收尾报告与交接件同源事实，但**不写 `原会话：` 行** —— 报告不参与 handoffs 台账，避免被下一个会话误当成交接件。

## 口径二：关 DSH（`closeout app`）

### 它查什么

| 检查 | 判据 | 落到哪 |
|---|---|---|
| 运行中的实例 | `tasklist`（Windows）/ `ps`（macOS·Linux）匹配映像名，默认 `DeepSeek Harness`；可 `--app-name` 换 | 只报 PID 与内存，**不阻止退出** |
| 待重启标记 | `~/.dsh/dsh-plugin-restart/pending-restart.json` 且 `dismissedAt === null` | 有 → 顺手看一眼（重启前改动不生效） |
| 上次重启结果 | `restart-result.json` 的 `ok / phase`（`relaunched` / `relaunched-no-window` / …） | 失败 → **必须处理**（当前实例可能半残）；成功 → 不用管 |
| 会话库整体 | 最近 `--recent-minutes`（默认 15）有写入的会话；最近 `--max-sessions`（默认 20）个解元数据找末尾未收口 | 有 → 顺手看一眼；解不开 → 没查的 |
| profile 配置完整性 | `package.json` 可解析、`dsh.profile.bundles` 非空、每个 bundle 在 `dependencies` 或 `node_modules` 里可解析、`link:`/`file:` 目标存在；`@deepseek-ai/*` 内置包（打在 app.asar 里）放行 | 断裂 → **必须处理**（下次起不来） |
| 装了没装载 | `dependencies` 里有、`bundles` 里没有 | 顺手看一眼 |
| 本机侧的门（可选） | 与 session 口径同一套 `--local` | 同 |
| 宿主内存态 | 后台 jobs / 终端会话 / 未回答的审批 | **没查的**（外部读不到） |

### 结论三档

| 结论 | 含义 | 依据 |
|---|---|---|
| `可以直接退出` | 没有要确认的事 | 必须处理与顺手看一眼都为空 |
| `可以退出；关之前先确认 N 件事` | 有运行态提醒，但不阻止退出 | 只有顺手看一眼 |
| `先别退出` | 下次启动会起不来 | 有必须处理项 |

**只拦「下次起不来」**：运行态的东西（待重启、正在写的会话、未收口的会话）只提醒 —— 退出本来就是要结束运行态。
`--handoff` / `--report` 不在这一口径产出（那是关本会话的产物），给了会打一行说明。

## 怎么触发

| 触发点 | 实际发生什么 | 口径 |
|---|---|---|
| 输入框「收尾」按钮 | 把「收尾」两字填进会话并提交，agent 按 skill 走流程 | session |
| 输入框「收口」面板 | 宿主 spawn `closeout --json --zh`（带当前会话 id + cwd），面板**只读**显示判断 | session |
| 对 agent 说「收尾 / 收口 / 关这个会话」 | skill 第 1 步跑 `closeout --zh` | session |
| 对 agent 说「准备关 DSH / 退出应用前查一下」 | skill 第 5 步跑 `closeout app --zh` | app |
| 终端 / CI | 见下方命令 | 两者 |

app 口径目前**没有按钮**：`dsh-button` 的面板把命令拼死成 `--json --zh`。要么用终端，要么对 agent 说清楚要「关 DSH」。

## 收尾流程（2026-10-21 统一口径）

**收尾** = ① 同步（可选）→ ② 体检 → ③ 交接（按需）→ ④ 报告 → ⑤ 退出 DSH（另一条线）。
旧词对照：**收口** = 体检这一步；**收工** = 同步这一步；三个词的总称统一叫「收尾」。

| 步骤 | 做什么 | 入口 |
|---|---|---|
| ① 收尾·同步 | 改一处就 commit，push 可以攒；本工具只**探测**工作区的 `tools/dsh-sync.*` 并提示，不调用 | `tools/dsh-sync.ps1 status/push` |
| ② 收尾·体检 | 未提交 / 未推 / tmp 新文件 / 该不该交接 | `closeout --zh` |
| ③ 收尾·交接 | 出交接件骨架 | `closeout --handoff --task <任务名>` |
| ④ 收尾·报告 | 四段：做了什么 / 当前状态 / 未决 / 回滚点 | `closeout --report` |
| ⑤ 退出 DSH | 待重启 / 未收口会话 / profile 完整性 | `closeout app --zh` |

## 安装

```bash
# 1) 临时用一次（零安装）
npx dsh-closeout --zh

# 2) 全局装命令
npm i -g dsh-closeout
closeout --zh

# 3) 开发时链接本地副本（junction 也能跑，见 CHANGELOG 0.2.1）
cd dsh-closeout && npm link
```

**装技能时不要把整个仓库 clone 进 `skills/`** —— 仓库根没有 `SKILL.md`，它藏在 `skills/closeout/` 下一层，
而 agent 只扫 `<skills>/<名字>/SKILL.md` 这一层。照下面做：

```bash
git clone https://github.com/xinming-chenniang/dsh-closeout /tmp/dsh-closeout
mkdir -p ~/.dsh/skills/closeout
cp /tmp/dsh-closeout/skills/closeout/SKILL.md ~/.dsh/skills/closeout/
#   Windows: mkdir %USERPROFILE%\.dsh\skills\closeout
#            copy %TEMP%\dsh-closeout\skills\closeout\SKILL.md %USERPROFILE%\.dsh\skills\closeout\
```

装成技能后，说「收尾」或「准备关这个会话」，agent 按 `SKILL.md` 走：**同步（可选）→ 体检 → 交接（按需）→ 报告 → 才允许关**；
说「准备关 DSH」则走第 5 步的 `closeout app`。

## 用法

```bash
closeout                                  # 关本会话（默认）：当前仓库，或一级子目录里的仓库
closeout session --zh                     # 显式写出口径（等价默认）
closeout --repo ../api --repo ../web      # 指定仓库（可重复）
closeout --temp ./scratch --hours 6       # 指定临时目录与"多新算新"
closeout --session <id>                   # 指定会话（默认 $DSH_SESSION_ID，其次"最近写入的那个"）
closeout --token-threshold 150000          # 上下文超 150k 也算该交接（默认 0 = 只显示不判）
closeout --cwd D:\dsh                     # 指定要检查的工作目录
closeout --local D:\dsh                   # 额外跑那个工作区自己的门
closeout --handoff --task 收尾工具         # 生成交接件骨架
closeout --report                         # 生成四段收尾报告骨架
closeout app                              # 关 DSH：运行态 / 待重启 / 会话库 / profile
closeout app --local D:\dsh --json        # 同一套本机门，机读
closeout app --profile <dir>              # 指定要校验的 profile（默认最近修改的那个）
closeout --zh | --json | --strict | --help
```

app 专属参数：`--app-name <s>` `--profile <dir>` `--restart-dir <d>` `--recent-minutes <n>` `--max-sessions <n>`。

退出码：`0` 跑完了（有必须处理项也是 0）、`1` 加了 `--strict` 且有事要处理、`2` 参数错误。

## 机器契约

### `--json`

session 口径：

```json
{
  "verdict": "no-delete",
  "verdictText": "可以归档；先别删 —— 还有 2 件东西只活在磁盘上",
  "repos": [{ "dir": "D:/work/api", "branch": "main", "staged": 0, "modified": 1, "untracked": 2,
              "dirty": true, "ahead": 0, "behind": 0, "upstream": true, "files": ["src/router.ts"] }],
  "temp":  [{ "dir": "D:/work/tmp", "files": [{ "path": "D:/work/tmp/probe.ts", "mtime": 0, "size": 3072 }] }],
  "sessionInfo": { "id": "session-…", "calls": 401, "span": 2, "guessed": false },
  "handoff": { "needed": true, "reasons": ["超线（401 次 > 300）"], "exists": false },
  "must": [{ "text": "…", "next": null }], "glance": [], "fine": ["…"], "skipped": ["…"]
}
```

app 口径（多 `scope`，没有 repo / handoff）：

```json
{
  "scope": "app",
  "verdict": "check-first",
  "verdictText": "可以退出；关之前先确认 4 件事",
  "profile": { "dir": "C:/Users/x/.dsh/profiles/desktop", "ok": true },
  "sessions": { "total": 42, "recent": 3, "open": 1, "scanned": 20 },
  "processes": [{ "name": "DeepSeek Harness.exe", "pid": 26124, "memKB": 412345 }],
  "pendingRestart": true,
  "must": [], "glance": [{ "text": "有改动待重启（config-reload，…）", "next": "确认宿主 PID 27560 后重启应用" }],
  "fine": ["profile：30 个 bundle 全部可解析"],
  "skipped": ["后台 jobs / 终端会话 / 未回答的审批只在宿主内存里，外部读不到 …"]
}
```

`skipped` 是两份输出里最重要的字段：**读不到 ≠ 没问题**。会话这项在 Node < 22 上整项跳过（没有 `zlib.zstdDecompressSync`），
跳过原因写进 `skipped`，而不是静默当作健康。

### handoffs 对账

- 单会话交接件必须在开头写 `原会话：session-…`（工具靠它对账）；
- 不是单会话收口的文件（常驻参考件 / 跨会话索引件）在开头 15 行内写 `非单会话收口`，工具跳过；
- 收尾报告不写 `原会话：` 行。

## 为什么做这个

我自己的会话里，下面几件事都真的发生过：

1. **"显式路径提交"把别人的改动一起带走了。** 我 `git add <一个文件>` 时，那个文件里另一个会话刚写的两行也在里面，于是它以我的提交信息进了历史。
2. **退出码 0 + 空输出被我当成了成功。** 一条脚本崩在中途、什么都没产出，但退出码是 0，我按"没报错"继续往下做了半小时。
3. **无 BOM 的 `.ps1` 在计划任务里静默空转。** 同一个脚本手工跑正常，由调度器跑时 exit 0、不写日志、什么也没做。
4. **会话开到第 400 次调用时，我已经不记得还有什么没做完。** 关掉之后，那些未决项只存在于已经消失的上下文里。

共同点：**都不是代码 bug，是"关掉之前没人问一句"**。前三条工具能查（磁盘事实），第四条工具查不了 ——
但它能替你判断"这个会话够长了、该写一份交接件了"，然后把骨架生成出来。

## 来源与借鉴

这个工具不是凭空长出来的。三层来源分开写清楚，免得以后被当成「全原创」：

**1. 交接件的流程与模板 —— 来自第三方**

- 来源：[`shared-handoff-dsh`](https://www.npmjs.com/package/shared-handoff-dsh)（作者 ming，仓库
  [eve1329/dsh-shared-handoff](https://github.com/eve1329/dsh-shared-handoff)，MIT）里的 `handoff` 技能。
- 借的是：证据驱动的交接、「transfer state, proof, and the next decision」，以及
  `progress` / `session-state` / `todo` / `verification` 那套状态文件布局。
- **没有借代码**：那个包只有插件入口与技能文档（`lib/index.js` + `skills/`），不含磁盘体检与判定逻辑；
  本仓库零依赖、没有 vendored 代码。

**2. 「该不该交接」的判据 —— 来自本机工作区**

- 来源：`D:\dsh\tools\sessions-handoff.mjs`（2026-10-14 建，文件头记着实测依据）与
  `D:\dsh\handoffs\README.md`。
- 借的是：阈值 300 / `--min-calls` 50、末尾未收口、跨天未收口、只有 work 事件算活跃、
  `> 已完结` 台账核对。
- `lib/session.mjs#handoffVerdict` 是这套判据的移植，**数字没有改**。那两个本机文件不在本仓库里。

**3. 本工具自己加的**

- 磁盘侧体检：脏仓 / 未跟踪 / 未推 / 临时目录里刚写出来的文件；
- 三档结论，且**只对「删除」设门槛**（归档可逆，删除不可逆）；
- `closeout app` 口径：待重启标记、profile 完整性、运行实例；
- 「只做判定，不执行交接 / 删除 / 提交 / 重启」的边界。

**怎么复核这条来源链**：`git log --reverse` 的第一个提交（2026-10-20）就是 CLI + 技能 + 文章的成品；
判据的出处在本机工作区文档里，不在本仓库历史里。第三方那层的 LICENSE 是 MIT（Copyright (c) 2026 ming）。

**想看清「现在同时存在哪些同源工具、谁该说了算」→ [docs/LINEAGE.md](docs/LINEAGE.md)；
想看「每条判据对应哪段代码、用什么命令复跑出证据」→ [docs/BEHAVIOR.md](docs/BEHAVIOR.md)。
工具自己也能回答：`closeout --explain`（数据来源 / 判定顺序 / 每条覆盖开关）。**

## 和同类工具的区别

### DSH 生态里的相邻插件

| 插件 | 它做什么 | 关系 |
|---|---|---|
| [`shared-handoff-dsh`](https://www.npmjs.com/package/shared-handoff-dsh) | `handoff` + `task-id-bootstrap` 技能；把会话导出成交接文档并接上任务状态 | **互补**：它执行交接，本工具判断"该不该交接"并出骨架 |
| [`@ericality/dsh-handoff`](https://www.npmjs.com/package/@ericality/dsh-handoff) | `/handoff`：持久化改动、存进度、出新会话续接提示 | 同类（交接），无磁盘体检 |
| `snow-The/dsh-session-handoff`、`yangyizhu8/dsh-session-handoff` | 社区 session handoff 插件（GitHub 安装，npm 无包） | 同类（交接） |
| [`dsh-session-manager`](https://www.npmjs.com/package/dsh-session-manager) | 会话删/归档/移动/tag/批量；删除不可逆且必确认 | **互补**：它执行删除/归档，本工具给"能不能关"的依据 |
| [`dsh-archived-chats`](https://www.npmjs.com/package/dsh-archived-chats) | 归档找回、工作区批量归档、搜索、回收站 | 互补：管归档后的找回，不判断该不该归档 |
| `dsh-git` | npm 0.0.1 占名、开发中；目标是 git 面板 + 阻止脏树/未推 | 最接近的竞品，**尚未发布** |
| `dsh-turnsnap` | 每轮自动 `[turnsnap]` commit | 重叠在"自动提交"，目标不同 |

### 非 DSH 的同类

| 工具 | 它做什么 | 关系 |
|---|---|---|
| [`git-leave`](https://github.com/mrnossiom/git-leave) | Rust CLI；列出脏工作区、领先上游、**没有上游的分支** | git 卫生更细（逐分支）；本工具按仓库汇总 |
| [`pendector`](https://github.com/thaim/pendector) | Rust CLI，多目录扫描 + TOML + JSON + Slack | 覆盖更广；本工具取舍是零安装、零配置 |
| 平台 stop hook（如 Claude Code `decision: block`） | 会话结束时拦一下并提醒 | 更强形态；本工具是主动跑，靠 skill 触发 |

### 定位：只做判定，不抢别人的事

**dsh-closeout = 关闭前的判定器**。它不替你交接（用 `shared-handoff-dsh` / `@ericality/dsh-handoff`）、
不替你删会话（用 `dsh-session-manager`）、不自动 commit/push（用 `dsh-sync` / `dsh-git` / `dsh-turnsnap`）、
不做归档找回（用 `dsh-archived-chats`）、不重启宿主（用 `dsh-plugin-restart`）。
它只回答两组问题：**会话能不能关、要不要交接；应用能不能退、下次起不起得来**，并给出可复跑的清单。

**它唯一不重复的部分**：临时目录里"刚写出来的文件"、会话该不该交接、关 DSH 前的待重启与 profile 完整性，
以及两侧各自的三档结论。其余（脏仓、未推送）是 git 常识 —— 如果你只需要那两条，用 `git-leave` 更合适。

## 已知边界

- **只管仓库、文件与会话元数据，不管"这段对话值不值得留"** —— 那部分写在技能里，靠人判断。
- **归档 ≠ 保存**：工具不会替你提交，它只负责在你关之前把该看的摆在面前。
- **临时文件那项默认找 `./tmp`**：大多数项目没有这个目录，于是这项经常空转。给它 `--temp` 才真的在查。
- **"写了没跑过的脚本"只做标注、不做判断**：文件系统上没有可靠判据（Windows 上 atime 通常被关掉，
  "从未被执行"读不出来）。标 `[脚本]` 让人自己确认 —— 标出来比假装查过诚实。
- **会话统计是"这个会话"，不是"这个仓库"**：换了会话 id 就是另一份账。
- **token 判据默认关闭**：`--token-threshold` 不给时只显示「上下文 xk」、不参与结论 ——
  不同模型窗口（128k / 200k / 1M）差异太大，硬编码一个值必然误报。
- **app 口径的进程归属只到映像名**：`tasklist` 不给父子关系，分不出哪些子进程是某个终端 / 后台 job 拉起的；
  那些状态只能进 UI 看。
- **profile 检查只覆盖 Node 包解析**：`link:` 目标、`node_modules`、bundles 一致性；不校验配置内容是否"合理"。
- **宿主内存态读不到**：jobs / 终端 / 未回答的审批只活在宿主进程里，CLI 从外部看不到，一律写进「没查的」。
- Windows / macOS / Linux 都可用；路径分隔符、编码都按各平台原生处理。

## 开发

```bash
node --test test/closeout.test.mjs      # 32 个用例
node bin/closeout.mjs --zh --local .
node bin/closeout.mjs app --zh          # 关 DSH 自检
```

零运行时依赖，只需 Node ≥ 18（会话那项需 ≥ 22，自动降级）。文件保持在 500 行以内，超出就拆。

## 许可

MIT。
