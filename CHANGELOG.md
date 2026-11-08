# 变更记录

版本语义：0.x 阶段允许 breaking，但**每次都写在这里**。

## 未发布

### 修复（2026-11-09：测试会把假工作区写进真实的 `~/.dsh/handoffs`）

2026-11-09 查「dsh-closeout 与 shared-handoff-dsh 是否重复」时顺带发现：`~/.dsh/handoffs`
根上有 **16 个** `workspace*` 目录，每个的 `.workspace` 归属戳都指向
`%TEMP%\closeout-xxxx\one\workspace` —— 全是测试残留，不是真台账。

根因：`writeLedgerStamp` 的用例（`test/closeout.test.mjs`）拿临时目录当假工作区，却没隔离
`os.homedir()`。`resolveLedgerDir` 在工作区没有本地 `handoffs/` 时会兜底到
`~/.dsh/handoffs/<工作区名>/`，同名不同路径还要按 `(工作区名, 工作区路径)` 哈希分目录 ——
路径里含随机 temp 名，于是**每跑一次 `npm test` 净增 1 个目录，只增不减**。

改法：`withTmp` 把 `HOME` / `USERPROFILE` 指到测试自己的临时 home（`finally` 里还原并删除），
并加两条断言钉住「全局兜底目录与台账归属戳必须落在临时 home 里」。**生产代码零改动**。

验证：`npm test` → 59 pass / 0 fail，跑前跑后 `~/.dsh/handoffs` 目录数都是 **0**。
反例：把本次改动退回再跑 → 目录数变成 **1**（`workspace`），与当初那 16 个同源。

### 变更（2026-10-28：产物形态与落点按**工作区**决定，不再由 cwd 决定）

起因：用户问「closeout 为什么把收尾报告写进 tmp，有会话回去看吗」。查下来是两件事叠在一起：

- **一个技能产出两份文档**：交接件（七节）与收尾报告（六节）有四节同源，报告独有的「结论」「收尾·同步」
  都能用一条命令重打 —— 而报告不必写 `原会话：`、不进台账，于是它成了"写完没人认"的那一份。
  本机实测：`tmp\` 里 12 份收尾报告，`handoffs/` / `outcomes/` / 工作日志里 **0 处引用**。
- **落点由 cwd 决定**：`--report-out` 用 `resolve(cwd0, ...)`，在 `tmp\<任务>\` 里收尾就落进那个一次性目录。

改法（v0.7，向后兼容）：

- 新增 `lib/workspace.mjs`：向上找工作区根（有 `handoffs/` 的那层优先，其次最近的 `AGENTS.md` / `.git`）。
- **形态决议**：有台账 → 交接件；没有台账 → 报告。一个工作区只产出一份。
- **落点决议**：`--report-out` 相对路径解析到**工作区根**（不再 cwd）；`--handoffs` 默认
  工作区 `handoffs/`，没有则 `~/.dsh/handoffs/<工作区名>/`（同名工作区靠 `.workspace` 归属戳区分）。
- `--handoff` / `--report` 仍是显式覆盖；两个都不给仍然不写任何文件。
- 写报告时自动建父目录；写失败把路径与原因打出来（不再抛栈、也不留"写成功"的错觉）。

兼容性：`--handoffs` 的默认值变了（原来是全局 `~/.dsh/handoffs`）。显式传 `--handoffs` 的工作区不受影响；
本机 `D:\dsh` 有自己的 `handoffs/`，解析结果与原来相同。

### 修复（2026-10-25：临时文件窗口改用「本段会话」，不再固定 12 小时）

用户报的现象：「收尾体检怎么还是会提醒**本会话外**的遗留」—— 一次只干了半小时的会话，
`tmp` 被报「422 个新条目」，其中 421 个是前四天别的会话写的。

两个根因，都实测过：
- **会话窗起点取错**：`session.first` 是会话文件**创建**时间。DSH 的会话是续写复用的
  （resume 同一个 id 与文件），实测一个当天 22:55 开跑的会话 `createdAt` 停在 4 天前。
  拿它当「本会话开始」，窗口就横跨 4 天。→ 新增 `segStart` = 最后一次
  `session/end-seed`（上一段落盘点）之后的**第一条工作事件**；`handoffVerdict` 的
  「跨天未收口」也改按本段算，续写会话不再被误判跨天。
- **计数被明细截断**：`listRecentFiles` 默认只回最新 12 个，拿它的 `length` 当计数，
  会把 51 个说成 12 个（假精确）。→ 新增 `countRecentFiles`，`temp-files` 文案报真实总数，
  并注明「明细只列最新 12 个」。
- 临时文件窗口默认改为「本段会话起点」（含并发会话）；**显式 `--hours N` 仍强制固定小时窗**
  （自动化与旧调用不受影响）。
- 本机 `tools/sessions-closeout.mjs` 第 5/7 项同步改用 `sessionInfo.segStart`，
  文案改为「本段会话窗（含并发会话）」。

### 修复（2026-10-25 二：按「本会话自己的工具调用」判归属，不再报别处的遗留）

用户接着报的是另一层：「它会提醒与本会话无关的**仓**的未提交/未推」。
时间窗做不到——同一时段往往还开着别的会话（本机实测同时有 4 个），
`dsh-worklog` 的 3 个未推提交是当天凌晨 03:01–07:44 的，`dsh-kb-sync` / `skills-src` /
`health-facts` 的未提交文件是早上 06:48–06:59 的，全都早于本段会话 22:55。

- **归属证据换成工具调用参数**：新增 `session.mjs#collectCallRefs`，只读
  `tool/call.data.arguments`（**不读对话正文**），收「本会话写过哪些路径」：
  `write`/`edit` 的 `file_path`，以及 `pwsh` 命令里带写操作 cmdlet（`Out-File` /
  `Set-Content` / `New-Item` / `Copy-Item` / `git add|commit|push|…`）时的绝对路径。
  刻意不收 `>` / `>>`：`git -C <仓> status > 日志` 这种只读查询会被误判成"改过仓"。
