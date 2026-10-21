# Phase 2：三个包的职责切分与改造（2026-10-21 定稿）

> **决策（用户 2026-10-21 确认）**：
> - `dsh-closeout` = **关闭会话前自检**（CLI + skill），**不含任何按钮/UI**。
> - `dsh-button` = **输入框按钮**（从 `dsh-closeout-button` 改名），整组按钮独立成包。
> - `dsh-open-at-last` = **界面落点**（打开会话滚到最近一条本人发言），**不与 dsh-button 合并**。
> - 依赖方向是**单向**：`dsh-button` 的「收口」面板 spawn `dsh-closeout` 的 CLI；`dsh-closeout` 不知道按钮存在。
> - 本阶段**不 push、不发 npm**；tgz 足够自用，npm 最后再说。

## 1. 三个包

| 包 | 职责 | 形态 | 内容 | 依赖 |
| --- | --- | --- | --- | --- |
| `dsh-closeout` | 关会话前自检（判定器） | CLI + skill | `bin/closeout.mjs`、`lib/`（checks/session/git/files/render/handoff/report）、`skills/closeout/SKILL.md` | 无（零依赖，Node ≥18） |
| `dsh-button` | 输入框按钮 | 纯 client 插件 | 继续 / 收尾 / 按建议执行 / 重发上一条 + 「收口」面板 | 可选：`dsh-closeout`（面板用；未装则降级） |
| `dsh-open-at-last-input` | 界面落点 | 纯 client 插件 | 打开已结束会话时滚到最近一条本人发言 | 无 |

```
dsh-closeout/            # 仓库（20261020-收尾流程发行版）
├── bin/ lib/ skills/ test/
├── README.md README.en.md CHANGELOG.md PHASE2-PLAN.md
└── package.json         # bin + skills；dsh 字段里不声明 client

dsh-button/              # 原 dsh-closeout-button（目录改名待做）
├── lib/index.js         # host：spawn closeout、/api/dsh-closeout/check
├── lib/client.js        # web：五个动作 + 面板
├── cordis.patch.yml     # insert id/name = 包名
└── test/                # host.test.mjs + client.test.mjs

dsh-open-at-last-input/  # 不动
```

## 2. 依赖与降级（dsh-button → dsh-closeout 单向）

`lib/index.js` 找 `closeout` 的顺序（现有实现，保留）：

1. 环境变量 `DSH_CLOSEOUT_BIN`（可指向 `.mjs`，用当前 node 跑）；
2. PATH 里的 `closeout`（`npm link` / `npm i -g` 之后存在）；
3. **底板**：本机 `D:\工作区\dsh-worklog` 等路径**不硬编码**；未找到时路由返回 502，
   面板显示「未安装 dsh-closeout，只能发触发词」。

**合并后建议**：把第 2 步改成"包内 CLI"只在同仓合并时才有意义；拆包后保持"环境变量 → PATH"即可，
不在 dsh-button 里 import closeout 的代码（避免把 CLI 逻辑拖进 client 包）。

## 3. 改造清单

### 3.1 dsh-closeout（v0.4.0）
- [x] 已无按钮代码（v0.3.0 起就是纯 CLI+skill）。
- [ ] README（中/英）：加一句"输入框按钮在 `dsh-button`，本包不装任何 UI"。
- [ ] CHANGELOG 0.4.0：职责澄清（不是新功能）。
- [ ] 验证：`node --test`（23 例）+ `node bin/closeout.mjs --zh --report`。

