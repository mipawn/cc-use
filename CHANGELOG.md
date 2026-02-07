# Changelog

本文件记录项目的所有重要变更。

## [1.0.0] - 2026-02-07

全新 Electron 桌面应用，完全重写，与旧版 cc-switch / cc-use CLI 不兼容。

### Added

- Electron 桌面应用，提供完整的可视化管理界面
- 服务商管理：支持 Claude Code 和 Codex CLI 两种类型，可配置 Base URL、Token、图标等
- API 密钥管理：每个服务商支持多个密钥，支持优先级排序、耗尽标记、独立配置
- 项目管理：创建项目并绑定服务商和密钥，支持拖放文件夹快速创建
- 本地代理服务器：基于 Express，使用 session token 中转请求，避免暴露真实密钥
- 费用追踪：自动记录每次 API 请求的 Token 用量和费用，支持 Claude、OpenAI、DeepSeek 等模型定价
- 统计分析：仪表盘展示今日费用/请求量/每日趋势/Top 密钥和项目；统计页提供按密钥/服务商/项目/模型的详细分析
- 热切换：不重启终端即可切换项目使用的服务商或密钥
- 终端集成：根据服务商类型自动设置环境变量（ANTHROPIC_* 或 OPENAI_*）并启动终端，支持 iTerm2、Terminal.app、Windows Terminal、cmd
- 钱包余额查询：支持 NewAPI（账户级/密钥级）和自定义接口查询余额
- 导入导出：备份和恢复服务商配置
- 国际化：支持中文和英文界面
- 深色模式：支持亮色/深色主题切换
- SQLite 本地数据库存储（better-sqlite3 + Drizzle ORM）

### Changed

- 从 CLI 工具重构为 Electron 桌面应用
- 技术栈从 Bun + Go 模板切换为 Electron + React 18 + TypeScript
- UI 框架使用 Ant Design 6 + Tailwind CSS 4
- 状态管理使用 Zustand
- 数据存储从 JSON 配置文件改为 SQLite 数据库

---

## 旧版 cc-switch / cc-use CLI 历史记录

以下为旧版 CLI 工具的变更记录，仅供参考。v1.0.0 与旧版不兼容。

### [0.1.3] - 2026-01-28

- `update` 命令支持自动检测权限问题并提示使用 sudo 重试
- 文档补充 `update` 命令的使用说明和 sudo 相关提示

### [0.1.2] - 2026-01-28

- 新增 `export` 命令，支持导出配置到 JSON 文件
- 新增 `import` 命令，支持从 JSON 文件导入配置
- Shell 补全支持 export/import 命令

### [0.1.1] - 2026-01-28

- 新增 `uninstall` 命令，支持一键卸载 cc-switch
- Shell 补全支持（zsh/bash/fish），安装时自动配置
- 修复补全文件不会随版本更新的问题

### [0.1.0] - 2026-01-28

- 初始版本发布
- 支持管理多个 Claude Code 配置文件
- 支持配置切换功能
- 支持 macOS (ARM64/x64)、Windows (x64) 和 Linux (x64) 平台
