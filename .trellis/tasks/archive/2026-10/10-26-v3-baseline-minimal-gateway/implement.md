# Implementation Plan

基线：`feat/v3.14.2-gateway-relaunch`（产品代码 = `v3.14.2`）。每个 Slice 独立可验证、独立提交；任意 Slice 失败可单独回滚。

## Progress (2026-10-26 17:25)

- [x] Slice 0 基线确认
- [x] Slice 1 R4 仅菜单栏
- [x] Slice 2 R1 网关后端
- [x] Slice 3 R1 网关页面
- [x] Slice 4 R2 供应商配额 UI
- [x] Slice 5 R5 模型显式添加
- [x] Slice 6 R6 控制台异常真实性
- [x] Slice 7 R3 Auto mode 兼容适配
- [x] Slice 8 自动化门禁、版本 3.15.0、docs/CHANGELOG
- [ ] 提交（等待用户确认）

## Slice 0 — 基线确认（已完成）

- [x] 从 `main` 创建分支，确认 `src/`、`src-tauri/`、`crates/` 与 `v3.14.2` diff 为空。
- [x] 按 3.14.2 lockfile 重装依赖。
- [x] `pnpm typecheck`、`pnpm lint`（0 error / 3 既有 warning）、`pnpm test`、`cargo test -p cc-use-daemon`、`cargo fmt --all -- --check` 通过。

## Slice 1 — R4 仅菜单栏

顺序：先做这个，改动面最小且可独立手工验收。

1. `src-tauri/Info.plist` 新增 `LSUIElement=true`；`tauri.conf.json` 的 `bundle.macOS` 增加 `infoPlist`。
2. `lib.rs` setup 早期调用 `set_activation_policy(Accessory)`。
3. 删除 `lib.rs`、`tray.rs::toggle_window`、`commands/system_ext.rs::toggle_main_window` 中的 `set_dock_visibility`。
4. 新增 `tray::show_main_window`；`lib.rs` 改用 `.build(...).run(...)` 并处理 `RunEvent::Reopen`。
5. `CloseRequested` 在菜单栏模式下始终 `prevent_close + hide`；`Settings` 的 `closeToTray` 改为固定说明/禁用开关。
6. 文案 zh/en 同步。

验证：

```bash
cargo fmt --all -- --check
cargo test -p cc-use --test db_settings
pnpm typecheck && pnpm lint
# 手工：启动后 Dock 无图标；顶部菜单栏可打开；关闭后从菜单栏重开；Finder/Spotlight 可重开；托盘退出可用
```

## Slice 2 — R1 网关后端

1. DB：`proxy_sessions` 新增 `display_name TEXT`、`is_active INTEGER NOT NULL DEFAULT 1`（CREATE + ALTER + mapper + INSERT + model + TS）。
2. 清理：`proxy_session_cleanup_stale` 排除 `gateway`；`session_list` 过滤 `gateway`。
3. 解析：`resolve_session_resources` 增加 `is_active` 门禁；`build_route_execution` 对 `session_kind='gateway'` 强制 `cli_type=None`。
4. 旁路：`count_tokens` 本地估算增加 `cli_type.is_some()`；目录拦截已因 `cli_type=None` 自然跳过。
5. 命令：`commands/gateways.rs` 的 list/create/update/delete；注册到 `lib.rs`；`Gateway` DTO + TS + `Api` 桥。
6. 数据完整性：`api_key_delete` 清理该 key 的 gateway 行；`provider_delete` 清理该 provider 的 gateway 行。
6. 测试：CRUD、归属校验、停用拒绝、cleanup 保留、网关请求转发到绑定 key、`/v1/models` 不被本地拦截、count_tokens 不被本地估算。

验证：

```bash
cargo fmt --all -- --check
cargo test -p cc-use --test gateway_api
cargo test -p cc-use --test proxy_handler_auth
cargo test -p cc-use --test db_proxy_sessions
cargo clippy -p cc-use --lib --no-default-features
pnpm typecheck
```

## Slice 3 — R1 网关页面

1. 路由 `/gateway` + 侧边栏入口。
2. 列表、创建/编辑 Modal、复制地址/Key、启停、删除确认、空状态、daemon 未运行提示。
3. `usePageRefresh` 注册；zh/en 文案。
4. 组件测试。

验证：

```bash
pnpm exec vitest run src/renderer/pages/GatewayPage.test.tsx
pnpm typecheck && pnpm lint
# 手工：用网关地址 + 本地 Key 调用 /v1/messages 或 /v1/chat/completions；换绑后走新 key；停用后失败
```

## Slice 4 — R2 供应商配额 UI

1. `Keys.module.css` `.providerQuota`：`padding: 0 16px 14px` → `padding: 14px 16px`；检查 `@container` 窄宽度分支。
2. `ProviderUsageWindows.module.css` `.reset`：增加 `margin-top: 4px`。
3. `Keys.tsx:815-846`：移除额度区内的裸 `<Button size='small'>`；空状态改为与 header 一致的 `type='link'` + 图标 + `providers.queryNow` 文案，并右对齐/与空状态同列。
4. 更新 `ProviderUsageWindows.component.test.tsx`、`Keys.query.test.tsx`。

验证：

