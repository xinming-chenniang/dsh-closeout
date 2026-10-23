# 变更记录

版本语义：0.x 阶段允许 breaking，但**每次都写在这里**。

## 未发布

### 文档

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
