# 更新日志

版本号与 npm 上的一致。对使用者有意义的变化写在这里，纯内部的工程改动单独归入「工程」，不和功能混在一起。

这个文件不只是给人看的：`scripts/release-notes.mjs` 会把对应版本的这一节取出来，作为 GitHub Release 的正文；发布闸门里也有一步 `release-notes`，发版前如果当前版本没有小节，闸门直接失败 —— 免得又发一个只有 `Full Changelog` 一行的 Release。

## 0.3.0 — 2026-11-05

### 新增

- **Web GUI 只读侧栏面板「任务栈」**。侧栏多一个入口，点开是当前会话的栈：active 任务、它下面 paused 的任务、最近完成的若干条，按几秒一次轮询快照端点刷新。侧栏行和它打开的页面共用一个 id，两处指向同一个视图。
- 面板自己解释自己：图例、中文分区标题、深度徽标、相对时间（「3 分钟前」），读者不必先记住每种颜色的含义。
- 面板**只读**：关任务仍然只走模型工具和 `/focus`。GUI 的写路径需要单独的授权故事，这一版刻意没有引入。

### 修复

- **paused 行按帧自身的状态分组**。此前按「这一行是否等于栈顶视图的同一个对象」来判断，而线上文档把 `top` 作为**同一帧的第二个视图对象**发出，于是每一行都不等于它，active 任务被当成 paused 又列了一遍。改为直接读 `frame.status`。
- **声明 `engines.dsh` 支持区间**。宿主升到 dsh `0.2.1-rc.2` 后本包被静默跳过：manifest 没有 `engines.dsh` 时兼容性判断回落到 peer 里精确 pin 的 rc 版本，日志只有一行 `skipping profile bundle`，工具、`/focus`、端点、面板一起消失且没有任何报错。现在由 `engines.dsh: >=0.2.0-rc.2 <0.3.0` 单独裁决（检查带 prerelease 语义，两个 rc 都满足，将来的 0.3 仍会被拒），两个 peer 区间同步放宽。

### 工程

- 发布改用 npm **trusted publishing**（OIDC）：仓库里不再有长期 token，凭据随 job 结束失效，并自动附带 provenance 证明。
- 发布失败时把日志尾部作为 check-run annotation 抛出；403 里出现 `OIDC permission denied` 时直接指向 trusted publisher 的 Allowed actions 配置，而不是让人去核对 owner/repo/workflow 三个字段。
- Release 只在版本 tag 上创建：手动 dispatch 曾把分支名当 tag，造出一个游离的 `main` release 和 tag。
- store 测试里「某路径是不是绝对路径」改为向平台询问，不再把 Windows 的形式当作唯一答案 —— 这条断言在 Linux runner 上第一次才真正生效。
- 客户端 bundle 是手写的 `createElement`，构建时不转译，被 review 的文件就是浏览器执行的文件；构建脚本会拒绝不解析、没调用 `__ModuleLoader__.load`、或用别的 id 注册的 bundle。

## 0.2.0 — 2026-10-04

### 新增

- **Web 端只读 JSON 快照端点** `GET /api/dsh-task-stack/snapshot`，0.3.0 面板的数据来源。只在 composition 提供 `webServer` 时注册。
- 端点与一方 API 用同一道 `connection.requestRejection()` 栅栏：裸 `webServer` 路由不继承它，跳过就会把会话状态暴露给浏览器打开的任何页面（CSRF），或暴露给重绑定的域名。
- 端点只暴露 `getSnapshot`，没有任何改栈能力；会话的工作区由宿主自己的会话登记表解析，`cwd` 查询参数只是回退。

### 文档

- 安装说明改为对任何克隆仓库的人都成立，清掉最后一批本地路径残留。

## 0.1.1 — 2026-10-01

### 工程

- CI 在每次 push 上跑完整发布闸门。
- README 加上版本、许可与 CI 徽章。

## 0.1.0 — 2026-10-01

首个版本。

- 三个工具：`focus_task` / `focus_complete` / `read_focus`。
- `/focus` 命令：查看栈、`done <结论>`、`clear`（`clear` 清掉的每一项都记进 history，结论为 `cleared via /focus`，不会静默丢失）。
- 状态按会话落到 `<workspace>/.dsh/task-stack/<sessionId>.json`：跨上下文压缩存活，零自动注入。
