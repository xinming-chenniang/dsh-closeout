# Phase 2：把收尾做成可安装的 DSH 插件（不是"发布 npm 包"）

> 2026-10-21 按用户口径修正：Phase 2 的产出物是**可安装的插件目录**。
> `link:` / `file:` / tgz 是分发形态，**npm 注册表是最后可选项**——不是本阶段目标，也不是唯一出路。
> 本阶段**不含 push、不含 npm 发布**；那些等插件打磨好再做。

## 1. 目标

一个 DSH 插件 bundle（npm 包格式：`package.json` + `dsh.bundle.patch` + `dsh.client`），装完得到三样：

| 入口 | 形态 | 谁在用 |
| --- | --- | --- |
| `closeout` 命令 | CLI（现有 `bin/closeout.mjs`） | 终端、npx、CI |
| 收尾技能 | `skills/closeout/SKILL.md` | 会话里自动触发 |
| 输入框按钮 + 收口面板 | client 插件（现 `dsh-closeout-button`） | DSH web（含桌面端内嵌 web） |

原则：**CLI 与 client 在同一个包里，运行时互不依赖**——没装 DSH 时只用 CLI；client 只在宿主里加载。

## 2. 依据（本机实测，不是推断）

- `dsh-closeout` v0.3.0：CLI + skill，零依赖，Node ≥ 18，23 个测试全过。
- `dsh-closeout-button` v0.4.2：**client 插件**，README 原文「desktop profile 以 `link:D:/dsh/dsh-closeout-button` 指向它」；
  桌面端启动成功、web boot 无失败项；`dsh.client.platform = "web"`。
- `dsh plugin` 不是独立安装器：它把参数**转发给 profile 里的 pnpm**（`dsh plugin --help` 原文："forwarding the remaining arguments to pnpm"）。
  所以安装来源可以是 `link:`、`file:`、tgz、npm 任意一种。

## 3. 目标包结构

```
dsh-closeout/
├── bin/closeout.mjs          # CLI（不变）
├── lib/                      # CLI 逻辑（不变）
├── plugin/                   # 从 dsh-closeout-button 搬来
│   ├── index.js              # host：slot 注册 + webServer 路由
│   ├── client.js             # web：按钮 + 面板组件
│   └── cordis.patch.yml      # bundle patch
├── skills/closeout/SKILL.md
├── test/
└── package.json
```

```jsonc
{
  "name": "dsh-closeout",
  "version": "0.4.0",
  "bin": { "closeout": "./bin/closeout.mjs" },
  "exports": {
    ".": "./plugin/index.js",
    "./client": "./plugin/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "engines": { "dsh": ">=0.2.0-rc.2" },
    "bundle": { "patch": "./plugin/cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  },
  "engines": { "node": ">=18" },
  "peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0-rc" },
  "peerDependenciesMeta": { "@deepseek-ai/cordis": { "optional": true } },
  "files": ["bin", "lib", "plugin", "skills", "README.md", "README.en.md", "CHANGELOG.md", "LICENSE"]
}
```

三个易漏点：
- `engines.node` 取 **≥18**（CLI 老环境可用）；client 宿主版本由 `dsh.engines.dsh` 单独约束。
- `exports["."]` 指向 `plugin/index.js`：作为 DSH 插件被加载走这里；普通 node import `lib/*.mjs` 不受影响。
- `files` 必须带 `plugin/`，否则装出来的包缺 client（最容易被漏）。

## 4. 安装 / 分发形态（按顺序用，不跳级）

| 阶段 | 形态 | 命令 | 说明 |
| --- | --- | --- | --- |
| 开发期 | `link:` | `dsh plugin --profile desktop add link:D:/dsh/20261020-收尾流程发行版` | 改源码即生效；与现在 button 的装法一致 |
| 自用分发 | `file:` | `dsh plugin --profile desktop add file:../dsh-closeout` | pnpm 复制快照；改完要 remove + add |
| 跨机/存档 | **tgz** | `dsh plugin --profile desktop add ./dsh-closeout-0.4.0.tgz` | `npm pack` 产物挂 GitHub Release 即可，**不需要 npmjs** |
| 公开一行装 | npm registry | `dsh plugin --profile web add dsh-closeout` | **可选**，等打磨完再决定 |

