# 来源地图与决策归属

> 解决「不记得怎么来的、也不知道怎么工作的」。同名东西有 **5 个**，只靠记忆连接——这张图把它们摆开。

## 1. 时间线（本机 `D:\dsh` + 本仓库）

| 日期 | 出现了什么 | 位置 |
|---|---|---|
| 2026-10-14 | 长会话交接的「点名 + 台账」脚本；`handoffs/README.md` 定触发与存放 | `D:\dsh\tools\sessions-handoff.mjs`（21.9 KB）、`D:\dsh\handoffs\README.md` |
| 2026-10-19 | 调用数清单（阈值 300 的原始出处） | `D:\dsh\tools\sessions-length.js`（4.2 KB） |
| 2026-10-20 03:23 | `dsh-closeout` 0.1.0 一次成型（CLI + 技能 + 文章） | 本仓库首个提交 `7a6dabf` |
| 2026-10-21 | 收尾流程统一口径；输入框按钮拆到 `dsh-button`（本包不带 UI） | 本仓库 / `D:\dsh\plugins\dsh-button` |
| 2026-10-22 | 0.6.0：拆 `session` / `app` 两个口径，补 P0 五条 | 本仓库 `353a30e` |
| 2026-10-23 | **本机又出现一个总入口**：`sessions-closeout.mjs`（交接判定 + 规则锁 + git + tmp + CI） | `D:\dsh\tools\sessions-closeout.mjs`（19.2 KB） |
| 2026-10-24 | 补「来源与借鉴」；加 `--explain`；写本文件与 `BEHAVIOR.md` | 本仓库 |

## 2. 现在同时存在的 5 个东西

| 名字 | 角色 | 判据 | 与谁重叠 |
|---|---|---|---|
| `sessions-length.js`（本机） | 只列「谁超线」 | 300 次 | 被 `sessions-handoff.mjs` 与 `dsh-closeout` 各自实现了一次 |
| `sessions-handoff.mjs`（本机） | 交接判定 + 台账消费留痕（`> 已完结`） | 300 / 50 / 未收口 / 跨天 | 与 `dsh-closeout` 的 `handoffVerdict` 同源同数字 |
| `sessions-closeout.mjs`（本机） | **总入口**：交接判定 + 规则锁 + 脏仓 + tmp + 根级 + CI 红绿 | 声明「全部来自既有工具，不另立数字」 | git/tmp 检查与 `dsh-closeout` 重复；CI 检查是它独有 |
| `dsh-closeout`（npm 包） | **判定器**：磁盘体检 + 三档结论 + 交接件骨架 + 报告骨架 + `app` 口径 | 300 / 50 / 未收口 / 跨天 / token | 与上面两个脚本的判据重复；`app` 口径为它独有 |
| `handoff` 技能（第三方插件 `shared-handoff-dsh`） | 交接件的**流程与模板** | 无阈值 | 被 `handoffs/README.md` 与本包 README 引用；**本机 2026-11-09 已卸载**（见 §7） |

外加两处**文档里的数字**：`D:\dsh\AGENTS.md` 第 68 行（300 次止损）与第 83 行（收尾固定跑 `sessions-closeout.mjs`）。
→ 同一个「300」现在写在 **3 个脚本 + 1 份规则文件**里。

## 3. 决策归属（谁是唯一来源）

| 决策 | 唯一来源（应然） | 现在实际上写在哪 |
|---|---|---|
| 阈值 300 / min-calls 50 | `dsh-closeout` 的 `parseArgs` 默认值（`--explain` 会打印） | 本仓库 + `sessions-length.js` + `sessions-handoff.mjs` + `sessions-closeout.mjs` + `AGENTS.md` |
| 五条交接判据 | `lib/session.mjs#handoffVerdict` | 同上（3 份实现） |
| 交接件的章节结构 | 第三方 `shared-handoff-dsh` 的 `handoff` 技能（流程）+ 本仓库 `lib/handoff.mjs`（落地） | `handoffs/README.md`、本仓库 README、插件技能，共 3 处描述 |
| 磁盘体检项 | `lib/checks.mjs#collect` | 本仓库 + `sessions-closeout.mjs` |
| 本机门（规则锁 / 根级 / 审计） | 工作区 `tools/rules-*.mjs` | 只在 `--local` 时被调用 |
| 归档 / 删除动作 | 不归本工具（`dsh-session-manager` 等） | — |

## 4. 为什么会有「被自己造的东西束缚」的感觉

不是因为它自动跑（**它不自动跑**：没有计划任务、`dsh-button` 已在 10-22 移除了「收口」按钮，只有你或 agent 主动调用时才执行）。
束缚感来自三件结构性的事：

