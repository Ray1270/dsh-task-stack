# @ray1270/dsh-task-stack

[![npm version](https://img.shields.io/npm/v/@ray1270/dsh-task-stack.svg)](https://www.npmjs.com/package/@ray1270/dsh-task-stack)
[![license](https://img.shields.io/npm/l/@ray1270/dsh-task-stack.svg)](LICENSE)
[![CI](https://github.com/Ray1270/dsh-task-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/Ray1270/dsh-task-stack/actions/workflows/ci.yml)

给 DeepSeek Harness Agent 用的**可持久化任务栈**：Agent 显式调用三个工具来 push / pop / 查看自己的多步任务焦点，状态以纯文本 JSON 落在会话工作区里。

- **跨上下文压缩存活** —— 状态在磁盘上，压缩掉对话也不丢
- **跨会话恢复可找回** —— 同一 `sessionId` + `cwd` 重新挂载即读回同一份文件
- **零自动注入** —— 不写系统提示词、不注入上下文，Agent 不主动调用就一个 token 都不花

```
focus_task("给 CLI 加 JSON 导入命令")
   └─ 遇到需要单独完成的多步目标 → focus_task("顺便把导入的错误提示改掉")
        └─ focus_complete("错误提示已改，附带单测")
   ← 栈顶回到 "给 CLI 加 JSON 导入命令"，重新变 active
focus_complete("导入命令已加，冒烟测试通过")
```

## 三个工具

模型看到的描述都按「什么时候该用 / 什么时候不该用 / 返回什么」写。

### `focus_task(description)`

把一行任务描述压到栈顶；原先 active 的任务自动变 `paused`。返回新的栈深度与栈顶任务。

- **该用**：用户要的东西需要好几步才能交付，尤其是一个请求里有多个可分离目标时。推**你最外层要对用户负责的那个目标**，不是你自己计划的每一步。
- **不该用**：单轮问答；栈顶任务内部的例行步骤；复述用户消息。
- 栈到达 `maxStackDepth` 时**拒绝**并说明原因，不抛异常。

### `focus_complete(conclusion)`

弹出栈顶任务，记下一行结论，下面那个任务重新变 active。返回被关闭的任务、重新激活的任务、剩余深度。

- **该用**：栈顶任务的多步工作完成、产物**已经落地**时，且在写最终答复之前调用——这样之后即使发生上下文压缩，也能看到已关闭的结论。
- **不该用**：放弃、暂停、改名。目标变了应该改述栈顶任务，而不是把它挂着。
- 空栈时**拒绝**并提示：说明这次工作根本没 push 过任务。

### `read_focus()`

以 markdown 返回完整栈（active + paused）与最近若干条已完成记录。

- **该用**：上下文压缩之后、恢复会话时、用户问「你现在在做什么」时、决定该 push 还是 complete 之前。
- **不该用**：每一步之后都调。你自己近几轮还看得到焦点时就别花 token。
- 因为本插件不注入提示词，**这是唯一能看到任务栈的办法**。

## `/focus` 斜杠命令（人用，不花模型 token）

除了三个工具，插件还注册一个 `/focus` 命令，直接作用于当前会话的任务栈——排查问题或手工收尾时不用消耗一轮对话。

| 输入 | 作用 |
| --- | --- |
| `/focus` | 打印任务栈（active/paused 标注 + 深度）与最近历史 |
| `/focus done <结论>` | 关闭栈顶任务并把结论写进 history，等价于一次 `focus_complete` |
| `/focus clear` | 清空整个栈，**每个被清的任务都会记入 history**（结论为 `cleared via /focus`），不会静默丢失 |

`/focus clear` 是幂等的：空栈时回一句"已经是空的"，不算错误。`/focus done` 空栈时会明确告诉你栈是空的——那是"没 push 过任务"的信号，而不是需要重试。

## 安装

### 方式 A：作为 profile bundle 安装（常规使用）

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile desktop add @ray1270/dsh-task-stack

# 或者克隆仓库后按本地目录安装（适合要改源码时）
git clone https://github.com/Ray1270/dsh-task-stack.git
cd dsh-task-stack
dsh plugin --profile desktop add $pwd
```

`dsh plugin add` 会把包装进 profile 的 `node_modules` 并把它登记进该 profile `package.json` 的 `dsh.profile.bundles`。profile 应用本包自带的 [cordis.patch.yml](cordis.patch.yml)，其中的加载行 `name: @ray1270/dsh-task-stack` 就从 profile 的 `node_modules` 解析。**重启 DSH Desktop 后**新会话即可直接让模型调用这三个工具、使用 `/focus`。

若不想走包管理器安装，也可以手工两步（等价）。在**克隆出来的仓库根目录**里执行：

```powershell
# 1) 建 junction，让 profile 能按包名解析到这个目录
$plugin = (Get-Location).Path
$link   = "$env:DSH_HOME\profiles\desktop\node_modules\@ray1270\dsh-task-stack"
New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
cmd /c mklink /J "$link" "$plugin"

# 2) 编辑 $env:DSH_HOME\profiles\desktop\package.json，
#    在 dsh.profile.bundles 数组里加一项 "@ray1270/dsh-task-stack"
```

> 不要写 `"dependencies": { "@ray1270/dsh-task-stack": "link:...." }`：profile 在 C: 而插件在 D:，`path.resolve` 到盘根就停，**多少个 `..` 都跨不了盘**，一条解析不了的 `link:` 会让以后的 `pnpm install` 直接失败。Bundle 靠 profile `node_modules` 里的 junction 解析，不需要依赖项。

### 方式 B：免安装的临时 overlay（开发调试）

```powershell
# 注意 --patch 属于启动器：必须写在 profile 名之前
dsh --profile web --patch ".\dev.patch.yml" --no-open
```

[dev.patch.yml](dev.patch.yml) 用 `name: ./lib/index.js`，由加载器改写成 patch 文件旁边的 `file://` URL，因此**不需要安装、不需要 node_modules 解析**。`cordis.patch.yml` 用的裸包名只在包已安装（或可被 `node_modules` 解析）时才有效。

> 两个坑：
> - `dsh web --patch x.yml` 是错的（`web` 子命令不认识 `--patch`），要写 `dsh --profile web --patch x.yml`。
> - patch 行里的相对目录（`name: ./`）也不行：Node 对目录 URL 抛 `ERR_UNSUPPORTED_DIR_IMPORT`，且 `file:` 说明符不走 `exports`。

## HTTP 快照端点（Web 侧栏数据面）

在 **Web 组合**（`dsh --profile web`）里，插件会额外注册一个只读端点，供 GUI 面板读取任务栈：

```
GET /api/dsh-task-stack/snapshot?sessionId=<id>&cwd=<绝对路径>
```

返回：

```json
{
  "sessionId": "session-…",
  "cwd": "D:\\…",
  "depth": 2,
  "top": { "id": "task-…", "description": "…", "status": "active", "createdAt": "…" },
  "stack": [ /* 最深在前，栈顶在最后 */ ],
  "history": [ /* 最旧在前 */ ],
  "warnings": []
}
```

行为约定：

| 情况 | 响应 |
|---|---|
| 正常 | `200` + JSON，`cache-control: no-store` |
| 未认证（无浏览器 cookie）/ Host 不在信任范围 | `401` / `403` |
| 组合里没有 `connection` 服务（无法鉴权） | `503`，**失败关闭**而不是无鉴权放行 |
| 缺 `sessionId`、`cwd` 非绝对路径 | `400` |
| 非 `GET`/`HEAD` | `405` + `Allow` |
| 会话没有状态文件 | `200`，`depth: 0` 的空栈（不是 404） |

三点实现说明：

- **它不继承栅栏。** raw WebServer 路由不吃 `connection` 的鉴权，所以端点自己调 `connection.requestRejection(req)`——与第一方 API 同一道 Host/Origin + 浏览器 cookie 校验。**这条路径实测过**：带 cookie 200、匿名 401。
- **只读。** 端点只暴露 `getSnapshot`；关闭任务仍走 `focus_complete` 或 `/focus`。写入面需要单独的安全设计，不在本版本内。
- **可选激活。** `webServer` / `connection` 都不写进 `inject`（终端与 headless 组合没有它们，硬依赖会让插件整个 pending），而是用 `ctx.inject(['webServer'], …)` **等服务出现**后再注册；`connection` 在**每次请求时**解析——两者都 `inject: [webRuntime]`，激活顺序不定，捕获一次会把 `undefined` 存下来（这个 bug 我踩过，表现为端点一直 503）。

手动验证（宿主起来后）：

```powershell
# 1) 用启动时打印的 URL 换浏览器 cookie（303 + Set-Cookie）
curl.exe -i "http://127.0.0.1:3080/?token=<token>"

# 2) 带 cookie 请求快照
curl.exe "http://127.0.0.1:3080/api/dsh-task-stack/snapshot?sessionId=<id>&cwd=D%3A%5Cpath" -H "Cookie: dsh-auth-…=…"

# 3) 不带 cookie 必须被拒
curl.exe -i "http://127.0.0.1:3080/api/dsh-task-stack/snapshot?sessionId=<id>"
```

## 配置

在 profile patch 层的该行 `config:` 下配置，全部可选；Cordis 会在插件启动**之前**校验，越界直接拒绝加载该插件并在启动日志里指出字段（不会静默夹紧成另一个策略）。

| 字段 | 默认 | 约束 | 含义 |
| --- | --- | --- | --- |
| `stateDir` | `.dsh/task-stack` | 非空、**相对**路径 | 状态文件目录，相对会话工作区 |
| `maxStackDepth` | `20` | 整数 ≥ 1 | 栈上最多同时开着的任务数；超过则 `focus_task` 拒绝 |
| `historyLimit` | `100` | 整数 ≥ 1 | `history` 最多保留多少条完成记录，从最旧的开始裁剪 |
| `statePruneDays` | `0` | 整数 ≥ 0（0 = 不清理） | 插件加载时删除超过这么多天没写过的会话状态文件 |

```yaml
- insert:
    - id: @ray1270/dsh-task-stack
      name: @ray1270/dsh-task-stack
      config:
        stateDir: .dsh/task-stack
        maxStackDepth: 20
        historyLimit: 100
        statePruneDays: 30      # 可选：清掉一个月没动过的会话
```

`statePruneDays` 是**尽力而为**的维护动作，以 `process.cwd()` 为工作区、在插件加载后异步执行，只删 `stateDir` 里直接存放的 `*.json`：

- 文件的 mtime 就是它最后一次写入时间；
- 目录不存在、没有任何文件要删 → 静默跳过，不是错误；
- 崩在写入中途留下的 `*.tmp` **不删**（留给人工注意）；
- 每个删除都走同一把 per-file 锁，不会和正在进行的 read-modify-write 交错；
- 清理慢或失败只写一行日志，绝不影响插件激活。

## 状态文件

路径：`<session-cwd>/<stateDir>/<sessionId>.json`，一个会话一个文件，同工作区的不同会话互不干扰。

```json
{
  "version": 1,
  "sessionId": "session-087e04a2-f613-413f-ab38-e3a3ff2f1e75",
  "stack": [
    {
      "id": "task-35e0216c-75cc-472c-8e89-1fbbc05b1ac9",
      "description": "给 CLI 加 JSON 导入命令",
      "createdAt": "2026-10-01T07:24:46.200Z",
      "status": "active"
    }
  ],
  "history": [
    {
      "id": "task-c28dd757-3568-4ccb-a3b7-0ea05b81bccb",
      "description": "重写导入的错误提示",
      "conclusion": "错误提示已改，附带单测",
      "createdAt": "2026-10-01T07:24:46.208Z",
      "completedAt": "2026-10-01T07:24:46.214Z"
    }
  ]
}
```

- `stack` 里恰好只有一个 `status: "active"`（栈顶）；读到的文件若有多个 active，会被就地修复
- 写入是**原子**的：先写 `<file>.<pid>.<n>.tmp` → `fsync` → `rename` 覆盖，读者只会看到完整的旧文档或新文档，崩溃也不会留半截 JSON
- 同一文件的读写用 **per-file 异步锁**（promise 链）串行化，不同文件互不阻塞
- 文件缺失按空栈处理（不算警告）；读失败 / JSON 坏 / 版本不符 / 会话不符 / 帧结构坏 → 退化成空栈或丢弃坏帧，附一条 `warnings` 且**从不抛异常**

## 开发与验证

```powershell
# 在克隆出来的仓库根目录里执行
pnpm typecheck        # tsc strict（含 noUncheckedIndexedAccess / exactOptionalPropertyTypes）
pnpm build            # tsc + 产物自检
pnpm test             # 69 项：store 22 + tools 18 + config 12 + commands 13 + lifecycle 4 + demo
pnpm demo             # 真实 ToolRuntime 里把三个工具与 /focus 跑一遍，打印 markdown 与落盘文件
pnpm probe            # 无宿主装载：真 Cordis Context + 注册面断言 + 全生命周期实跑
```

| 脚本 | 覆盖 |
| --- | --- |
| [scripts/test-store.mjs](scripts/test-store.mjs) | 路径解析、文档结构、push/pop 语义、栈满/空栈、history 裁剪、200 并发压测无丢失无 `.tmp` 残留、坏 JSON/坏版本/坏帧/串会话降级、`prune` 阈值与边界、`clearStack` 幂等 |
| [scripts/test-tools.mjs](scripts/test-tools.mjs) | 三个 `defineTool` 契约、参数校验（空串/错类型/缺参）、无 agent 报错、渲染 markdown、**拒绝路径的渲染**、history 裁剪对模型可见 |
| [scripts/test-config.mjs](scripts/test-config.mjs) | Config schema 默认值/越界拒绝/JSON schema、自定义 `stateDir`/`maxStackDepth`/`historyLimit` 端到端生效、手写坏文件不崩、`statePruneDays` 真的在加载时清理（子进程换 cwd 测） |
| [scripts/test-commands.mjs](scripts/test-commands.mjs) | `/focus` 的三种输入与全部拒绝路径、命令与工具共用同一份状态、坏文件降级为 warning |
| [scripts/test-lifecycle.mjs](scripts/test-lifecycle.mjs) | 用**真实 `ToolRuntime`** + 真实子 fiber：加载→卸载→重载无残留、无 "already registered"、store 可重建 |
| [scripts/demo.mjs](scripts/demo.mjs) | 可读演示：真 registry 上跑完整生命周期与 `/focus`，打印模型侧 markdown 与状态文件 |
| [scripts/probe-load.mjs](scripts/probe-load.mjs) | 真实 Cordis `Context` 里 `apply`，断言三个工具 + `/focus` 都注册，并实跑一次完整生命周期 |

宿主侧的 loader 集成由工作区根目录的 [../loader-harness.mjs](../loader-harness.mjs) 验证（走真 `@deepseek-ai/cordis-plugin-loader`，四种模式：裸名/相对/坏锚点/非法配置）。

## 发布

```powershell
# 0) 本地全绿（prepublishOnly 也会再跑一遍 build + test）
pnpm build && pnpm test

# 1) 登录（首次）
npm login

# 2) 预览包里到底装了什么，并让发布闸门跑一遍（不发布）
npm pack --dry-run

# 3) 发布
npm publish --access public      # scope 包首次发布必须显式 --access public
```

要点：

- **发布闸门挂在 `prepack` 上**（`pack` 与 `publish` 都会触发），由 [scripts/release-check.mjs](scripts/release-check.mjs) 用**纯 Node 顺序跑 10 步**：typecheck → build → check-build → probe → 五套测试 → demo。它**不调用任何包管理器**，所以不会被 PATH 上那个会写 crashpad 日志并异常退出的 pnpm 干扰；任一步失败会以自己的输出退出，`npm publish` 会如实报出真正的原因。
- 想单独跑闸门：`node scripts/release-check.mjs`；
- `files` 只包含 `lib`、两份 patch、`README.md`——**`src` 与 `scripts` 不进包**（`lib` 由闸门里的 build 步骤保证是最新的）；
- 包名与 [cordis.patch.yml](cordis.patch.yml) 里的加载行 `name` **必须一致**，否则 profile 装了也解析不到。工作区根目录的 `rename-package.mjs` 会一次性同步所有出现位置并校验（含 YAML 引号，以及"目录名必须保持裸名"的断言）；
- 版本按 semver：修 bug 走 patch，新增工具/命令走 minor，改配置语义走 major；
- 首次发布后别人这样装：`dsh plugin --profile <名称> add @ray1270/dsh-task-stack`。

## 兼容性

- DSH：`0.2.0-rc.2`（开发与验证所用版本）
- 依赖：`@deepseek-ai/cordis ^4.0.2`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/schemastery ^3.18.2`（均为 peerDependencies，由宿主在运行时提供）
- 不注册任何 prompt section、不做自动注入

## 项目结构

```
dsh-task-stack/
├── package.json              # dsh.bundle 声明；peerDependencies 声明宿主依赖
├── cordis.patch.yml          # bundle 加载行（包名，随安装生效）
├── dev.patch.yml             # 免安装 overlay（./lib/index.js，随 --patch 生效）
├── tsconfig.json
├── LICENSE                   # MIT
├── .github/workflows/ci.yml  # 每次 push 跑同一个发布闸门
├── src/
│   ├── index.ts              # 插件入口：name / inject / Config / apply
│   ├── tools.ts              # 三个 defineTool：描述、schema、渲染、执行
│   ├── commands.ts           # /focus 斜杠命令
│   ├── store.ts              # 路径解析 + 原子写入 + per-file 锁 + 容错读取
│   └── types.ts              # 共享类型与默认值
└── scripts/
    ├── release-check.mjs     # 发布闸门：10 步顺序执行（CI 与 prepack 共用）
    ├── test-store.mjs        # 状态层 22 项
    ├── test-tools.mjs        # 工具层 18 项
    ├── test-config.mjs       # 配置与边界 12 项
    ├── test-commands.mjs     # /focus 13 项
    ├── test-lifecycle.mjs    # 真实 ToolRuntime 卸载/重载 4 项
    ├── probe-load.mjs        # 无宿主装载 + 全生命周期实跑
    ├── demo.mjs              # 可读演示
    └── check-build.mjs       # 构建产物自检
```

## 许可

MIT
