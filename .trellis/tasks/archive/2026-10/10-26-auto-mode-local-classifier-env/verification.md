# 验证记录

日期：2026-10-26

## 已通过

| 检查 | 结果 |
| --- | --- |
| `cargo check -p cc-use` | 通过 |
| `cargo check -p cc-use-daemon` | 通过 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test -p cc-use --lib proxy` | 50 passed |
| `cargo test -p cc-use --lib proxy::auto_mode` | 4 passed |
| `cargo test -p cc-use --test launch_preview` | 7 passed |
| `cargo test -p cc-use --test terminal_launch_preview` | 8 passed |
| `cargo test -p cc-use --test model_mapping` | 28 passed |
| `pnpm typecheck` | 通过 |
| `pnpm exec vitest run src/renderer/utils/modelMapping.test.ts src/renderer/utils/apiKeyEditor.test.ts` | 16 passed |
| `pnpm exec eslint`（改动文件） | 0 error（1 个既有 warning，与本次无关） |
| `pnpm exec prettier --check`（改动文件） | 通过 |

覆盖点：

- 关闭开关 / 未配置 mapping：不注入 auto-mode env。
- 开启且模型非空：预览 env 含 `CLAUDE_CODE_AUTO_MODE_SERVER=0` 与 trim 后的 `CLAUDE_CODE_AUTO_MODE_MODEL`。
- 开启但模型为空或空白：不注入。
- 用户显式 env：保留用户值。
- 只读取 `clients.claude_code` scope，忽略 Claude Desktop scope。
- 代理不再改写分类器请求；分类器 body 原样到达上游。
- 旧 `thinking` 字段可解析但不回写；`autoMode` 序列化为 `{enabled, model}`。

## 真实 E2E（2026-10-26，Claude Code 2.1.310）

用本地 mock Anthropic 网关跑 `claude --permission-mode auto -p`，抓取实际请求：

**设置 `CLAUDE_CODE_AUTO_MODE_SERVER=0` + `CLAUDE_CODE_AUTO_MODE_MODEL=claude-sonnet-4-6`**

- 主请求 `has_safeguards=false`：没有请求服务端审查。
- 分类器请求 `model=claude-sonnet-4-6`；debug 日志确认
  `classifier_request_started ... model=claude-sonnet-4-6`。
- 分类器 system prompt 仍命中 `is_classifier`（`You are a security monitor...`），
  说明 `request_kind=auto_mode` 标记对 2.1.310 仍有效。

**不设置两个变量**

- 未注入任何 auto-mode env。
- 主请求同样没有 `safeguards`；分类器使用会话默认模型
  （`deepseek-v4.1-flash[1m]`），证明 cc-use 默认不干预。

## 未完成 / 限制

- 交互式 `/status` 面板未成功抓取（pty 自动化在 MCP 启动阶段不稳定）；
  `Auto mode server: Disabled` 由“主请求无 safeguards + 本地分类器请求”间接确认。
- UI 文案已实现，但仓库没有 `ModelMappingEditor` 的组件测试；未做应用内截图验证。

## 待补

- 如需，可在应用内用真实供应商跑一次会话并截图，覆盖 `/status` 行、开关、模型输入与重启提示。

## 独立检查（trellis-check，2026-10-26）

结论：实现与 `prd.md` / `design.md` / `implement.md` 一致；三个高风险点（仅显式开启、仅 Claude Code scope、用户显式 env 优先）均正确，未发现功能缺陷。

修复的 5 处过时描述：

1. `proxy-core.md` 流水线步骤仍写 `auto_mode.adapt` 改写请求 → 改为分类标记、无 body 改写。
2. `proxy-core.md` 网关段落仍写绕过 “auto-mode adaptation” → 改为绕过分类标记。
3. `architecture.md` 的 `ProxyState` 仍列 “auto-mode cache” → 移除。
4. `docs/v3.15.0/gateway.md` 仍写 “Auto mode 适配” → 改为 “Auto mode 分类标记”。
5. `apiKeyEditor.ts` / `.test.ts` 注释仍描述代理改写 → 改为启动期 env 注入。

额外验证：

- `cargo check -p cc-use --all-targets`：通过，无 warning。
- `cargo clippy -p cc-use --all-targets`：任务相关文件无 warning（仓库有 73 个既有 warning）。
- `pnpm exec vitest run KeyEditModal.component.test.tsx Keys.query.test.tsx`：17 passed。
- `pnpm exec vitest run ModelCatalogManager.component.test.tsx`：2 passed。
- `git diff --check`：通过。

遗留风险：

- `/status` 仍未直接抓取，验收项保持未勾选。
- 分类器识别依赖当前 system prompt 文案；未来变化只影响 `request_kind` 标记，不影响转发与 env。
