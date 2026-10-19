# dsh-closeout

> 关会话之前先跑一遍：**哪些东西还只活在磁盘上**。

一个零依赖的命令行工具 + 一个技能（skill），解决 AI 编码会话结束时最常见的一类事故：
**窗口一关，没提交的改动、只写着没跑过的脚本、忘了推的提交，全都失联。**

```bash
npx dsh-closeout
```

```text
仓库:
  ! D:/work/api        [main]  已修改 2, 未跟踪 1
      src/router.ts
      docs/plan.md
  + D:/work/web        [main]  干净

最近写出来的文件 (last 12h):
  ! D:/work/tmp
      probe.ts  3 KB
      notes.md  1 KB

汇总: 2 警告

下一步:
  - 把上面的改动提交或 stash —— 归档会话不会替你保存它们
  - 把一次性实验从临时目录挪走，或明确删掉
```

## 为什么做这个

我自己的会话里，下面三件事都真的发生过：

1. **"显式路径提交"把别人的改动一起带走了。** 我 `git add <一个文件>` 时，那个文件里另一个会话刚写的两行也在里面，于是它以我的提交信息进了历史。
2. **退出码 0 + 空输出被我当成了成功。** 一条脚本崩在中途、什么都没产出，但退出码是 0，我按"没报错"继续往下做了半小时。
3. **无 BOM 的 `.ps1` 在计划任务里静默空转。** 同一个脚本手工跑正常，由调度器跑时 exit 0、不写日志、什么也没做。

共同点：**都不是代码 bug，是"关掉之前没人问一句"**。工具能做的部分（磁盘上到底有没有没落盘的东西）就做成命令；
剩下的判断（这次改动意味着什么、要不要交接）交给技能里的流程。

## 它查什么

| 检查 | 判据 | 为什么跨平台跨版本还成立 |
|---|---|---|
| 未提交改动 | `git status --porcelain`，暂存/修改/未跟踪分开数 | git 的稳定接口 |
| 相对上游领先/落后 | `git rev-list --left-right --count @{u}...HEAD` | 同上 |
| 临时目录里刚写出来的文件 | `mtime > now - N 小时`，跳过 `node_modules` / `_trash` / `.git` | 文件系统事实 |
| 仓库自动发现 | cwd 是仓库就查它，否则查一级子目录里带 `.git` 的 | 不猜路径 |

**它不查什么**（刻意的）：

- ❌ **不解析会话日志**（各家私有格式、无兼容承诺 —— 解析它就是给自己埋雷）；
- ❌ **不读你的笔记/待办系统**（那是每个人的私有约定）；
- ❌ **不替你提交、不替你删文件**（只读；要做的是你，工具只负责让你看见）。

## 安装

三种方式，按需要选：

```bash
# 1) 临时用一次（零安装）
npx dsh-closeout

# 2) 全局装命令
npm i -g dsh-closeout
closeout --zh

# 3) 装成技能（DSH / 任何支持技能目录的 agent）
git clone https://github.com/284022719/dsh-closeout ~/.dsh/skills/closeout
#   Windows:  git clone https://github.com/284022719/dsh-closeout %USERPROFILE%\.dsh\skills\closeout
#   项目级:   git clone https://github.com/284022719/dsh-closeout <项目>/.dsh/skills/closeout
```

装成技能后，说一句"收尾"或"准备关这个会话"，agent 就会按 `skills/closeout/SKILL.md` 的四步走：
**体检 → 逐条处置 → 写交接件 → 才允许关**。

## 用法

```bash
closeout                                  # 自动发现：当前仓库，或一级子目录里的仓库
closeout --repo ../api --repo ../web      # 指定仓库（可重复）
closeout --temp ./scratch --hours 6       # 指定临时目录与"多新算新"
closeout --zh                             # 中文标签
closeout --json                           # 机读（CI / 钩子用）
closeout --strict                         # 有警告就 exit 1
closeout --help
```

退出码：`0` 跑完了（有警告也是 0）、`1` 加了 `--strict` 且有警告、`2` 参数错误。

## 用在 CI / 钩子里

```yaml
- run: npx dsh-closeout --strict --repo . --temp ./tmp --hours 24
```

`--json` 的输出形如：

```json
{
  "repos": [{ "dir": "D:/work/api", "branch": "main", "staged": 0, "modified": 2, "untracked": 1,
              "dirty": true, "ahead": 0, "behind": 3, "files": ["src/router.ts", "docs/plan.md"] }],
  "temp":  [{ "dir": "D:/work/tmp", "files": [{ "path": "D:/work/tmp/probe.ts", "size": 3072 }] }],
  "warnings": ["D:/work/api: 3 uncommitted change(s)"],
  "hours": 12
}
```

## 开发

```bash
node --test test/      # 7 个用例：porcelain 解析 / 新文件筛选 / 空环境 / 渲染 / CLI 端到端 / 参数校验
node bin/closeout.mjs --repo . --zh
```

零运行时依赖，只需 Node ≥ 18。

## 边界

- **只管仓库与文件，不管"这段对话值不值得留"** —— 那部分写在技能里，靠人判断。
- **归档 ≠ 保存**：工具不会替你提交，它只负责在你关之前把该看的摆在面前。
- **Windows / macOS / Linux** 都可用；路径分隔符、编码都按各平台原生处理。

## 许可

MIT。
