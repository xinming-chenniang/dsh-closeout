# dsh-closeout

> 关会话之前先跑一遍：**哪些东西还只活在磁盘上，以及这个会话该不该交接。**

一个零依赖命令行工具 + 一个技能（skill）。它回答两个问题，并且**先给答案再给清单**：

> **本包不带任何按钮/UI**（2026-10-21 起）：输入框按钮（继续 / 收尾 / 按建议执行 / 重发上一条 + 收口面板）
> 拆到独立插件 `dsh-button`；它 spawn 本包 CLI 出结论，未安装本包时降级提示。

1. **能不能关？**（归档可逆、删除不可逆，所以只对删除设门槛）
2. **该不该写交接件？**（按会话长度、跨天、末尾是否收口判断）

```bash
npx dsh-closeout --zh
```

```text
收口 —— 关会话之前的体检 · 会话 ba7ea134 · 101 次调用 · 跨 1 天 · 末次 2026-10-20 06:55
────────────────────────────────────────────
结论：✗ 可以归档；先别删 —— 还有 2 件东西只活在磁盘上

该不该交接：! 该写：超线（101 次 > 10）

必须处理：2
  ✗ D:\work\api → 1 已修改 / 2 未跟踪
      src/router.ts
      docs/plan.md
  ✗ D:\work\tmp → 最近 12 小时写了 12 个文件
      probe.ts  4 KB
      notes.md  1 KB
      …

没查的（不等于没问题）：1
  · 本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查

只对「删除」设门槛：归档可逆，删除不可逆。
```

## 为什么做这个

我自己的会话里，下面几件事都真的发生过：

1. **"显式路径提交"把别人的改动一起带走了。** 我 `git add <一个文件>` 时，那个文件里另一个会话刚写的两行也在里面，于是它以我的提交信息进了历史。
2. **退出码 0 + 空输出被我当成了成功。** 一条脚本崩在中途、什么都没产出，但退出码是 0，我按"没报错"继续往下做了半小时。
3. **无 BOM 的 `.ps1` 在计划任务里静默空转。** 同一个脚本手工跑正常，由调度器跑时 exit 0、不写日志、什么也没做。
4. **会话开到第 400 次调用时，我已经不记得还有什么没做完。** 关掉之后，那些未决项只存在于已经消失的上下文里。

共同点：**都不是代码 bug，是"关掉之前没人问一句"**。前三条工具能查（磁盘事实），第四条工具查不了——但它能替你判断"这个会话够长了、该写一份交接件了"，然后把骨架生成出来。

## 收尾流程（2026-10-21 统一口径）

**收尾** = ① 同步（可选）→ ② 体检（本工具）→ ③ 交接（按需）→ ④ 报告（`--report`）。
旧词对照：**收口** = 体检这一步；**收工** = 同步这一步；三个词的总称统一叫「收尾」。

| 步骤 | 做什么 | 入口 |
|---|---|---|
| ① 收尾·同步 | 改一处就 commit，push 可以攒；本工具只**探测**工作区的 `tools/dsh-sync.*` 并提示，不调用 | `tools/dsh-sync.ps1 status/push` |
| ② 收尾·体检 | `closeout --zh`（未提交 / 未推 / tmp 新文件 / 该不该交接） | 本工具 |
| ③ 收尾·交接 | `closeout --handoff --task <任务名>` 出交接件骨架 | 本工具（或 handoff 类插件） |
| ④ 收尾·报告 | `closeout --report` 出四段骨架：做了什么 / 当前状态 / 未决 / 回滚点 | 本工具 |

## 和同类工具的区别（2026-10-21 扩写）

这类事情已经有人做过了，DSH 生态里也有。诚实说清楚边界，免得被当成重复品：

### DSH 生态里的相邻插件