- **匹配是单向的**：只看「这个路径在仓里」，不看「仓在这个路径里」——
  命令里几乎都带工作目录 `D:\dsh`，双向比较会把 `D:\dsh\dsh-worklog` 判成碰过（实测踩过）。
- 仓库判定：本会话的工具调用碰过 → 脏/未推进「必须处理」；没碰过 →
  进「不用管」并写明「本会话没碰过（之前留下的，不计入）」，不计入 blocker。
- 临时目录同样按此分流：「本会话写的」才进必须处理，同窗口别的会话写的
  明说个数、不计入。
- **显式 `--hours N` = 原始窗口模式**：不做归属过滤（自动化/冒烟测试靠这个行为）。
- 顺带修掉一个**漏扫**：`listRecentFiles` 的扫描上限是 20000 个文件，而本机 `tmp\`
  有 92491 个 —— 扫到上限就停，排在后面的任务目录整个看不见（本会话刚写的探针目录
  因此被判成「没有新文件」，实测 14 个 vs 真实 2032 个）。上限提到 300000，
  并跳过 `_` 前缀目录（tmp 的隔离/备份区约定）。
- 本机 `tools/sessions-closeout.mjs` 的仓清单改为显式 `--repo` 交给 closeout，
  第 3/5 项直接用它的归属结论。

### 修复（2026-10-26：技能审阅时发现的三处，含 `segStart` 取法修正）

审阅 `skills/closeout/SKILL.md` 时把实现和文档逐条对了一遍，修掉三处：

- **`segStart` 取法错了**：原来取「最后一次 `session/end-seed` 之后的第一条工作事件」，
  但 `end-seed` **不是每轮写** —— 2026-10-26 实测一个 5 轮的会话只有 2 条（会话中断/空闲时才写）。
  于是多轮会话的窗口只覆盖最后一轮，前面几轮本会话写的临时文件全漏报。
  改为**最早一条 `turn/start`**（没有则退 `lastSeed` → 创建时间）。跨天判据同此口径。
- **交接件 / 报告里的「当前状态」表**：临时目录那行还在用旧口径
  （`最近 N 小时` + `t.files.length`），既没跟上归属判定，又把「明细前 12 个」当总数。
  改为「本会话写了 N 个文件（同窗口另有 M 个别的会话写的）」，复核命令给 `--json`。
- **技能 `skills/closeout/SKILL.md` 重写**（审阅后）：示例输出换新格式（三档结论 + 四组清单）、
  交接件模板改七节、报告改六节、补归属判定与「不计入的不用处理」、参数表与退出码、
  交接件目录按工作区规定（别写 `./handoffs`）、补「有工作区收尾脚本优先用它」。

### 加

- **`--explain`**：工具自述（数据来源 / 判定顺序 / 每条覆盖开关 / 它故意不做什么）。
  默认值直接取自 `parseArgs`，所以改了默认值却忘了改说明会被输出暴露。

### 变更（收口方案 A：判据收权）

- 本机 `sessions-closeout.mjs` 第 1 项改为调用本包（`--json --zh --handoffs`），不再自行计算阈值；
  `sessions-length.js` / `sessions-handoff.mjs` 降级为存量盘点（文件头已标注）。
- `D:\dsh\AGENTS.md` 与 `handoffs\README.md` 的阈值改为指向 `closeout --explain`；旧文件留 `*.bak-20261024-a`。

### 文档

- `README.en.md` / `docs/BEHAVIOR.md` / `--explain` 的窗口口径同步为「最早 turn/start」。
- 技能目录里两个历史备份（`SKILL.md.bak-20261022*`）移出到 `tmp\_trash`，技能目录只留 `SKILL.md`。
- 新增 `docs/BEHAVIOR.md`（判据 → 代码 → 复跑命令 → 期望输出）与 `docs/LINEAGE.md`
  （5 个同源工具的职责、决策归属、冗余审计、三选一的收口方案）。
- 补「来源与借鉴」：交接流程与模板来自 `shared-handoff-dsh`（作者 ming，MIT），
  「该不该交接」的判据来自本机 `tools/sessions-handoff.mjs`；磁盘体检、三档结论、`closeout app` 为本项目新增。
  README / README.en / ARTICLE 同步。
- `.gitignore` 忽略 `*.tgz`（npm pack 产物；发布物以 registry 为准，本地留一份对照即可）。

## 0.6.0 — 2026-10-22

### 加（P0 五条，来自插件市场与本机相邻插件）

- **上下文占用判据**：`--token-threshold <n>` 给了才启用（默认 0 = 只显示不判）。
  数据来自会话事件 `assistant/message.data.usage.totalTokens` 的最大值，**只读计数，不读正文**。
  会话行会显示「上下文 280k」。实测本会话 280k / 阈值 150k 时正确触发「该交接」。
- **上次重启结果**：`closeout app` 读 `dsh-plugin-restart/restart-result.json`。
  `ok:true + phase:relaunched` → 不用管；其余（含 `relaunched-no-window`）→ **必须处理**，指向 `restart.log`。
- **交接件补三节**：`--handoff` 骨架从四节变七节 —— **目标**（自动填会话标题）、
  **关键文件**（自动填未提交清单前 10 个）、**开放问题**（留空）。
- **启动失败恢复路径**：profile 断裂时，`next` 除 `pnpm install` 还给出
  「在 `cordis.patch.yml` 里给坏 bundle 加 `disabled: true`，先启动再修」。
- **skill 第 0.7 步**：超线先问一句；拒绝后触发线再涨 50% 才第二次问（拒绝冷却）。

### 变更

- `--report` 的判据行同步带上下文占用；交接件/报告的版本号从 v0.2 / v0.3 统一为 v0.6。
- 测试 32 → 37（新增 token、重启结果、交接三节、恢复路径四组用例）。

## 0.5.0 — 2026-10-22

### 加（拆成两个子功能，同一个 CLI 两个口径）

- **`closeout [session]`** —— **关本会话**的自检（默认，行为与 0.4.0 完全一致）：
  会话元数据 → 交接判定 → 该目录的仓库 / 临时文件 / 交接件；`--handoff` / `--report` 仍在这里产出。
- **`closeout app`** —— **关 DSH 本身**的自检：这台机器现在能不能退、退之前有什么只活在运行态里、
  下次启动会不会起不来。查四项外部事实：
  1. 运行中的实例（进程数与内存；只读，不杀）；
  2. 待重启标记（`dsh-plugin-restart/pending-restart.json`，有 = 改了配置但还没生效）；
  3. 会话库整体（最近还在写的会话 / 末尾没收口的会话）；
  4. profile 配置完整性（bundles 是否可解析、link 目标是否存在 —— 断了就是"重启起不来"）。
- app 口径的结论三档：`先别退出`（有必须处理项）/ `可以退出；关之前先确认 N 件事`（只有顺手看一眼）/ `可以直接退出`。
- 新参数：`--app-name` `--profile` `--restart-dir` `--recent-minutes` `--max-sessions`。

### 变更

- 本机侧的门抽成 `localGates()`，session / app 两个口径共用同一套判据，不各写一份。
- `--handoff` / `--report` 在 app 口径下不产出（那是关本会话的产物），给了会打一行说明。

### 修

- 桌面 profile 的内置包（`@deepseek-ai/*` 打在 app.asar 里）不再被要求出现在 profile 的 `dependencies` ——
  否则 `closeout app` 会把它们误报成"重启后装载不了"（实测踩到：30 个 bundle 里 13 个被误报）。

## 0.4.0 — 2026-10-21

### 变更（职责澄清，不含新功能）

- 本包**只做关会话前自检**（CLI + skill），**不含任何按钮/UI**。输入框按钮拆到独立插件 `dsh-button`
  （原 `dsh-closeout-button` 改名）；「收口」面板由 `dsh-button` spawn 本包 CLI，未安装本包时降级提示。
- 三个包的分工：`dsh-closeout`（自检）/ `dsh-button`（输入框按钮）/ `dsh-open-at-last-input`（会话落点）。
  详见 `PHASE2-PLAN.md`。

## 0.3.0 — 2026-10-21

### 加

- **`--report`**：生成四段收尾报告骨架（结论 / 做了什么 / 当前状态 / 未决·下一步 / 回滚点），`--report-out <文件>` 写盘。
  与 `--handoff` 共享同源事实，但**不写 `原会话：` 行**（报告不参与 handoffs 台账，免得被误当成交接件）。
- **`--cwd <dir>`**：指定要检查的工作目录（此前只能靠 `--cwd-from-session` 或进程 cwd）。
- **收尾·同步提示**：报告里探测工作区 `tools/dsh-sync.*`，给出 `status` / `push` 命令，**只提示不调用**。

### 变更

- 文档统一口径：「收尾」= 同步（可选）→ 体检 → 交接（按需）→ 报告；旧词「收口」= 体检、「收工」= 同步。
- README 增补 DSH 生态同类插件对比（`shared-handoff-dsh`、`@ericality/dsh-handoff`、`dsh-session-manager`、
  `dsh-archived-chats`、`dsh-git`、`dsh-turnsnap`）与定位句：「只做判定，不抢别人的事」。

## 0.2.1 — 2026-10-20

### 修

- **`npm link` 之后命令空输出、退出码 0**（最严重的一个）。全局目录建的是 junction，Node 把
  `import.meta.url` 解析成真实路径而 `process.argv[1]` 仍是 junction 路径，两者字符串不等，
  于是 `main` 整个被跳过 —— 正好是 README 里写的那个"退出码 0 + 空输出被当成成功"。
  改为两边 `realpath` 归一后比较，并加 junction 回归测试（建链 → 调用 → 必须有输出 → 清理后断言源目录完好）。

### 加

- 每条「必须处理 / 顺手看一眼」带一行可复制的**下一步**：脏仓给 `diff --stat`（先看清楚再决定，不替你 `add`）、
  未推给 `git push`、落后给 `pull --rebase`、规则锁给 `release`、交接件给 `closeout --handoff`。
  只给命令，不代执行 —— 推送与删除都是外部可见或不可逆的动作。
- 临时文件清单里给脚本类文件标 `[脚本]`（`.ps1/.sh/.py/.mjs` 等）。**只标注、不判断**：
  文件系统上没有"从未被执行"的可靠判据（Windows 上 atime 通常被关掉），标出来让人自己确认，比假装查过诚实。

### 变更（对 `--json` 消费者是 breaking）

- `must` / `glance` 从 `string[]` 改为 `{ text, next }[]`，`next` 可能是 `null`。

## 0.2.0 — 2026-10-20

### 加

- **结论三档前置**：`可以直接归档或删除` / `可以归档；删之前先写交接件` / `可以归档；先别删`。
  判断放在第一屏，清单退居依据。只对**删除**设门槛（归档可逆，删除不可逆）。
- **接上会话元数据**：读 DSH 会话库的事件计数与时间（调用数 / 跨天 / `turn/end` 的 reason / goal blocked），
  判"该不该写交接件"。**只读事件类型与时间，不读对话正文。** Node < 22 没有 `zlib.zstdDecompressSync` 时
  整项降级，并把原因写进「没查的」与 `--json` 的 `skipped`（读不到 ≠ 没问题）。
- `--handoff` 生成交接件骨架：工具已知的事实（会话 id、次数、跨天、未提交的仓、临时文件）填进
  「当前状态（可复跑验证）」，只留「做了什么 / 未决 / 回滚点」给人。默认不覆盖已有文件。
- `--local <工作区>`：接上该工作区自己的门（`rules-lock` / `hygiene-structure` / `rules-audit`）。
  路径不硬编码，脚本不存在就在「没查的」里说明。
- 新参数：`--session` `--sessions-dir` `--handoffs` `--threshold` `--min-calls` `--days`
  `--task` `--force` `--dry-run`。

### 修

- `listRecentFiles`：原来在达到上限时直接 `return`，返回的是**目录遍历序**前 N 个，不是最新的 N 个 ——
  临时目录文件一多，真正刚写出来的那几个根本不出现。改为收集后按 mtime 降序取前 N。
- `daysSpan`：用 `!first` 判空，时间戳 `0` 被当成"没有"，跨天算成 1 天。
- README 的**技能安装方式**是错的：`git clone <repo> ~/.dsh/skills/closeout` 会让 `SKILL.md` 落在二级目录，
  而 agent 只扫 `<skills>/<名字>/SKILL.md` 这一层 —— **装了等于没装，且没有任何报错**。

### 结构

- 拆成 `bin/closeout.mjs`（入口）+ `lib/`（`git` `files` `session` `checks` `render` `handoff`），单文件不再超 500 行。

## 0.1.0 — 2026-10-19

- 首个版本：未提交改动 / 领先落后上游 / 临时目录里近期写出的文件；`--json` `--strict` `--zh`；
  7 个用例。
