# AGENTS.md — 面向 agent 的仓库说明

本文件写给 **修改本仓库的 AI agent**。人类用户读 [`README.md`](./README.md) 即可。
项目是 DeepSeek Harness（DSH）的插件：把左侧栏工作区浏览器换成「分类 > 工作区 > 会话」树，
并通过 Host 侧共享文档让桌面与 `dsh-pocket` 手机端看到同一棵树。

## 来源与身份

- 上游：`dsh-workspace-categories` by knight（MIT，<https://github.com/Knight-Zjy/dsh-workspace-categories>）。
  本仓库是其 fork，`NOTICE` 记录了改动范围；**永远不要删除 `LICENSE` 里的上游版权行**。
- 发布名：`dsh-mahiros-workspace-categories`。没有构建步骤：Host 半是普通 ESM，
  浏览器半是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle。

## 目录

| 路径 | 作用 |
| --- | --- |
| `package.json` | 包元数据；`dsh.bundle.patch` 指向 bundle patch，`dsh.client` 声明浏览器半 |
| `cordis.patch.yml` | bundle 层 patch：`insert` 一条 loader 条目（id `mahiro-workspace-tree`） |
| `lib/index.js` | Host 入口：`export const name` + `apply(ctx)`，在 `connection` 服务上挂认证 `/api` 路由 |
| `lib/state-store.js` | 共享文档：校验、操作应用、原子落盘、`rev` 递增、`$DSH_HOME` 解析 |
| `lib/state-routes.js` | 精确 Fetch 路由 `GET\|POST /api/workspace-categories.state` 的契约 |
| `lib/client.js` | 浏览器半：全部树 UI + 同步引擎（约 3.2k 行，含 CSS 字符串） |
| `locale/*.json` | 插件市场展示的标题/描述 |
| `test/*.test.js` | 无依赖单测（`node --test`），含发布守卫与拖拽行为 |
| `test-harness/bundle.js` | 客户端单测共用的 VM + React 替身加载器（不在 `test/` 下，避免被 `node --test` 当作用例文件） |
| `icon.svg` | 插件图标 |

## 不可破坏的约定（测试会钉住）

1. **身份四处一致**：`package.json.name` = `lib/index.js` 的 `name` 导出 =
   `cordis.patch.yml` 里 loader 条目的 `name` = 浏览器 bundle 的 `id`。
   改包名时四处一起改，并同步 `local:registrant`、`STYLE_ID`、日志前缀。
2. **loader 行 id 用 `mahiro-workspace-tree`**，不要用上游的 `workspace-tree`：
   两个 bundle 同时安装时，同 id 的 `insert` 会撞车。
3. **`disabled` 守卫必须同时识别两个包名**（本 fork 与上游）：两者都以
   `priority: -100` 注册 `sidebar.workspaces` 单槽位，同优先级双注册是非法状态。
4. **冻结的数据契约**（改它们必须同时写迁移和测试）：
   - `localStorage` 键 `dsh.workspace-tree.state.v1` / `.v2`；
   - Host 路由 `/api/workspace-categories.state`；浏览器半的 `SYNC_PATH`
     必须逐字等于 `STATE_ROUTE_PATH`；
   - 共享文档 `$DSH_HOME/workspace-categories/state.json`（`version: 1`）；
   - CSS 前缀 `twt-`、拖拽 MIME `application/x-dsh-workspace|session|category`。
5. **浏览器半的形态**：不是 ESM；顶层只能有 `window.__ModuleLoader__.load(...)`；
   factory 内只允许 `require` 平台种子（`react`、可选的
   `@deepseek-ai/dsh-client-ui-primitives`），其它能力一律 `ctx.get(...)` 延迟取；
   不要出现 `import`/`export` 语法。
6. **只注册一个 `sidebar.workspaces` 槽位条目**（`inject = ['slots']`，
   `priority: -100`）。不要再注册第二个浏览器、`shell.overlay` 对话框或底栏开关。
   槽位 dispose 后官方浏览器必须立刻回来。
7. **Host 半在没有 `connection` 的组合里必须静默不挂**；路由必须留在 `/api` 通道内
   （认证 cookie 由该通道提供，手机经 `dsh-pocket` 代理也走同一条）。
8. **新建工作区的目录来源顺序**：`workspaceDefaultDirectory` 服务（配套目录插件，
   官方应用内对话框）→ 桌面注入的 `__DSH_DIRECTORY_PICKER__` →
   `uiWorkspace.pickDirectory()`。任何情况下都不自绘目录对话框。
9. **空会话清理只能是视图过滤**：DSH 没有删除会话的 API，不得自动归档/删除任何会话日志；
   保留条件（主视图打开、有草稿、<2 分钟、运行中、已改名）由 `isEmptySession` 单测钉住。