### 3.2 dsh-button（v0.5.0，原 dsh-closeout-button）
- [x] `package.json`：`name` 改为 `dsh-button`，版本 0.5.0；`private` 暂时保留（未发布）。
- [x] `cordis.patch.yml`：`insert.id` / `name` 改为 `dsh-button`（必须等于包名，否则静默装不上）。
- [x] `lib/index.js`：`name` 常量与注释改为 `dsh-button`（`ctx.effect` 的标签也一并改；路由 `/api/dsh-closeout` 保留——它是面板语义，不是包名）。
- [x] `lib/client.js`：`id`、`NAMESPACE` 改为 `dsh-button`（插槽格子 id 用 NAMESPACE 派生）。
- [x] `test/*.mjs`：名字引用同步（19 例全过）。
- [x] README：标题改为 dsh-button；写明"面板需要 dsh-closeout（可选）"；路径与格子 id 同步新名。
- [x] 验证：`node --test test/*.mjs` → **pass 19 / fail 0**（2026-10-21 改名后在 `D:\dsh\dsh-button` 复跑）。
- [x] **目录改名与安装**（2026-10-21 21:31 执行，脚本 `D:\dsh\tmp\20261021-dsh-button改名\rename.ps1`）：
  - `Rename-Item D:\dsh\dsh-closeout-button D:\dsh\dsh-button`（`.git` 随目录搬，历史完整）；
  - profile `package.json`：`dependencies` 键与 `dsh.profile.bundles[24]` 同位置替换（bundles 仍 29 项）；
  - `node_modules`：删旧 junction、建 `dsh-button` junction（先删后建——反过来会留悬空链接）；
  - **锁两处**：profile 根 `pnpm-lock.yaml` **与** `node_modules\.pnpm\lock.yaml`（`pnpm ls` / `dsh plugin list` 读后者）；
  - 脚本内 16 条断言全 PASS；`dsh plugin --profile desktop list` 已显示 `dsh-button@link:D:/dsh/dsh-button`。
  - [ ] **重启应用后跑运行时验证矩阵**（五格出现 / 继续·收尾填充提交 / 收口返回 JSON / `DSH_CLOSEOUT_BIN` 指错路径 → 502 降级）。

### 3.3 dsh-open-at-last-input
- [x] 不动。

## 4. 安装 / 分发（每个包各自适用）

| 形态 | 命令 | 用途 |
| --- | --- | --- |
| `link:` | `dsh plugin --profile desktop add link:D:/dsh/dsh-button` | 开发期（改源码即生效） |
| `file:` | `dsh plugin --profile desktop add file:../dsh-button` | 快照 |
| tgz | `dsh plugin --profile desktop add ./dsh-button-0.5.0.tgz` | GitHub Release 分发，不需要 npm |
| npm | `dsh plugin --profile web add dsh-button` | 可选，打磨完再说 |

CLI 独立安装：`npm i -g dsh-closeout` 或 `npx dsh-closeout`；插件与 CLI 可以不同版本。

## 5. 验证矩阵

| 包 | 检查 | 判据 |
| --- | --- | --- |
| dsh-closeout | `node --test` | pass 23 / fail 0 |
| dsh-closeout | 报告 | `--report` 四段齐全、无 undefined |
| dsh-button | `node --test test/*.mjs` | 现有 10 例全过 |
| dsh-button | 插件加载 | 桌面端启动 / web boot 无失败项 |
| dsh-button | 按钮 | 五格出现；「继续」「收尾」填充并提交 |
| dsh-button | 面板 | 装了 closeout → JSON 返回；未装 → 502 降级提示 |
| dsh-open-at-last | 视口 | 打开已结束会话落到最近一条本人发言 |

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| 改名破坏安装（id/name 必须等于包名） | 三处同步改：`package.json.name`、`cordis.patch.yml`、`lib/index.js` 的 name |
| 目录改名破坏 link: | 目录改名 + profile 依赖键 + junction 三件一起改，改完重启 |
| 面板依赖 closeout | 未装时 502 + 面板提示，不静默 |
| client API 漂移 | README 注明验证过的 DSH 版本；保留纯客户端降级 |

## 7. 回滚

- closeout：`git reset --hard 2c19b1a`（或当前 HEAD）。
- dsh-button：改名前提交在 `D:\dsh\dsh-closeout-button` 的 git 历史；目录改名可逆行，profile 依赖可恢复。
- open-at-last：未动。

## 8. 不做

- ❌ push / npm publish（等打磨完）。
- ❌ 三包合并（已定：独立）。
- ❌ 删除旧 `dsh-closeout-button` 目录（改名后保留 git 历史；验证通过再决定）。
