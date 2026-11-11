# dsh-mahiros-workspace-categories

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的侧边栏工作区管理器：
把左侧栏的工作区浏览器换成 **分类 > 工作区 > 会话** 的三级树。
分类与归类存在 Host 侧，桌面浏览器和 `dsh-pocket` 手机端看到的是同一棵树。

```text
分类 A                          ← 自建分类，可拖拽排序
  └ 工作区 A-1        +  ·  3    ← 会话数 / 新建会话 / 折叠后汇总状态
      └ 会话 1
      └ 会话 2
未分类                           ← 未归类的工作区，常驻拖放目标
  └ 工作区 B
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 分类与归类 | 分类可新建/重命名/删除/拖拽排序；工作区拖到分类行即归类，拖回「未分类」取消 |
| 多端一致 | 分类、归类、会话顺序写在 Host 的共享文档里，桌面与手机同一棵树；折叠状态等是本机偏好 |
| 会话工作状态 | 运行中 / 等待处理 / 已完成；折叠后汇总到工作区行或分类行 |
| 空会话清理 | 没有消息、也没有输入框草稿的空白会话自动从树中隐藏（当前打开的、有草稿的、刚创建的、运行中或已改名的除外），只隐藏不删日志 |
| 原地编辑 | 分类、工作区、会话都能原地重命名；工作区可移出列表（磁盘目录和会话记录保留） |
| 会话归档 | 行尾归档按钮 + 「隐藏归档 / 含归档 / 仅归档」三态筛选，和官方浏览器语义一致 |
| 拖拽辅助 | 拖动类别时自动收起所有工作区，拖动工作区时自动收起所有会话，松手立即恢复原来的展开状态；拖到列表上下边缘时列表自动滚动 |
| 拖拽投放区 | 拖动任意行时树顶出现「取消 / 删除」两个区域：拖到「取消」松手保持原顺序不变，拖到「删除」松手执行该行原有的删除（分类 / 工作区会先确认，会话执行归档且可撤销） |
| 新建工作区 | 选中目录后自动归入发起的分类、新建第一个会话并打开；流程进行中按钮只禁用、不转圈 |

不改官方插件：本插件以 `priority: -100` 注册进 `sidebar.workspaces` 单槽位，
影子官方浏览器（`priority: 0`）。禁用本插件，官方浏览器立刻回来。

## 安装

要求 **DSH >= 0.2.0-rc.2**、**Node >= 20**。下面的 `<profile>` 换成你的 profile 名
（常见是 `web` 或 `desktop`）。

**方式一：GitHub Release 的 tgz**

```bash
dsh plugin --profile <profile> add \
  https://github.com/MineMahiro/dsh-mahiros-workspace-categories/releases/download/v0.8.2/dsh-mahiros-workspace-categories-0.8.2.tgz
```

**方式二：克隆仓库后本地安装**

```bash
git clone https://github.com/MineMahiro/dsh-mahiros-workspace-categories.git
dsh plugin --profile <profile> add ./dsh-mahiros-workspace-categories
```

然后在应用内「设置 → 插件」里确认已启用（等价于把包名
`dsh-mahiros-workspace-categories` 加入该 profile 的 `dsh.profile.bundles`），重启 DSH。
升级时：浏览器半刷新页面即可生效；Host 半（共享状态路由）改动后需要重启一次 Host。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH 版本 | `>= 0.2.0-rc.2 < 0.2.3`。0.2.1-rc.2 实机运行；0.2.1-rc.5 已安装到 Windows 桌面端；0.2.0-rc.2、0.2.1-rc.1~rc.5、0.2.2-rc.1 的接口逐项静态核对（见 [兼容性说明](docs/COMPATIBILITY.md)）。窗口外（0.1.x / 0.2.3+ / 0.3.x）未验证，会被 `engines.dsh` 挡住 |
| 运行平台 | Linux / macOS / Windows（含 Host 在 Windows、页面经 WSL 或 `dsh-pocket` 访问）；Node >= 20 |
| 官方 `ui-workspace` | 不禁用、不修改；槽位影子关系见上，本插件 dispose 后官方浏览器恢复 |
| 原版 `dsh-workspace-categories` | **不要同时启用**：同一个单槽位、同为 `priority: -100`。两个包都装时，本插件的 patch 守卫会自动让位（不会双注册） |
| 目录选择 | 推荐搭配目录插件提供的 `workspaceDefaultDirectory` 服务（官方应用内目录对话框）。未安装时回落到官方原生目录选择器 |
| 运行依赖 | 无。Host 半是零依赖 Node 代码；浏览器半只 `require` 平台种子模块 |

## 数据在哪

- 分类、归类、会话手动顺序：`$DSH_HOME/workspace-categories/state.json`
  （`DSH_HOME` 可覆盖；文件损坏时先改名备份为 `state.json.bad-<时间戳>` 再重建）。
- 折叠 / 展开 / 可见条数 / 归档筛选：本机 `localStorage`，不跨端。
- 不联网、不收集数据；卸载插件不会删除任何工作区目录或会话日志。

## 已知限制

- 手机触屏浏览器不派发 HTML5 拖拽事件，手机上不能拖，但会显示桌面排好的顺序。
- 空会话只做视图过滤：DSH 没有删除会话的接口，日志仍留在磁盘上。
- 共享状态是最终一致：另一端最迟约 4 秒后看到变化（页面重新可见时立即拉取）。

## 开发

```bash
npm test        # = node --test，自动发现 test/*.test.js，无需安装依赖
```

仓库结构、数据契约、发布流程和 agent 约定见 [`AGENTS.md`](./AGENTS.md)；
fork 来源与改动范围见 [`NOTICE`](./NOTICE) 和 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可

MIT。本项目是 [knight](https://github.com/Knight-Zjy) 的
[`dsh-workspace-categories`](https://github.com/Knight-Zjy/dsh-workspace-categories)
（MIT）的修改版；上游版权声明保留在 [`LICENSE`](./LICENSE) 中。
