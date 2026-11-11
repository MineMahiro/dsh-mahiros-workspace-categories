# 兼容性说明

本文件记录 0.8.x 的跨版本 / 跨平台兼容性核对：**支持的版本窗口**、**核对方法与证据**、
**用到的 DSH 接口**、**版本引入点**和**降级行为**。0.8.1 只新增拖拽表现层
（折叠与贴边滚动，全部基于 DOM 标准的 `DragEvent` / `requestAnimationFrame`），
没有新增任何 DSH 接口依赖，因此下面的结论继续有效。

## 结论

| 项目 | 结论 |
| --- | --- |
| 声明窗口 | `DSH >= 0.2.0-rc.2 < 0.2.3-0`（`engines.dsh`） |
| 实机运行 | `0.2.1-rc.2`（Linux Host，全部功能走查） |
| 已安装 | `0.2.1-rc.5`（Windows DSH Desktop） |
| 静态核对 | `0.2.0-rc.2`、`0.2.1-rc.1` ~ `rc.5`、`0.2.2-rc.1` |
| 未声明 | `0.1.x`、`0.2.3+`、`0.3.x` |
| Node | `>= 20`（Host 半用全局 `fetch`/`Response` 与 `node:test`） |
| 平台 | Linux / macOS / Windows（路径全部走 `node:path`，写盘为「临时文件 + rename」） |

核对范围内**每个用到的接口和数据字段都存在且语义未变**；没有发现任何版本断点。
`0.1.7-rc.2` 也满足全部用到的接口，但不在声明窗口内（见「版本引入点」）。

## 为什么上限是 `<0.2.3-0`

`dsh-app-boot` 会在 profile 启动时校验 bundle 的 `engines.dsh`，**不满足会直接抛错**，
用户的唯一出路是 `dsh plugin allow-version`。而 semver 在 `includePrerelease` 下
（app-boot 的用法），`>=0.2.0-rc.2` 也会匹配 `0.2.3-rc.1`、`0.3.0-rc.1` 这些未验证版本，
所以这里显式封顶到「已验证窗口 + 0.2.2 正式版」。

另外，`engines.dsh` 存在时 app-boot **不检查 `peerDependencies`**——本项目里的 peer 段
只是文档/安装提示，不构成运行时校验。

## 核对方法

1. 用 `npm pack` 下载 `@deepseek-ai/dsh-web-app@<version>` 及其依赖的精确版本整套客户端包：
   `dsh-client-ui-workspace`、`dsh-client-ui-sidebar`、`dsh-client-ui-slots`、
   `dsh-client-ui-primitives`、`dsh-client-connection`、`dsh-client-ui-session`、
   `dsh-client-ui-renderer`、`dsh-api-workspace-controller`、`dsh-api-session-controller`、
   `dsh-home-paths`、`cordis`。
2. 先读 `.d.ts`、再读随包发布的 `lib/*.js`，逐项确认槽位契约、服务方法、快照字段、
   Fetch 路由注册选项、cordis 上下文 API 是否存在且语义未变；
   对 0.1.x 边界版本（0.1.0-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1）
   二分确认「接口首次出现的版本」。
3. 在 Linux Host（DSH 0.2.1-rc.2）实机走查：分类/归类、拖拽排序、状态汇总、
   空会话隐藏、会话重命名、归档筛选、新建工作区、`dsh-pocket` 手机端共享状态。

## 用到的 DSH 接口

以下接口在 **0.2.0-rc.2 ~ 0.2.2-rc.1** 全窗口存在且语义一致（行号为该窗口内的代表版本）：

| 接口 | 用法与证据 |
| --- | --- |
| `sidebar.workspaces`（`kind: 'single'`, `scope: 'root'`） | 由 `dsh-client-ui-sidebar` 声明的 single 槽位（`lib/types/client/contract/slots.d.ts`）；官方 `ui-workspace` 注册时不写 `priority`（隐式 0），本插件写 `priority: -100` |
| 槽位优先级语义 | 升序、最小者渲染；同 key 同优先级二次注册抛错（`dsh-client-ui-slots/lib/types/index.d.ts`）；slots 核心实现自 0.1.6-alpha.2 到 0.2.2-rc.1 字节一致 |
| `ctx.slots.inject(key, cb)` / `ctx.slots.register` | 只注册一个槽位条目；dispose 后官方浏览器恢复 |
| `workspaces` 客户端服务 | 快照 `{ items, archivedSessionIds, pinnedSessionIds, state, phase }`；命令 `create({path})`、`rename`、`delete`、`insertBefore`、`archiveSession`、`unarchiveSession`（`dsh-api-workspace-controller`）；行字段 `workspaceId/path/title/sessionIds` |
| `sessions` 客户端服务 | `list` = `ObservableSnapshot<{ ids, byId, phase }>`；行字段 `id/title?/displayTitle/cwd/parentId/origin/running/retainedBy/blank/updatedAt`（`dsh-api-session-controller`） |
| `uiWorkspace` | `openSession(id)`、`startSession(workspaceId)`、`pickDirectory()`、`listDirectory()`（`dsh-client-ui-workspace`） |
| `uiSession.sessionStatus` | `ReadonlyMap<SessionId, SessionStatus>`，状态点的数据源；`mainView` 引用来源同样存在 |
| `remote.session.rename` | Host 的 `session/rename` 命令，请求 `{sessionId,title}`、返回 `{title,seq}` |
| `connection.fetch.register` | `{ path, methods, requestBody: 'buffered', fetch }`，精确匹配 `URL.pathname`；路由必须在认证 `/api` 通道内（`dsh-client-connection`） |
| `ctx.inject(['connection'])` / `ctx.effect(fn,label)` / `ctx.logger` | Host 半的挂载方式；cordis 4.0.4 / 4.0.5 / 4.1.0 三个版本一致 |
| `$DSH_HOME` | `dsh-home-paths` 的优先级：配置值 > `DSH_HOME` 环境变量 > `~/.dsh`。本插件读环境变量；若启动器只传配置值而不导出环境变量，共享文档会落到 `~/.dsh`（与实测 Host 一致） |
| （可选）`@deepseek-ai/dsh-client-ui-primitives` | `Tooltip` / `StateDot`；在浏览器模块表里由 Web shell 播种，`require` 失败时降级为原生 `title` 与自绘状态点（已 try/catch） |
| （可选）`workspaceDefaultDirectory` | 配套目录插件暴露的官方应用内目录对话框；服务缺失时回落到官方原生选择器（`__DSH_DIRECTORY_PICKER__` → `uiWorkspace.pickDirectory()`） |

