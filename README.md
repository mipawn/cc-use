# CC Use

专为 **Claude Code / Codex CLI** 打造的桌面配置管理工具。不同于通用的 API 管理平台，CC Use 只做一件事：让你更高效地管理和使用 CLI。

[English](./README_EN.md)

> **🎉 3.0 重大更新**：代理抽离为独立 `cc-use-daemon` 进程，实例身份在启动时显式建模。详见 [CHANGELOG](./CHANGELOG.md)。
>
> **⚠️ 平台变更**：自 3.0 起**仅支持 macOS**，不再提供 Windows 构建，也不再维护 Windows 相关代码。
>
> **历史迁移**：[从 1.x 迁移](./guides/MIGRATION.md) · [从 0.x (cc-switch) 迁移](./guides/MIGRATION_FROM_CC_SWITCH.md)

## 截图

|                 仪表盘                 |               密钥管理               |
| :------------------------------------: | :----------------------------------: |
| ![仪表盘](./screenshots/dashboard.png) | ![密钥管理](./screenshots/token.png) |

|                项目管理                |               统计                |
| :------------------------------------: | :-------------------------------: |
| ![项目管理](./screenshots/project.png) | ![统计](./screenshots/statis.png) |

|                设置                 |                实例                 |
| :---------------------------------: | :---------------------------------: |
| ![设置](./screenshots/settings.png) | ![实例](./screenshots/instance.png) |

## 功能

- **供应商与密钥管理** - 在「密钥」页面统一管理供应商和 API 密钥，每个密钥可同时支持 Claude Code 和 Codex CLI，支持额度查询（NewAPI / 自定义接口），支持快速复制密钥配置
- **项目管理** - 创建项目并绑定供应商、密钥和 CLI 类型，支持在项目卡片上快速切换绑定
- **一键启动** - 点击项目即启动终端，自动注入环境变量，直接进入 CLI
- **本地 daemon 服务** - 独立常驻的 `cc-use-daemon` 进程作为本地网关，透明中转请求，支持费用追踪与热切换
- **实例管理** - 「实例」页面展示每次启动的 managed instance，状态机涵盖 `launching / running / stale / stopped / failed`，支持实例级密钥热切换
- **费用追踪** - 自动记录每次请求的 Token 用量和费用
- **统计分析** - 仪表盘展示今日费用、请求量、每日趋势、Top 密钥/项目；统计页提供按密钥/供应商/项目/模型的详细分析和请求明细
- **系统托盘** - 关闭窗口时最小化到托盘，daemon 服务持续运行；托盘菜单支持服务控制和最近项目快速启动
- **自动更新** - 应用内检测并下载新版本，支持下载进度显示（`tauri-plugin-updater` 签名校验）
- **CLI 配置管理** - 支持全局配置和密钥级别的 CLI 配置（JSON），启动时自动合并注入
- **国际化** - 中文 / 英文界面
- **深色模式** - 亮色 / 深色主题切换

## 安装

从 [Releases](https://github.com/mipawn/cc-use/releases) 下载 macOS 安装包：

| 平台  | 格式   |
| ----- | ------ |
| macOS | `.dmg` |

## 使用方式

### 1. 添加供应商和密钥

进入「密钥」页面：

1. 点击「添加供应商」，填写名称、Base URL，选择图标，可选配置 Token 和余额查询
2. 在供应商分组下点击「添加密钥」，填写密钥值，选择支持的类型（Claude Code / Codex CLI），可选配置额度查询和 CLI 配置

### 2. 创建项目

进入「项目」页面，点击「添加项目」：

1. 填写项目名称，通过浏览按钮选择项目文件夹路径
2. 选择绑定的供应商和密钥（级联选择器）
3. 选择 CLI 类型（Claude Code / Codex CLI）

创建后可在项目卡片上快速切换绑定的密钥或 CLI 类型。

### 3. 启动终端

在「项目」页面或「仪表盘」的最近项目中，点击打开按钮即可启动终端。应用会通过本地常驻 daemon 注入环境变量，并创建一个 managed instance：

- **Claude Code**: 设置 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
- **Codex CLI**: 设置 `OPENAI_BASE_URL` + `OPENAI_API_KEY`

### 4. daemon 服务

本地 daemon 服务随应用启动并常驻运行，终端总是经它中转：

- 请求使用 session token 替代真实密钥
- 自动记录每次请求的 Token 用量和费用
- 支持不重启终端热切换密钥（在项目页修改下次默认值，在「实例」页切换当前运行实例）

在「设置」页面可以查看服务运行状态和端口，异常时点击「重启服务」。

## 工作原理

应用启动时会自动拉起独立的 `cc-use-daemon` 进程作为本地网关。从项目页启动终端时，app 会生成 session token 并通过临时 wrapper 脚本注入：

```
CLI → localhost:12345 (daemon) → 实际 API 供应商
```

daemon 做四件事：

- 用 session token 路由到对应供应商/密钥，不把真实密钥暴露给终端环境
- 自动记录每次请求的 Token 用量和费用
- 支持不重启终端热切换密钥
- 通过 wrapper 的 heartbeat + stop 上报追踪每个 managed instance 的生命周期

## 从源码构建与测试

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建生产版本
pnpm build

# 构建开发版本（用于测试）
pnpm build:dev

# 前端测试（兼容入口）
pnpm test

# Rust 测试
cargo test --workspace

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 代码格式化
pnpm format
```

## 技术栈

- **框架**: Tauri 2.x + Vite
- **后端**: Rust (axum, rusqlite, tokio)
- **前端**: React 18 + TypeScript
- **UI**: Ant Design 6 + Tailwind CSS 4
- **状态管理**: Zustand
- **数据库**: SQLite (rusqlite)
- **Daemon**: 独立 `cc-use-daemon` 进程（Axum + Hyper）
- **国际化**: i18next + sys-locale

## 支持平台

- macOS (Apple Silicon / Intel)

> ⚠️ **注意**：自 3.0 起不再提供 Windows 构建，也不再维护 Windows 相关代码。Windows 用户请停留在 2.3.x，该版本不再收到更新。

## License

MIT
