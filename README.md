# dsh-mahiros-workspace-categories

中文版 · [English](./README.en.md)

**状态**：稳定（0.8.x）· **适用**：DeepSeek Harness `>= 0.2.0-rc.2 < 0.2.3`、Node `>= 20`、Linux / macOS / Windows

**项目简介**：把 DSH 左侧栏的工作区浏览器换成「分类 > 工作区 > 会话」三级树。  
分类、归类与会话手动顺序存放在 Host 侧共享文档里，桌面浏览器与 `dsh-pocket` 手机端看到同一棵树。  
分类、工作区、会话都能拖拽排序与原地重命名；拖动时自动收起下层、贴边滚动，树顶提供「取消 / 删除」投放区。  
不修改官方插件：以 `priority: -100` 影子 `sidebar.workspaces` 槽位，禁用本插件即恢复官方浏览器。

```text
分类 A                    ← 自建分类，可拖拽排序
  └ 工作区 A-1   +  ·  3  ← 会话数 / 新建会话 / 折叠后汇总状态
      └ 会话 1
      └ 会话 2
未分类                    ← 未归类的工作区，常驻拖放目标
  └ 工作区 B
```

**目录**：
- [快速开始](#快速开始)
- [其他方案](#其他方案)
- [注意事项](#注意事项)
- [详细介绍](#详细介绍)
- [常见问题](#常见问题)
- [兼容性](#兼容性)
- [仓库结构](#仓库结构)
- [路线图](#路线图)
- [免责声明](#免责声明)
- [许可声明](#许可声明)

## 快速开始

| 步骤 | 操作 |
| --- | --- |
| 1 | 确认 DSH `>= 0.2.0-rc.2`、Node `>= 20` |
| 2 | 安装插件（命令见下） |
| 3 | 在「设置 → 插件」确认已启用，重启一次 DSH |
| 4 | 展开左侧栏，工作区列表变为分类树 |

```bash
dsh plugin --profile <profile> add \
  https://github.com/MineMahiro/dsh-mahiros-workspace-categories/releases/download/v0.8.3/dsh-mahiros-workspace-categories-0.8.3.tgz
```

`<profile>` 换成目标 profile 名（常见是 `web` 或 `desktop`）。这一步等价于把包名 `dsh-mahiros-workspace-categories` 加入该 profile 的 `dsh.profile.bundles`，也可以在「设置 → 插件」里确认或禁用。  
首次启用必须重启一次 DSH；之后升级只刷新页面即可生效（Host 半改动仍需重启 Host）。  
插件把「分类 > 工作区 > 会话」树作为唯一的工作区浏览器，不再显示官方列表；禁用或卸载后官方浏览器立刻回来。

## 其他方案

**源码安装**：需要改代码或跟随 `main` 分支时，克隆仓库后本地安装。

```bash
git clone https://github.com/MineMahiro/dsh-mahiros-workspace-categories.git
dsh plugin --profile <profile> add ./dsh-mahiros-workspace-categories
```

**手动安装 tgz**：先下载 Release 附件，再从本地路径安装（适合离线或固定版本）。

```bash
curl -L -o dsh-mahiros-workspace-categories-0.8.3.tgz \
  https://github.com/MineMahiro/dsh-mahiros-workspace-categories/releases/download/v0.8.3/dsh-mahiros-workspace-categories-0.8.3.tgz
dsh plugin --profile <profile> add ./dsh-mahiros-workspace-categories-0.8.3.tgz
```

两种方式装完都要在「设置 → 插件」确认已启用并重启一次 DSH。

## 注意事项

1. **与上游插件互斥**  
   不要同时启用 `dsh-workspace-categories`：两者都以 `priority: -100` 注册 `sidebar.workspaces` 单槽位，同时安装时本插件的 patch 守卫会让位（不会双注册），但请只保留一个。
2. **Host 半改动需重启 Host**  
   浏览器半刷新页面即生效；Host 半（共享状态路由）改动后需要重启一次 Host。不要在托管当前页面的 DSH 会话里重启该 Host，交给用户手动重启。
3. **不要删除官方插件**  
   官方 `ui-workspace` 保持安装与启用；本插件只是槽位影子，禁用或卸载后官方浏览器自动恢复。
4. **共享文档要一起备份**  
   分类与归类在 `$DSH_HOME/workspace-categories/state.json`；文件损坏时会先改名为 `state.json.bad-<时间戳>` 再重建。备份时请连该文件一起备份。
5. **手机上不能拖动**  
   触屏浏览器不派发 HTML5 拖拽事件，手机端只显示桌面排好的顺序。
6. **空会话只隐藏不删除**  
   这是视图过滤：DSH 没有删除会话的接口，会话日志仍留在磁盘上。

## 详细介绍

### 功能

| 能力 | 说明 |
| --- | --- |
| 分类管理 | 分类可新建 / 重命名 / 删除 / 拖拽排序；工作区拖到分类行即归类，拖回「未分类」取消 |
| 多端一致 | 分类、归类、会话顺序写在 Host 共享文档里，桌面与手机同一棵树；折叠状态等是本机偏好 |
| 会话工作状态 | 运行中 / 等待处理 / 已完成；折叠后汇总到工作区行或分类行 |
| 空会话清理 | 无消息且无输入框草稿的空白会话从树中隐藏（打开中、有草稿、最近更新不到 2 分钟、运行中、已改名除外），只隐藏不删日志 |
| 原地编辑 | 分类、工作区、会话都能原地重命名；删除工作区只把它从列表移除，磁盘目录与会话记录保留 |
| 会话归档 | 行尾归档按钮 +「隐藏归档 / 含归档 / 仅归档」三态筛选，和官方浏览器语义一致 |
| 拖拽辅助 | 拖动时自动收起下层、松手恢复原展开状态，贴边自动滚动（见下节） |
| 拖拽投放区 | 拖动任意行时树顶出现「取消 / 删除」两栏（见下节） |
| 新建工作区 | 选中目录后自动归入发起的分类、新建并打开第一个会话；流程进行中按钮只禁用、不转圈 |
| 接管方式 | `priority: -100` 影子 `sidebar.workspaces` 单槽位，不修改官方插件；禁用即恢复 |

### 拖拽操作

- **拖动分类**：自动收起所有分类下的工作区，屏幕上只留分类行。
- **拖动工作区**：自动收起所有工作区下的会话。
- **拖动会话**：不自动收起任何层级。
- **松手恢复**：自动收起只是视图叠加，不写入持久化状态，拖动结束立即回到拖动前的展开状态。
- **贴边滚动**：指针进入列表上下 36px 边缘带时列表自动滚动，每帧最多 16px；移出边缘、松手或到头即停，指针在列表水平范围外时不滚动。
- **投放区**：拖动任意行时树顶出现「取消 / 删除」两栏。拖到「取消」松手保持原顺序不变；拖到「删除」执行该行原有的删除——分类、工作区先弹确认，会话执行归档（撤销条可恢复）。

### 数据与同步

- 分类、归类、会话手动顺序：`$DSH_HOME/workspace-categories/state.json`，由 Host 通过认证的 `/api/workspace-categories.state` 路由读写。
- 折叠 / 展开 / 可见条数 / 归档筛选：本机 `localStorage`，不跨端。
- 同步是最终一致：另一端最迟约 4 秒看到变化，页面重新可见时立即拉取。
- 不联网、不收集数据；卸载插件不会删除任何工作区目录或会话日志。

### 已知限制

- 手机触屏浏览器不能拖动，只显示桌面排好的顺序。
- 空会话只做视图过滤，不会删除会话日志。
- 共享状态最终一致，跨端可见有约 4 秒延迟。

## 常见问题

Q1: **安装后左侧栏还是官方浏览器？**  
A1: 确认包名已在 profile 的 `dsh.profile.bundles` 中且插件未被禁用，然后重启一次 DSH。首次启用必须重启。

Q2: **能和原版 `dsh-workspace-categories` 一起装吗？**  
A2: 不要。两者同槽位同优先级；本插件的 patch 守卫会检测到上游包名并让位，但建议只保留一个。

Q3: **哪些数据跨端、哪些只在本机？**  
A3: 分类、归类、会话手动顺序跨端；折叠状态、可见条数、归档筛选是本机偏好。

Q4: **手机上可以拖动排序吗？**  
A4: 不能。触屏浏览器没有 HTML5 拖拽事件；手机端显示桌面排好的顺序。

Q5: **删除工作区会删磁盘目录吗？**  
A5: 不会。删除只把工作区从列表移除，磁盘目录和会话日志都保留；这棵树不再显示它的会话。

Q6: **升级要重装吗？**  
A6: 用 `dsh plugin --profile <profile> add <新 tgz>` 覆盖安装；只改了浏览器半时刷新页面即可，Host 半改动需重启 Host。

Q7: **支持哪些 DSH 版本？**  
A7: `engines.dsh` 声明 `>= 0.2.0-rc.2 < 0.2.3`，超出窗口会被 app-boot 挡住；接口清单见[兼容性说明](./docs/COMPATIBILITY.md)。

## 兼容性

| 测试版本 | 测试结果 |
| --- | --- |
| DSH 0.2.1-rc.2（Linux Host） | 实机运行，全部功能走查通过 |
| DSH 0.2.1-rc.5（Windows DSH Desktop） | 已安装运行，拖拽等 UI 实测通过 |
| DSH 0.2.0-rc.2、0.2.1-rc.1 ~ rc.5、0.2.2-rc.1 | 静态核对：用到的接口与字段均存在且语义未变 |
| DSH 0.1.x / 0.2.3+ / 0.3.x | 未验证，被 `engines.dsh` 挡住 |
| Node 20 / 22 / 24（Linux、Windows CI） | `npm test` 全绿 |

接口清单、降级行为与核对方法见 [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md)。

## 仓库结构

```text
dsh-mahiros-workspace-categories/
├─ lib/
│  ├─ index.js            # Host 入口：认证 /api 路由
│  ├─ state-store.js      # 共享文档：校验、操作、原子落盘、rev
│  ├─ state-routes.js     # GET|POST /api/workspace-categories.state
│  └─ client.js           # 浏览器半：树 UI + 同步引擎（手写 bundle）
├─ locale/                # 插件市场展示文案（zh / en）
├─ test/                  # node --test 用例：模型、拖拽、Host、发布守卫
├─ test-harness/          # 单测共用的 VM + React 替身
├─ docs/COMPATIBILITY.md  # 兼容性核对证据
├─ AGENTS.md              # 面向 agent 的仓库约定
├─ CHANGELOG.md / NOTICE / LICENSE
└─ README.md / README.en.md  # 人类文档（中 / 英镜像）
```

开发与发布流程见 [AGENTS.md](./AGENTS.md)：`npm test`（即裸 `node --test`）不需要安装任何依赖。

## 路线图

- [ ] 手机触屏拖动：受 HTML5 `DragEvent` 限制，需先确定替代交互。
- [ ] 空会话真正删除：依赖 DSH 提供删除会话的接口。
- [ ] 扩大 DSH 版本窗口：按[兼容性说明](./docs/COMPATIBILITY.md)的方法重新核对后再放开。
- 反馈渠道：GitHub [Issues](https://github.com/MineMahiro/dsh-mahiros-workspace-categories/issues)。

## 免责声明

- 本项目是非官方社区插件，与 DeepSeek / DeepSeek Harness 官方无关联。
- 仓库不包含 DSH 本体、官方闭源产物或任何账号凭据。
- 不联网、不收集数据；卸载插件不会删除工作区目录或会话日志。
- 使用前请自行备份 `$DSH_HOME/workspace-categories/state.json`。
- 按 MIT 协议「原样」提供，不承担数据丢失等责任。

## 许可声明

脚本与文档采用 [MIT License](./LICENSE)。

本项目是 [knight](https://github.com/Knight-Zjy) 的 [`dsh-workspace-categories`](https://github.com/Knight-Zjy/dsh-workspace-categories)（MIT）的修改版；上游版权声明完整保留在 [LICENSE](./LICENSE) 中，fork 的改动范围见 [NOTICE](./NOTICE) 与 [CHANGELOG.md](./CHANGELOG.md)。