桌面端 vs Web 端：同一个包、`dsh.client.platform: "web"`；桌面端内嵌 web 运行时加载它（本机 button 已验证）。
若将来要桌面端专属能力（托盘/原生窗口），另立 `platform: "desktop"` 的 client，不在本阶段。

## 5. 合并步骤

### Step 1 搬家
在 `dsh-closeout` 仓库建 `plugin/`，把 `dsh-closeout-button` 的 `lib/index.js`、`lib/client.js`、`cordis.patch.yml` 拷入；
`cordis.patch.yml` 内指向 `./lib/index.js` 的路径同步改成 `./plugin/index.js`。

### Step 2 host 路由复用本包 CLI
面板现在调 `npx dsh-closeout --json --zh`。合并后改为**包内路径**：
`node <pkg>/bin/closeout.mjs --json --zh --session <id> --cwd-from-session`。
保留 spawn（隔离最好），不把检查逻辑 import 进 host（避免 `collect` 同步阻塞宿主事件循环，也避免与 CLI 分叉）。

### Step 3 client 文案对齐
- 按钮：`继续` → `收尾` → `收口`（面板）→ `按建议执行` → `重发上一条`。
- 「收尾」= 发触发词；「收口」= 打开面板显示 `closeout --zh` 三档结论（与 CLI 同名同义）。
- 保留 v0.4.1/0.4.2 的降级：`dsh-app://` 转发失败 → 纯客户端判断；面板 20 秒超时。

### Step 4 本机安装验证（link:）
`dsh plugin --profile desktop add link:D:/dsh/20261020-收尾流程发行版` → 重启应用 → 按钮出现 → 点「收口」出面板。

### Step 5 验证矩阵（缺一条不算完成）

| 层 | 检查 | 判据 |
| --- | --- | --- |
| CLI | `node --test test/closeout.test.mjs` | pass 23 / fail 0 |
| CLI 报告 | `node bin/closeout.mjs --zh --report --cwd <repo>` | 四段齐全、无 undefined |
| 插件加载 | 桌面端启动 / web boot | 无失败项；`dsh.client` 被加载 |
| 按钮 | 输入框出现五格 | 点「收尾」填充并提交 |
| 面板 | 点击「收口」 | `POST /api/dsh-closeout/check` 返回 JSON；超时走降级 |
| 三端 | 家机 web GUI 实点；工作机（UOS）跑 CLI | 至少 CLI 通过 |

### Step 6 退役旧包（验证通过后）
`dsh-closeout-button` 目录保留、从 desktop profile 移除 `link:` 安装；在它的 README 加一行「已并入 dsh-closeout v0.4，勿再单独装」。

## 6. 风险与取舍

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 单包 vs 两包 | 单包一次安装全有；两包各自升级 | 推荐单包；client 只在宿主加载 |
| engines 冲突 | CLI ≥18、client 宿主需 ≥20 | 分开声明 `engines.node` 与 `dsh.engines.dsh` |
| client API 漂移 | slot/webServer/sessions API 随 DSH 版本变 | README 注明验证过的 DSH 版本；保留纯客户端降级 |
| `file:` 快照 | 改源码不生效 | 开发用 `link:`，分发用 tgz |
| 隐私 | 面板能看工作区状态 | 保持 loopback + 同源双重限制，只读 |

## 7. 决策点（开工前定，不超三项）

1. **单包合并**（推荐）还是两包并存？
2. 面板调 CLI：**spawn 包内路径**（推荐）还是 import 直调？
3. 按钮集合是否保留「继续 / 按建议执行 / 重发上一条」（不属于收尾，但与收尾同排）。

## 8. 本阶段明确不做

- ❌ push（GitHub）——等插件打磨好。
- ❌ npm publish——同上；tgz 足够自用。
- ❌ 删除 `dsh-closeout-button` 源码——合并验证通过、旧包退役后才动。
- ❌ 桌面端专属 client（托盘等）——另立阶段。

## 9. 回滚

- 合并前打 tag 或记下 `HEAD`（当前 `2c19b1a`）。
- 插件侧：`dsh plugin --profile desktop remove dsh-closeout` + 重新 `add link:...dsh-closeout-button`。
- 仓库侧：`git reset --hard <HEAD>`（未推，随时可退）。