10. **拖拽折叠只能是视图叠加**：拖动期间的自动收起由 `dragFoldOf(dragState)` 推导
   （category → 收起全部类别，workspace → 收起全部工作区，session → 不收起），
   **不得写入 `localState.collapsed/expanded` 或持久化**，否则松手后恢复不了拖动前的状态；
   拖拽结束必须回到拖动前的展开布局（`test/drag.test.js` 钉住）。
11. **贴边滚动只滚动 `.twt-scroll`**：`autoScrollStep` 是纯函数（边缘带 36px、每帧最多 16px、
   指针在列表水平范围外不动），帧循环用 `requestAnimationFrame` 且必须在 drop/dragend/
   移出窗口/到头时停掉；不要退回整页滚动或改变行高。
12. **`dragstart` 里不得同步改 DOM / state**：Chromium 会在 dragstart 处理器改动 DOM 后立刻取消拖动
   （几像素后 `dragend`，永远收不到 `drop`）。拖拽表现（折叠、投放栏）必须经 `armDrag` 推迟到
   下一个任务，且 `endDrag` 要用 token + 清定时器取消未执行的 arming；行与投放区要同时
   `onDragEnter`/`onDragOver` cancel 事件，快速松手也能落到目标上。
13. **拖拽投放区必须复用行内动作**：树顶「取消 / 删除」只在 `dragState` 非空时渲染；
   「取消」只 `endDrag`（不产生任何 op），「删除」调用 `deleteCategory` /
   `deleteWorkspace` / `archiveSession`（确认与撤销沿用原流程，不另写删除实现）。
   投放区是 `drop` 目标而非按钮，指针悬停时不得触发贴边滚动（autoscroll 里按 `dropBarRef`
   的 `contains` 判断）。

## 兼容性规则

- `engines.dsh: ">=0.2.0-rc.2 <0.2.3-0"`（app-boot 对不匹配的 engines 直接抛错，因此必须封顶到
  已验证窗口；当前窗口 = 0.2.0-rc.2 至 0.2.2-rc.1）。实机：0.2.1-rc.2（Linux Host）；
  已安装：0.2.1-rc.5（Windows Desktop）；其余窗口内版本为静态核对。接口清单、证据与降级方式见
  [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md)；扩大窗口前先按该文件的方法重新核对。
- `engines.dsh` 存在时 app-boot **忽略 `peerDependencies`**：peer 段只是安装提示，不要把它当运行时校验。
  `@deepseek-ai/dsh-client-ui-slots` 在任何 DSH 版本里都不作为包安装、本插件也未 import，已从 peer 里移除。
- `peerDependencies` 跟随平台包版本；平台可缺省的包放进 `peerDependenciesMeta`（如
  `dsh-client-ui-primitives`），代码必须对 `require` 失败降级。
- **不要新增运行依赖**：Host 侧保持零依赖（单测无需 install）；浏览器侧除平台种子外不 require 任何包。
- 跨平台：路径只用 `node:path`；写盘用「临时文件 + rename」；测试在 `win32` 跳过依赖 POSIX
  权限的用例；`DSH_HOME` 允许任意绝对路径（含 Windows 盘符 / 尾部分隔符）。
- **禁止硬编码**：端口、回环地址、用户名、盘符、发行版的 profile 名。
  测试里的假 origin 用 `http://harness.invalid`；`test/package.test.js` 会扫描发布文件。

## 验证

```bash
node --version            # >= 20
npm test                  # 即 node --test（无参数自动发现 test/*.test.js），无需 install
npm pack --dry-run        # 发布内容必须含 lib/ locale/ cordis.patch.yml icon.svg README LICENSE NOTICE
```

- 真实 UI 验证：把本目录 link 进目标 profile 的 `node_modules` 并把包名加入
  `dsh.profile.bundles`，刷新页面即可；**Host 半改动需要重启 Host**。
- 不要在 DSH 自己托管的 agent 会话里重启该 Host（会杀掉会话）——重启交给用户。
- 客户端单测在 VM 里加载真实 `lib/client.js`（假 React），新增模型逻辑请导出到
  `exports.__syncModel` 并写测试；Host 侧逻辑直接 import。需要真实交互（状态更新后重渲染、
  effect、拖拽事件）的用例用 `test-harness/bundle.js` 注入带状态的 React 替身，
  `test/drag.test.js` 是范例。

## 发布清单

1. 改 `package.json` 的 `version`；在 `CHANGELOG.md` 顶部加条目；README 尽量写不依赖版本号的安装方式。
2. `npm test` 全绿。
3. `npm pack --pack-destination dist/`，产出 `dsh-mahiros-workspace-categories-<version>.tgz`。
4. `git tag v<version> && git push origin main --tags`。
5. 在 GitHub Release 附上该 tgz（README 的安装命令引用它）。

## 风格

- 用户可见文案用中文；代码注释用英文，沿用现有「长 why 注释」风格。
- 不改与任务无关的 CSS/交互；不引入旋转动画（本 fork 刻意移除了 `twt-busy`，状态点转圈除外）。