```bash
pnpm exec vitest run src/renderer/components/providers/ProviderUsageWindows.component.test.tsx
pnpm exec vitest run src/renderer/pages/Keys.query.test.tsx
pnpm typecheck && pnpm lint
```

## Slice 5 — R5 模型显式添加

1. `ModelCatalogManager.tsx:93-95` 删除自动全选；`selected` 只来自已保存的 `value.models`。
2. 切换 source 不自动全选；`selectionTouched` 只在用户操作后置位；空选择给提示。
3. 确认“应用 → 保存”两段式语义不变；刷新获取不改 `value.models`。
4. 更新 `KeyEditModal.component.test.tsx` 模型相关用例，补一条“首次打开不全选 / 刷新不覆盖”。

验证：

```bash
pnpm exec vitest run src/renderer/components/keys/KeyEditModal.component.test.tsx
pnpm typecheck && pnpm lint
```

## Slice 6 — R6 控制台异常真实性

1. 非流式/流式结束：按 `RequestOutcome` 发 `upstream_error`，带真实 status + 截断错误消息。
2. `finalize_usage`：先判 status 再判 usage；非 2xx 带 usage 也记录错误原因，不写成无原因 `transport_error`。
3. `StreamUsageAccumulator`：增加完成标记（`message_stop` / `[DONE]` / `response.completed`）；2xx 未完成 → `transport_error`。
4. `RequestCancellationGuard`：带 log context，drop 时写 `transport_error` 行 + `cancelled` 事件。
5. 解压失败 → 502 + `upstream_error`；Auto mode 分类器 200 无 usage → `upstream_error`；WS 升级后失败 → 终止事件。
6. `Console.tsx`：`isProblemEvent` 纳入 cancelled/transport_error/4xx+；颜色与标签按 status/outcome；摘要/详情显示原因。
7. 测试：`proxy_handler_console.rs` 增加非 2xx、截断流、取消用例；`Console` 组件测试；`usage_parser` 单测。

验证：

```bash
cargo fmt --all -- --check
cargo test -p cc-use --test proxy_handler_console
cargo test -p cc-use --test proxy_auth
cargo test -p cc-use --lib proxy::
pnpm exec vitest run src/renderer/pages/Console.test.tsx
pnpm typecheck && pnpm lint
```

## Slice 7 — R3 Auto mode 兼容适配

1. 默认路径不改：适配关闭时不注入 env、不改 body；`safeguards` / `safeguard_results` / `anthropic-beta` 原样透传。
2. 不注入任何 auto-mode 启动环境变量（`CLAUDE_CODE_AUTO_MODE_SERVER` / hint headers 都不动）。
3. 识别：有 `x-claude-code-request-class: auxiliary` 时优先；否则回退 body 启发式（安全审查前缀用 `contains`、`<transcript>`、无 tools）。
4. 适配：只改 `model`（固定/跟随会话）；`thinking` 默认不改；`low` 只设 `output_config.effort="low"`；`disabled` 设 thinking disabled；不再改 `max_tokens`/采样参数/强制 enabled。
5. `apiKeyEditor.ts`：新 Key 不再默认 `enabled=true`；UI 文案改为“Auto mode 兼容适配（仅不支持原生 auto 的供应商）”。
6. 测试：`auto_mode.rs` 检测/改写、`model_mapping.rs` 配置解析、`apiKeyEditor.test.ts` 默认值。

验证：

```bash
cargo test -p cc-use --test model_mapping
cargo test -p cc-use --lib proxy::auto_mode
pnpm exec vitest run src/renderer/utils/apiKeyEditor.test.ts
pnpm typecheck && pnpm lint
# 手工（能装最新 CC 时）：适配关闭确认原样透传；开启确认 classifier model 映射
```

## Slice 8 — 收尾门禁

```bash
cargo fmt --all -- --check
cargo test -p cc-use
cargo test -p cc-use-daemon
cargo test -p cc-use-cli
pnpm typecheck
pnpm lint
pnpm test
```

- 版本按 `3.15.0` 准备（新增网关功能 + 行为变更）；按 `release.sh` 的 3 处版本号 + Cargo.lock 更新。
- `CHANGELOG.md` 增加 `[3.15.0]`；`docs/v3.15.0/README.md` 作为索引，功能文档同 PR：
  - `gateway.md`、`menu-bar.md`、`provider-quota-ui.md`、`model-selection.md`、`console-errors.md`、`auto-mode.md`。
- 手工验收分工：
  - 我们负责：R1 网关真实调用/换绑/停用/daemon 重启；R3 适配关闭/开启两条路径（至少一次真实 CC 会话）。
  - 用户自行验证：R2 配额视觉、R4 菜单栏/Dock/Reopen、R5 模型显式添加、R6 控制台异常展示。
- 未验证项必须逐项标注，不用单测结果冒充实机通过。

## Review Gates

- 每个 Slice 完成后先跑该 Slice 的验证命令，再进入下一个。
- Slice 2（网关后端）与 Slice 6（控制台异常）触及请求路径，必须额外跑 `cargo test -p cc-use --test proxy_auth` 与 `proxy_handler_console`。
- Slice 1（菜单栏）需要 macOS 手工验收，不能用单测替代。
- 任何规格变更（前缀、字段、错误分类）先回写 `prd.md`/`design.md`，再改代码。
