# dsh-closeout

> 关会话之前先跑一遍：**哪些东西还只活在磁盘上，以及这个会话该不该交接。**

一个零依赖命令行工具 + 一个技能（skill）。它回答两个问题，并且**先给答案再给清单**：

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

## 和同类工具的区别

这类事情已经有人做过了。诚实地说清楚差在哪：

| 工具 | 它做什么 | 关系 |
|---|---|---|
| [`git-leave`](https://github.com/mrnossiom/git-leave) | Rust CLI，装好后是 `git leave`；列出脏工作区、领先上游的分支、**没有上游的分支**；多线程爬取，可配全局默认目录 | **git 卫生这块它更细**（逐分支列 ahead / no-upstream）。本工具只按仓库汇总 |
| [`pendector`](https://github.com/thaim/pendector) | Rust CLI，多目录扫描 + TOML 配置 + JSON + Slack webhook | 覆盖面更广；本工具的取舍是**零安装**（`npx` 直接跑）与**不需要配置** |
| 平台自带的 stop hook（如 Claude Code 的 `decision: block`） | 会话结束时跑脚本，能拦住结束并推你一句 | 这是"不让你忘记"的更强形态；本工具是"主动跑"，靠 skill 让 agent 触发 |
| 会话交接插件（DSH 生态里的 `dsh-handoff*`） | 把会话内容导出成交接文档 | 互补：它们写"发生了什么"，本工具判断"该不该写、磁盘上还差什么" |

**它唯一不重复的部分**：临时目录里"刚写出来的文件"这条检查，和"这个会话该不该交接"的判断。
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

装成技能后，说一句"收尾"或"准备关这个会话"，agent 就会按 `skills/closeout/SKILL.md` 的四步走：**体检 → 逐条处置 → 写交接件 → 才允许关**。

## 用法

```bash
closeout                                  # 自动发现：当前仓库，或一级子目录里的仓库
closeout --repo ../api --repo ../web      # 指定仓库（可重复）
closeout --temp ./scratch --hours 6       # 指定临时目录与"多新算新"
closeout --session <id>                   # 指定会话（默认 $DSH_SESSION_ID，其次"最近写入的那个"）
closeout --local D:\dsh                   # 额外跑那个工作区自己的门
closeout --handoff --task 收尾工具         # 生成交接件骨架
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