| 插件 | 它做什么 | 关系 |
|---|---|---|
| [`shared-handoff-dsh`](https://www.npmjs.com/package/shared-handoff-dsh) | `handoff` + `task-id-bootstrap` 技能；把会话导出成交接文档并接上任务状态 | **互补**：它执行交接，本工具判断"该不该交接"并出骨架 |
| [`@ericality/dsh-handoff`](https://www.npmjs.com/package/@ericality/dsh-handoff) | `/handoff`：持久化改动、存进度、出新会话续接提示 | 同类（交接），无磁盘体检 |
| `snow-The/dsh-session-handoff`、`yangyizhu8/dsh-session-handoff` | 社区 session handoff 插件（GitHub 安装，npm 无包） | 同类（交接） |
| [`dsh-session-manager`](https://www.npmjs.com/package/dsh-session-manager) | 会话删/归档/移动/tag/批量；删除不可逆且必确认 | **互补**：它执行删除/归档动作，本工具给"能不能关"的依据 |
| [`dsh-archived-chats`](https://www.npmjs.com/package/dsh-archived-chats)（Archive Management） | 归档找回、工作区批量归档、搜索、回收站 | 互补：管归档后的找回，不判断该不该归档 |
| `dsh-git` | npm 0.0.1 占名、开发中；目标是 git 面板 + 阻止脏树/未推 | 最接近的竞品，**尚未发布** |
| `dsh-turnsnap` | 每轮自动 `[turnsnap]` commit | 重叠在"自动提交"，目标不同 |

### 非 DSH 的同类

| 工具 | 它做什么 | 关系 |
|---|---|---|
| [`git-leave`](https://github.com/mrnossiom/git-leave) | Rust CLI；列出脏工作区、领先上游、**没有上游的分支** | git 卫生更细（逐分支）；本工具按仓库汇总 |
| [`pendector`](https://github.com/thaim/pendector) | Rust CLI，多目录扫描 + TOML + JSON + Slack | 覆盖更广；本工具取舍是零安装、零配置 |
| 平台 stop hook（如 Claude Code `decision: block`） | 会话结束时拦一下并提醒 | 更强形态；本工具是主动跑，靠 skill 触发 |

### 定位：只做判定，不抢别人的事

**dsh-closeout = 关会话前的判定器**。它不替你交接（用 `shared-handoff-dsh` / `@ericality/dsh-handoff`）、
不替你删会话（用 `dsh-session-manager`）、不自动 commit/push（用 `dsh-sync` / `dsh-git` / `dsh-turnsnap`）、
不做归档找回（用 `dsh-archived-chats`）。它只回答两个问题：**能不能关、要不要交接**，并给出可复跑的清单。

**它唯一不重复的部分**：临时目录里"刚写出来的文件"这条检查，"这个会话该不该交接"的判断，以及三档结论。
其余（脏仓、未推送）是 git 常识，同类工具都有——如果你只需要那两条，用 `git-leave` 更合适。

## 它查什么

| 检查 | 判据 | 为什么跨平台跨版本还成立 |
|---|---|---|
| 未提交改动 | `git status --porcelain`，暂存/修改/未跟踪分开数 | git 的稳定接口 |
| 相对上游领先/落后 | `git rev-list --left-right --count @{u}...HEAD` | 同上；没配上游时**显式说"推没推无法判断"**，不假装同步 |
| 临时目录里刚写出来的文件 | `mtime > now - N 小时`，跳过 `node_modules` / `_trash` / `.git` | 文件系统事实；按最新排序取前 N 个，**不是**遍历序 |
| 会话长度与收口状态 | 读 DSH 会话库的**事件计数与时间**（调用数 / 跨天 / `turn/end` 的 reason / goal blocked） | 只读类型与时间，**不读对话正文** |
| 该不该写交接件 | 超线（默认 >300 次）/ 末尾未收口 / goal blocked / 跨天未收口；子会话不点名 | 判据与工作区里的会话台账工具一致 |
| 交接件是否已有 | 读 `handoffs/*.md` 里的 `原会话：session-...` 一行 | 机器契约，见工作区 `handoffs/README.md` |
| 本机侧的门（可选） | `--local <工作区>` 才会跑：`rules-lock` / `hygiene-structure` / `rules-audit` | 那是每个工作区自己的规矩，不硬编码 |

**它不查什么**（刻意的）：

- ❌ **不解析对话正文**（各家私有格式、无兼容承诺）—— 统计只来自事件类型与时间戳；
- ❌ **不读你的笔记/待办系统**（那是每个人的私有约定）；
- ❌ **不替你提交、不替你删文件**（只读；要做的是你，工具只负责让你看见）。

## 结论只有三档

| 结论 | 含义 | 依据 |
|---|---|---|
| `可以直接归档或删除` | 没有未落盘的东西 | 必须处理为空 |
| `可以归档；删之前先写交接件` | 归档可逆，删除不可逆 | 会话该交接但交接件不存在 |
| `可以归档；先别删` | 还有东西只活在磁盘上 | 脏仓 / 没推的提交 / 临时文件 |

## 安装

```bash
# 1) 临时用一次（零安装）
npx dsh-closeout

# 2) 全局装命令
npm i -g dsh-closeout
closeout --zh

# 3) 装成技能（DSH / 任何支持 skills 目录的 agent）
```

装技能时**不要把整个仓库 clone 进 `skills/`** —— 仓库根没有 `SKILL.md`，它藏在 `skills/closeout/` 下一层，而 agent 只扫 `<skills>/<名字>/SKILL.md` 这一层。照下面做：

```bash
git clone https://github.com/xinming-chenniang/dsh-closeout /tmp/dsh-closeout
mkdir -p ~/.dsh/skills/closeout
cp /tmp/dsh-closeout/skills/closeout/SKILL.md ~/.dsh/skills/closeout/
#   Windows: mkdir %USERPROFILE%\.dsh\skills\closeout
#            copy %TEMP%\dsh-closeout\skills\closeout\SKILL.md %USERPROFILE%\.dsh\skills\closeout\
```

装成技能后，说一句"收尾"或"准备关这个会话"，agent 就会按 `skills/closeout/SKILL.md` 的统一流程走：**同步（可选）→ 体检 → 交接（按需）→ 报告 → 才允许关**（旧词：收口 = 体检，收工 = 同步）。

## 用法

```bash
closeout                                  # 自动发现：当前仓库，或一级子目录里的仓库
closeout --repo ../api --repo ../web      # 指定仓库（可重复）
closeout --temp ./scratch --hours 6       # 指定临时目录与"多新算新"
closeout --session <id>                   # 指定会话（默认 $DSH_SESSION_ID，其次"最近写入的那个"）
closeout --local D:\dsh                   # 额外跑那个工作区自己的门
closeout --handoff --task 收尾工具         # 生成交接件骨架
closeout --report                         # 生成四段收尾报告骨架
closeout --cwd D:\dsh --report            # 指定要检查的工作目录
closeout --zh                             # 中文标签
closeout --json                           # 机读
closeout --strict                         # 有必须处理项就 exit 1
closeout --help
```

退出码：`0` 跑完了（有必须处理项也是 0）、`1` 加了 `--strict` 且有事要处理、`2` 参数错误。

### 生成交接件

```bash
closeout --zh --handoff --task 收尾工具
```

它会写 `~/.dsh/handoffs/<YYYYMMDD>-<任务名>.md`（用 `--handoffs` 换目录，`--dry-run` 只打印）。
工具已知的事实——会话 id、次数、跨天、未提交的仓、临时文件——会填进「当前状态（可复跑验证）」一节；
「做了什么 / 未决 / 回滚点」留空，因为**只有会话自己知道**。默认**不覆盖**已有文件（覆盖等于丢掉别人写的东西），要覆盖加 `--force`。

### 生成收尾报告

```bash
closeout --zh --report                          # 打印（不写盘）
closeout --zh --report --report-out 收尾报告.md  # 写盘
```

四段：结论 / 做了什么 / 当前状态（可复跑验证）/ 未决·下一步 / 回滚点 —— 与交接件同源事实，
但**不写 `原会话：` 行**：报告不参与 handoffs 台账，避免被下一个会话误当成交接件。
「收尾·同步」一节会探测当前工作区的 `tools/dsh-sync.*` 并给出命令提示，**不调用**。
`--cwd <dir>` 可指定检查哪个工作目录（默认当前目录；桌面端可配 `--cwd-from-session`）。

### 机读 / CI

```bash
npx dsh-closeout --strict --repo . --temp ./tmp --hours 24
```

`--json` 的输出形如：

```json
{
  "verdict": "no-delete",
  "verdictText": "可以归档；先别删 —— 还有 2 件东西只活在磁盘上",
  "repos": [{ "dir": "D:/work/api", "branch": "main", "staged": 0, "modified": 1, "untracked": 2,
              "dirty": true, "ahead": 0, "behind": 0, "upstream": true, "files": ["src/router.ts"] }],
  "temp":  [{ "dir": "D:/work/tmp", "files": [{ "path": "D:/work/tmp/probe.ts", "mtime": 0, "size": 3072 }] }],
  "sessionInfo": { "id": "session-…", "calls": 401, "span": 2, "guessed": false },
  "handoff": { "needed": true, "reasons": ["超线（401 次 > 300）"], "exists": false },
  "must": ["…"], "glance": [], "fine": ["…"], "skipped": ["…"]
}
```

`skipped` 是这份输出里最重要的字段：**读不到 ≠ 没问题**。会话这项在 Node < 22 上会整项跳过（没有 `zlib.zstdDecompressSync`），跳过原因会写在 `skipped` 里，而不是静默当作健康。

## 开发

```bash
node --test test/closeout.test.mjs      # 17 个用例
node bin/closeout.mjs --zh --local .
```

零运行时依赖，只需 Node ≥ 18（会话那项需 ≥ 22，自动降级）。

## 已知边界

- **只管仓库、文件与会话元数据，不管"这段对话值不值得留"** —— 那部分写在技能里，靠人判断。
- **归档 ≠ 保存**：工具不会替你提交，它只负责在你关之前把该看的摆在面前。
- **临时文件那项默认找 `./tmp`**：大多数项目没有这个目录，于是这项经常空转。给它 `--temp` 才真的在查。
- **"写了没跑过的脚本"只做标注、不做判断**：文件系统上没有可靠判据（Windows 上 atime 通常被关掉，
  "从未被执行"读不出来）。所以清单里会把 `.ps1/.sh/.py/.mjs` 这类文件标上 `[脚本]`，让人自己确认——
  标出来比假装查过诚实。
- **会话统计是"这个会话"，不是"这个仓库"**：换了会话 id 就是另一份账，别拿一个会话的数字去管另一个。
- Windows / macOS / Linux 都可用；路径分隔符、编码都按各平台原生处理。

## 许可

MIT。