## 版本引入点（0.1.x 二分结果）

| 接口 | 首次出现 |
| --- | --- |
| `ctx.slots` 服务、`slots.inject/register`、`workspaces`/`sessions` 客户端服务 | 0.1.2-rc.1（0.1.0-rc.2 没有） |
| `ConnectionFetchMethod` 的 `POST` 与 `requestBody` | 0.1.5-rc.3（0.1.2-rc.1 只有 `GET|HEAD`） |
| `sessions.retain` / `SessionRetainOptions` | 0.1.6-alpha.2 |
| `pinnedSessionIds`、`mainView` 引用来源、`uiSession.sessionStatus` | 0.1.7-alpha.1 |
| `session/rename` Remote | 至少 0.1.2-rc.1 起 |

**本插件用到的接口没有一个是在 0.2.1-rc.1 或 0.2.2-rc.1 才出现的**，
所以 `0.2.0-rc.2` 作为下限是保守值而不是乐观值。

## 版本相关行为与降级

| 场景 | 行为 |
| --- | --- |
| Host 半升级后未重启 Host | Loader 不热替换 Host 插件：共享状态路由暂缺，浏览器半退回「仅本机 localStorage」，树照常可用；重启后自动补写发件箱 |
| 组合里没有 `workspaces` / `sessions` 控制器 | 树用空快照继续渲染（不再在首次渲染抛错——single 槽位条目抛错一次就会被摘除，直到刷新才回来） |
| `blank` / `updatedAt` 等字段将来改名 | 空会话过滤失效，这些行会重新显示（不会报错） |
| `sidebar.workspaces` 不再是 single 或 priority 语义反转 | 树不再影子官方浏览器，可能出现两个列表；需要适配槽位契约 |
| `remote.session` 不可用 | 只有会话重命名报错（树顶提示），其余功能正常 |
| 任何目录选择服务都不可用 | 只有「新建工作区」报错，其余功能正常 |
| 没有 `@deepseek-ai/dsh-client-ui-primitives` | 悬浮提示退回原生 `title`、状态点退回自绘样式 |
| 同时安装原版 `dsh-workspace-categories` | patch 的 `disabled` 守卫让本插件让位，避免同槽位同优先级双注册；两者不要同时启用 |
| 0.2.3+ / 0.3.x | 未验证，且被 `engines.dsh` 明确挡住；若未来放开，优先复核 slot 契约与 `sessions` 行字段 |

## 与其它插件

- **官方 `ui-workspace`**：不禁用、不修改；只影子其槽位条目，dispose 即恢复。
- **原版 `dsh-workspace-categories`**：互斥（同一单槽位、同为 `-100`）；两个包都装时
  本插件的 patch 守卫检测到上游包名后自动禁用自己。
- **配套目录插件**（暴露 `workspaceDefaultDirectory` 的插件）：按需查找、可独立启用/禁用；
  本插件不自绘目录对话框，也不抢占 `shell.overlay`。
- **命名空间**：CSS 前缀 `twt-`、样式节点 id `dsh-mahiros-workspace-categories/styles`、
  路由 `/api/workspace-categories.state`、localStorage 键 `dsh.workspace-tree.state.*`
  （沿用上游键名，便于从原版平滑迁移），均不与其它插件共享。

## 证据位置（下载的 npm 包内）

- `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`：`sidebar.workspaces` 为 `single`；
  `SidebarSectionOwnerProps = { wide, expandSidebar }`。
- `dsh-client-ui-workspace/lib/client.js`：官方注册 `sidebar.workspaces` 时不带 `priority`。
- `dsh-client-ui-slots/lib/index.js`：`options.priority ?? 0`、同优先级抛错、升序取首个非让位条目。
- `dsh-client-ui-renderer/lib/types/client/registry.d.ts`：`slots.inject(key, cb)`。
- `dsh-api-workspace-controller/lib/types/client/{model,service}.d.ts` 与 `lib/types/types.d.ts`。
- `dsh-api-session-controller/lib/types/client/{contract/sessions,sessions/service}.d.ts`。
- `dsh-client-connection/lib/types/rpc.d.ts` 与 `lib/index.js`（精确路由匹配、`assertFetchRoute`）。
- `dsh-home-paths/lib/index.js`（`DSH_HOME_ENV`、优先级）。
- `cordis/lib/types/{context,fiber,registry}.d.ts`（`logger` / `effect` / `inject`）。
