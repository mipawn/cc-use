# 执行计划：auto mode 本地分类器 env 注入

日期：2026-10-26
依赖：`prd.md`、`design.md`

## 0. 开工前确认

- [ ] 确认工作分支为 `feat/v3.14.2-gateway-relaunch`，工作区已有改动不被覆盖。
- [ ] 读 `.trellis/spec/cc-use/backend/architecture.md`、`proxy-core.md`、`frontend/i18n.md`。
- [ ] 确认 `autoMode` 当前只被 `proxy/auto_mode.rs` 与 `ModelMappingEditor` 使用（`rg "autoMode|auto_mode"`）。

## 1. Rust：配置解析 helper

- [ ] `src-tauri/src/shared_runtime/model_mapping.rs`
  - 新增 `auto_mode_classifier_model(mapping: Option<&str>) -> Option<String>`。
  - 复用 `upstream_mapping`，只认 `enabled == true` 且 `model.trim()` 非空。
- [ ] inline 单测：v2 upstream、旧顶层格式、disabled、空模型、空白模型。

验证：

```bash
cargo test -p cc-use shared_runtime::model_mapping
```

## 2. Rust：启动 env 注入

- [ ] `src-tauri/src/shared_runtime/launch_preview.rs`
  - 新增 `apply_auto_mode_launch_env(&mut EnvObject, Option<&str>)`。
  - 使用 `entry().or_insert()`，显式 env 优先。
- [ ] `src-tauri/src/terminal/mod.rs::resolve_launch_preview`
  - 仅 claude / claude_code 调用上述 helper。
  - 确保 `terminal_get_launch_preview` 与真实启动都经过该路径。
- [ ] inline 单测：开启注入两变量、关闭不注入、显式 env 不被覆盖。

验证：

```bash
cargo test -p cc-use shared_runtime::launch_preview
cargo test -p cc-use terminal
```

## 3. Rust：移除旧代理改写

- [ ] `src-tauri/src/proxy/handler.rs`：删除 `state.auto_mode.lock()` 与 `adapt_with_hint` 调用；保留 `request_kind` 识别。
- [ ] `src-tauri/src/proxy/auto_mode.rs`：删除 `AutoModeState` / `Mapping` / `Config` / `adapt*` / 会话模型缓存及其测试；保留 `is_classifier`、`is_message_response`，按调用方决定 `claude_session_id` 去留。
- [ ] 删除 `AppState.auto_mode` 字段、初始化与相关 import。
- [ ] 全仓确认无 `RANKING` 式残留引用：`rg "AutoModeState|adapt_with_hint|auto_mode\\." src-tauri crates`。

验证：

```bash
cargo test -p cc-use proxy::auto_mode
cargo test -p cc-use proxy
cargo check -p cc-use
```

回滚点 A：若删除面过大，可先只移除 handler 调用并保留类型，再单独清理。

## 4. 前端

- [ ] `src/renderer/utils/modelMapping.ts`
  - `autoMode` 类型保留 `thinking?` 兼容读取，序列化不再输出。
  - 开关开启但 `model` 为空时由 UI 提示，不改变存储结构。
- [ ] `src/renderer/components/keys/ModelMappingEditor.tsx`
  - 删除 thinking 下拉与相关分支。
  - 新增说明：重启生效、2.1.302+、分类器请求计费。
  - 空模型行内警告。
- [ ] `src/renderer/locales/zh.ts` / `en.ts`
  - 更新 `autoMode` / `autoModeHint` / `autoModeModel*`。
  - 删除 `autoModeThinking*`。
- [ ] `src/renderer/utils/modelMapping.test.ts`
  - 更新 thinking 相关断言；新增序列化为 `{enabled, model}` 的用例。

验证：

```bash
pnpm typecheck
pnpm exec vitest run src/renderer/utils/modelMapping.test.ts
pnpm exec eslint src/renderer/utils/modelMapping.ts src/renderer/components/keys/ModelMappingEditor.tsx src/renderer/locales/zh.ts src/renderer/locales/en.ts
```

## 5. 文档

- [ ] 重写 `docs/v3.15.0/auto-mode.md`：新机制、env 注入、版本要求、重启与计费说明、与旧方案的区别。
- [ ] 更新 `docs/v3.15.0/README.md` 的 auto-mode 索引描述。
- [ ] 更新 `README.md` / `README_EN.md` 的 Auto mode bullet。
- [ ] 更新 `CHANGELOG.md` 3.15.0 的 Auto mode 条目（发布前版本，直接改现有条目）。
- [ ] 更新 `.trellis/spec/cc-use/backend/proxy-core.md` 中 auto mode 改写描述（Phase 3.3）。

## 6. 端到端验证

- [ ] 启动 dev daemon（重新编译 daemon 后先 kickstart LaunchAgent）。
- [ ] 用 Claude Code ≥ 2.1.302 + 第三方 Key：
  - 开关关闭启动 → 不注入；`/status` 仍为默认行为。
  - 开关开启 + 模型 → 预览 env 含两变量；启动后 `/status` 显示 `Auto mode server: Disabled`。
  - 触发 shell/网络动作 → 请求记录出现分类器请求，模型为配置值。
- [ ] 截图或日志记录保存到任务目录（`research/e2e-*.md`）。

## 7. 完成门禁

```bash
pnpm typecheck
pnpm lint
pnpm exec vitest run src/renderer/utils/modelMapping.test.ts
cargo test -p cc-use shared_runtime::model_mapping shared_runtime::launch_preview
cargo test -p cc-use proxy::auto_mode proxy
```

- [ ] 全绿；手动 E2E 有证据。
- [ ] `docs`、`CHANGELOG`、spec 与代码同提交。
- [ ] 在 PR 描述中写明：默认不干预；开启后注入两变量；旧版忽略；需重启。
