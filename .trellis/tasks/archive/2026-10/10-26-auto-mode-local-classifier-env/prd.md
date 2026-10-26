# Claude Code 最新版 auto mode 本地分类器兼容（env 注入）

## Goal

最新版 Claude Code 在 `ANTHROPIC_BASE_URL` 指向网关时，默认把 auto mode 的安全审查放在正常模型请求里带内完成（`safeguards` / `safeguard_results`）。第三方供应商无法回答这套协议，Claude Code 会回退到自己的本地分类器。

本任务改为在**启动时注入环境变量**，显式让 Claude Code 使用本地分类器，并把它指向供应商实际可用的模型：

- `CLAUDE_CODE_AUTO_MODE_SERVER=0`
- `CLAUDE_CODE_AUTO_MODE_MODEL=<分类器模型>`

默认不注入，不改变 auto mode 行为；只对显式开启兼容的 Key 生效。

## Confirmed Facts

- 官方文档：网关场景下服务端审查默认开启的要求是 Claude Code ≥ 2.1.278；`CLAUDE_CODE_AUTO_MODE_MODEL` 要求 ≥ 2.1.302。
- 不设置 `CLAUDE_CODE_AUTO_MODE_SERVER` 时，Claude Code 在拿不到服务端审查结果后会自动回退到本地分类器；但首个被检查动作会被计费提示挂起。
- `CLAUDE_CODE_AUTO_MODE_SERVER` 被官方标注为临时设置，后续可能移除；未知环境变量在旧版本中会被忽略。
- 本地分类器请求会计入该 Key 的 token 用量，请求会经 cc-use 代理转发。
- 旧实现（`src-tauri/src/proxy/auto_mode.rs`）通过识别客户端分类器请求并改写 `model` / `thinking` 做兼容；该路径对应 2.1.220 时代，与本方案冲突。

## Requirements

### R1 默认不干预

- Key 未开启 auto mode 兼容时，启动 Claude Code 不注入任何 auto-mode 相关环境变量。
- 不注入 `CLAUDE_CODE_ENABLE_AUTO_MODE`，不强制开启 auto mode。
- 普通请求与服务端审查字段继续原样透传。

### R2 开启后注入本地分类器环境变量

- 复用 Key 现有的「Auto mode 兼容适配」开关与分类器模型字段，含义改为“启动时注入本地分类器配置”。
- 开启且分类器模型非空时，在启动 Claude Code（`claude` / `claude_code`）的 wrapper 环境中注入：
  - `CLAUDE_CODE_AUTO_MODE_SERVER=0`
  - `CLAUDE_CODE_AUTO_MODE_MODEL=<trim 后的模型 ID>`
- 用户在 Key / 全局 Claude 配置里显式设置的同名环境变量优先，不被覆盖。
- 开启但分类器模型为空时不注入，并在 UI 提示必须填写模型。

### R3 生效方式与提示

- 环境变量只对之后新启动的 Claude Code 会话生效；UI 必须明确提示“修改后需要重启会话”。
- UI 说明该能力面向最新版 Claude Code（自定义分类器模型需要 2.1.302+），旧版本会忽略这些变量。
- UI 说明本地分类器请求会计入该 Key 的 token 用量。

### R4 移除旧代理改写

- 删除代理侧对客户端分类器请求的 `model` / `thinking` / `effort` 改写，避免与本方案重复处理。
- 保留分类器请求的识别与 `request_kind=auto_mode` 标记，用于控制台/统计展示；识别失败不得影响转发。

### R5 文档与测试同改动

- 更新 `docs/v3.15.0/auto-mode.md`、`docs/v3.15.0/README.md`、`README.md`、`README_EN.md`、`CHANGELOG.md`。
- 补充 Rust 单测、前端模型映射测试；提供一次真实 Claude Code ≥ 2.1.302 的验证记录。

## Acceptance Criteria

- [x] 关闭开关：`terminal_get_launch_preview` 返回的 env 不含 `CLAUDE_CODE_AUTO_MODE_SERVER` / `CLAUDE_CODE_AUTO_MODE_MODEL`。
- [x] 开启且填写模型：预览与真实启动的 env 同时包含 `CLAUDE_CODE_AUTO_MODE_SERVER=0` 和 `CLAUDE_CODE_AUTO_MODE_MODEL=<模型>`。
- [x] 开启但模型为空：不注入，UI 显示必须填写模型的提示。
- [x] 用户显式配置同名 env：保留用户值。
- [x] 代理不再改写分类器请求的 `model` / `thinking` / `effort`。
- [x] UI 在开关附近展示“重启会话生效”、版本要求与计费说明（中英文）。
- [x] `cargo test` 定向用例、`pnpm typecheck`、相关 vitest、lint 通过。
- [ ] 真实 Claude Code ≥ 2.1.302 会话中 `/status` 显示 `Auto mode server: Disabled`，分类器请求使用配置的模型。

## Constraints

- 不实现 LiteLLM 式服务端 `safeguards` 审查（本任务明确不选方案 A）。
- 不解析 / 门控 Claude Code 版本；依赖旧版本忽略未知环境变量。
- 不做数据库迁移；历史 `autoMode.thinking` 字段保留但忽略。
- macOS-only，不补 Windows 路径。

## Out of Scope

- 服务端 `safeguards` / `safeguard_results` 协议模拟。
- 自动选择或推荐分类器模型。
- 为 Claude Desktop / Codex / Grok 注入 auto mode 变量。
