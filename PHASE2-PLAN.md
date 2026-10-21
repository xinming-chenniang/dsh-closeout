# Phase 2：三个包的职责切分与改造（2026-10-21 定稿）

> **决策（用户 2026-10-21 确认）**：
> - `dsh-closeout` = **关闭会话前自检**（CLI + skill），**不含任何按钮/UI**。
> - `dsh-button` = **输入框按钮**（从 `dsh-closeout-button` 改名），整组按钮独立成包。
> - `dsh-open-at-last` = **界面落点**（打开会话滚到最近一条本人发言），**不与 dsh-button 合并**。
> - 依赖方向是**单向**：`dsh-button` 的「收口」面板 spawn `dsh-closeout` 的 CLI；`dsh-closeout` 不知道按钮存在。
> - 本阶段**不发 npm**；tgz 足够自用，npm 最后再说。（push 已于 2026-10-21 做完，见 §8。）

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
- [x] README（中/英）：加一句"输入框按钮在 `dsh-button`，本包不装任何 UI"
  （`README.md:8`、`README.en.md:7`）。
- [x] CHANGELOG 0.4.0：职责澄清（不是新功能）。
- [x] 验证：`node --test`（23 例）+ `node bin/closeout.mjs --zh --report` —— 2026-10-21 23:4x 复跑，
  **pass 23 / fail 0**，四段报告齐全、无 `undefined`。

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
  - [x] **重启后自动化验证**（2026-10-21 22:03 应用重启后跑 `tmp\20261021-dsh-button改名\verify-after-restart.ps1`）：
    `POST /api/dsh-closeout/check` → **200 + `ok:true`**（closeout 13 个字段齐全，3.0 s）；返回的 `repos` 里已有
    `D:/dsh/dsh-button` —— 说明跑的就是改名后的树。
  - [x] **界面五格**（2026-10-21 23:4x 验，不靠人眼）：截取运行中窗口画面，输入框左侧依次是
    **继续 / 收尾 / 按建议执行 / 收口 / 重发上一条**（`+` 与盾牌图标是宿主自带的）。
    证据图 `D:\dsh\tmp\20261021-dsh-button改名\evidence\composer-buttons-20261021.png`，
    截法 `tmp\20261021-dsh-button改名\grab-window.py`（Win32 `PrintWindow`，只读不点击）。
    ⚠️ 那目录在 `tmp\` 下，30 天清扫后证据图会消失；结论以本行文字为准。
  - [x] **点击＝填充并提交**：由 19 例单测点名覆盖（「继续/收尾/按建议执行：点击＝填进当前会话并提交」
    「重发上一条：覆盖草稿并提交」「没有打开的会话：按钮禁用」）。
  - [x] **现场点击**（2026-10-21 23:5x，用户点）：会话里收到「继续」二字 —— 填充并提交在真机上一次走通。
    （单看消息内容分不出"点按钮"与"手打"，按用户确认算 PASS。）
  - [x] **502 降级**：`node tmp\20261021-dsh-button改名\test-502-degrade.mjs` → **6/6 PASS**
    （405 / 403 / 400 / 502 `closeout-failed` 且 message 带 ENOENT / 未设环境变量时 200 `ok:true`），
    走 `node_modules\dsh-button` junction 加载**装好的那份代码** + 真 HTTP 往返；
    不必再为它专门重启一次宿主（那一段由现场 200 覆盖）。

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

**打包前先清 `lib\`**（2026-10-21 变实际踩到的坑）：`package.json` 的 `files: ["lib", …]` 是整目录打包，
`lib\*.bak-before-panel` 这类开发备份虽被 `.gitignore` 排除、**却会进 tgz**。改名后 `lib\` 里躺着
`client.js.bak-before-panel` / `index.js.bak-before-panel` 两份（2026-10-20 的旧备份），已移到
`D:\dsh\tmp\_trash\20261021\dsh-button-lib-bak\`；现在 `lib\` 只剩 `client.js` + `index.js`。
判据：`Get-ChildItem lib` 只该有这两个文件；`.bak` 一律别放在 `lib\` 里。

## 5. 验证矩阵

| 包 | 检查 | 判据 |
| --- | --- | --- |
| dsh-closeout | `node --test` | pass 23 / fail 0 |
| dsh-closeout | 报告 | `--report` 四段齐全、无 undefined |
| dsh-button | `node --test test/*.mjs` | pass 19 / fail 0（client 11 + host 8） |
| dsh-button | 插件加载 | 桌面端启动 / web boot 无失败项 |
| dsh-button | 按钮 | 五格出现 ✅（截图，2026-10-21 23:4x）；「继续」填充并提交 ✅（用户 23:5x 真点过） |
| dsh-button | 面板 | 装了 closeout → JSON 返回 ✅；未装 → 502 降级提示 ✅（`test-502-degrade.mjs` 6/6） |
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

- ~~❌ push~~ → **已 push**（2026-10-21 23:5x，`5d13f9f..1be853f`；走 Veee HTTP 代理 `127.0.0.1:15236`，
  schannel 与 openssl 这次都握手失败，细节见 `D:\dsh\TECH.md`）。
- ❌ npm publish（等打磨完）。`dsh-button` 的仓已建并推上去：`https://github.com/xinming-chenniang/dsh-button`（2026-10-21 23:5x，11 个提交）。两包都是 `private: true`，真要发 npm 得先摘掉。
- ❌ 三包合并（已定：独立）。
- ❌ 删除旧 `dsh-closeout-button` 目录（改名后保留 git 历史；验证通过再决定）。