1. **同一个决定散在 5 个实体里**，而它们之间没有引用关系，唯一的连接是你的记忆；
2. **它参与判断却不解释自己**（改之前 `--help` 只列参数，不告诉你默认值从哪来、哪条判据在拦你）——本次加了 `--explain` 就是补这个；
3. **规则同时也写在 prose 里**（AGENTS.md 的「300 次」「跑哪个脚本」），prose 与代码会各自漂移，漂移之后你会发现「工具在管我，但我不知道它在管什么」。

## 5. 收口方案（A 已执行，2026-10-24）

**A. 收权到 npm 包** —— 已落地：

- `D:\dsh\tools\sessions-closeout.mjs` 第 1 项（交接判定）改为调
  `closeout --json --zh --handoffs D:\dsh\handoffs`；阈值与五条判据不再由本机脚本计算。
  本机独有的检查（规则锁 / 仓 / hub 页面 / tmp 窗口 / 根级 / CI 红绿）原样保留。
- `sessions-length.js`、`sessions-handoff.mjs` 加「已降级（2026-10-24）」文件头，仅作存量盘点。
- `D:\dsh\AGENTS.md` 收尾步骤注明「交接判定委托 dsh-closeout」。
- `D:\dsh\handoffs\README.md` 的阈值改为指向 `closeout --explain`。
- 备份：同目录 `*.bak-20261024-a`（`sessions-closeout.mjs` / `sessions-handoff.mjs` /
  `sessions-length.js` / `AGENTS.md` / `handoffs\README.md` 各一份），回滚就是拷回去。

**仍未收口的重复（需要你确认，属规则变更）**：
`C:\Users\28402\.dsh\AGENTS.md`（用户级、逐会话注入）里还有一句「单个会话超过约 300 次工具调用…」。
按你自己定的规矩，改既有条款要先问——要不要把它改成「阈值唯一来源：`closeout --explain`」？

**B / C 不再采用**：B（以本机脚本为唯一入口）会让对外版本与本机分叉；C（只做声明）解决不了「5 个实体仍在」。

## 6. 它对作者的干预点（何时会喊你）

| 时机 | 喊什么 | 怎么改 / 关掉 |
|---|---|---|
| 你说「收尾」/「收口」 | 技能触发三步：体检 → 处置 → 报告 | 不触发就不跑 |
| 手动跑 CLI | 三档结论 + 必须处理清单 | `--strict` 才影响退出码；不加永远 exit 0 |
| 调用数 > 300 | 建议写交接件 | `--threshold N`，或改默认值 |
| 上下文 > 阈值 | 建议写交接件 | 默认关闭，`--token-threshold` 才启用 |
| 定时 / 后台 | **没有** | 无计划任务、无按钮钩子（10-22 已移除） |

## 7. 2026-11-09：本机卸载 `shared-handoff-dsh`（决策记录）

起因是用户问「`dsh-closeout` 和 `shared-handoff-dsh` 是不是重复了」。核对结论：**功能不重复，但有三处真重复**（触发词、交接件模板与状态约定、安装位），据此决定**不保留跨端共享交接**，卸载该插件。

判「重复」用的不是功能清单，是**实测使用量**：全盘（`D:\dsh` / `D:\个人项目` / `D:\个人应用`）搜不到一个 `.agents/state/`、`session-tasks.json`、`process.auto.md` —— 它的宿主半要求 cwd 有 `.agents/state` 才注入（`lib/index.js` 的 `resolveTaskContext`），所以在本机**从未生效**；真正在用的只有「交接件落 `D:\dsh\handoffs\`、由 `dsh-closeout` 判定」这一套。

做了三件：

1. 从 desktop profile 的 `dependencies` + `bundles` 移除（`plugin_manager remove_bundle`，pnpm exit 0）；`handoff` / `task-id-bootstrap` 两个技能随之从技能目录消失。
2. 清掉它留下的账：`~/.dsh/handoffs` 里 16 个 `workspace*` 目录（全是测试残留，戳指向 `%TEMP%`）→ `tmp\_trash\2026-11-09\handoffs-test-pollution\`；同期 v0.6 遗留的 1 份交接件与 2 份收尾报告迁入 `D:\dsh\_archive\handoffs\`（含 `reports\`）。
3. 修根因：本包测试用例 `writeLedgerStamp` 没隔离 `homedir()`，**每跑一次 `npm test` 就往真实 `~/.dsh/handoffs` 净增 1 个目录**（只增不减）。`withTmp` 现在把 `HOME` / `USERPROFILE` 指到临时 home，并加断言钉住。生产代码零改动。

影响：本机交接模板的唯一来源变成**本包 `lib/handoff.mjs` 的七节骨架 + `D:\dsh\handoffs\README.md` 的台账契约**；跨 agent（Codex / Claude）共享 `.agents/state/` 的能力本机不再有。

回滚：`plugin_manager install_bundle shared-handoff-dsh@0.3.3`，或恢复 `profiles\desktop\package.json.bak-20261109-before-drop-shared-handoff` 后重装。数据类回滚见 `tmp\_trash\2026-11-09\handoffs-test-pollution\`（17 个目录）与归档区索引行。
