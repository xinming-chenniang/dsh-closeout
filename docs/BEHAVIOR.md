# 行为契约（带证据版）

> **这份文件要解决的是「我不记得它怎么工作了」。**
> 工具自己也能回答：`closeout --explain`（下面第 0 节就是它的输出）。
> 本文件比 `--explain` 多一层：**每条判据对应哪段代码、用什么命令能复跑出证据**。

## 0. 先看工具自述

```bash
$ closeout --explain --zh
closeout 0.6.0 —— 行为自述（--explain）

它是什么
  只读判定器。跑一次，回答两件事之一：「这个会话能不能归档 / 删除、该不该写交接件」（默认口径），
  或者「整个 DSH 能不能退出」（closeout app）。
...
```

自述里覆盖了：数据从哪来、判定顺序、每条判据的覆盖开关、它故意不做什么。
**如果自述和本文不一致，以自述为准**（它读的是代码里的实际默认值），然后改本文。

## 1. 判据 → 代码 → 复跑证据

| 判据 | 代码位置 | 复跑（在仓库根） | 期望 |
|---|---|---|---|
| 脏仓 / 未跟踪 / 未推 | `lib/git.mjs#gitStatus` + `lib/checks.mjs#touchedByCalls` | `git status --porcelain` 对照输出；`closeout --json \| grep touchedBySession` | 修改/未跟踪分开计数；**只把本会话工具调用碰过的仓算 blocker**，其余写明「不计入」 |
| 本会话碰过哪些路径 | `lib/session.mjs#collectCallRefs` | `closeout --json \| grep -c '"tool/call"'`（读了才能判） | 只读 `tool/call.data.arguments`；write/edit 的 file_path + pwsh 里带写 cmdlet 的绝对路径；不收 `>`（只读查询会误判） |
| 临时目录「刚写出来」的文件 | `lib/files.mjs#listRecentFiles` + `lib/checks.mjs` 归属过滤 | `closeout --temp . --json` | 窗口 = 本会话起点（**最早一条 `turn/start`**；显式 `--hours N` 才改成固定小时窗）；归属 = 本会话工具调用写过的路径；数量是**本会话写的总数**，明细只列 12 个 |
| 调用数超线 | `lib/session.mjs#handoffVerdict` | `closeout --json \| grep -A3 sessionInfo` | `calls > 300` 时 reasons 含「超线」 |
| 末尾未收口 | 同上 | 同上 | `lastReason !== 'completed'` 且 calls ≥ 50 |
| 跨自然日未收口 | 同上 | 同上 | 按**本段**（`segStart`，没有则退回 `first`）与 `last` 比，不在同一本地日，且与上一条去重 |
| 子会话不点名 | 同上 | 同上 | `depth > 0` 或 `parent` 存在时不判 |
| 上下文超线 | 同上（默认关） | `closeout --token-threshold 150000 --json` | 只有给了阈值才出现 |
| 交接件是否已存在 | `lib/session.mjs#readHandoffs` | `ls ~/.dsh/handoffs` | 认 `原会话：` 行；非单会话收口跳过 |
| 三档结论 | `lib/checks.mjs#conclude` | `closeout --json \| grep verdict` | `no-delete` / `write-handoff` / `safe` |
| 本机门 | `lib/checks.mjs#localGates` | `closeout --local D:\dsh` | 没有那三个脚本时进 `skipped`（明说没查） |

## 2. 一次真实运行（2026-10-24，本会话）

```bash
$ closeout --zh --repo . --hours 6
收口 —— 关会话之前的体检 · 会话 77edff2f · 416 次调用 · 跨 1 天 · 上下文 569k · 末次 2026-10-24 04:47
────────────────────────────────────────────
结论：✗ 可以归档；先别删 —— 还有 1 件东西只活在磁盘上

该不该交接：! 该写：超线（416 次 > 300）

必须处理：1
  ✗ 该写交接件（超线（416 次 > 300）），C:\Users\28402\.dsh\handoffs 里没有对应文件
      → closeout --handoff --handoffs "C:\Users\28402\.dsh\handoffs"

不用管：1
  ✓ D:/个人项目/yiqi 干净

没查的（不等于没问题）：2
  · 没有 --temp，当前目录下也没有 tmp/，临时文件这项没查
  · 本机侧的门（规则锁 / 根级登记 / 规则审计）没启用：加 --local <工作区> 才会查
```

读法：**结论在第一行之后**；`必须处理` 是 blocker；`没查的` 不是通过——这是它专门留的假阴性出口。

## 3. 覆盖开关（每条判据都有）

| 想改 | 用 |
|---|---|
| 调用数阈值 300 | `--threshold N` |
| 「够长」下限 50 | `--min-calls N` |
| 上下文阈值（默认关） | `--token-threshold N` |
| 「刚写出来」窗口默认 = 本段会话起点 | `--hours N`（强制固定小时窗） |
| 查哪些仓库 / 临时目录 | `--repo D --temp D`（可重复） |
| 台账目录 | `--handoffs DIR` |
| 额外跑工作区的门 | `--local DIR` |
| 机读 / 严格退出码 | `--json` / `--strict` |

## 4. 一致性怎么验（改代码之后必跑）

```bash
node --test test/closeout.test.mjs      # 38 个用例，覆盖判据边界与 CLI
closeout --explain --zh                 # 自述里的默认值应与 --help 和代码一致
closeout --json | jq '.verdict, .sessionInfo.calls'   # 真实数据不含错误
```

`--explain` 的默认值直接来自 `parseArgs` 的初始对象，所以**改了默认值而忘了改自述**会被第 2 条命令暴露出来。

## 5. 它不做什么（防误用）

不提交、不推送、不删除、不重启、不改文件（除非显式 `--handoff` / `--report-out`）。
`closeout app` 也不杀进程、不改 profile，只报告。
