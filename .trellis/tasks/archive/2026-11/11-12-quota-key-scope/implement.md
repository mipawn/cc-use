# 实施计划：额度归属迁移到密钥级

## Write scopes

- Backend agent：`src-tauri/src/**`、`src-tauri/tests/**`（Rust）
- Frontend agent：`src/renderer/**`、`src/shared/types/index.ts`（TS/TSX）
- Lead：`.trellis/**`、`CHANGELOG.md`、最终集成与全量验证

两端以 `design.md` 的契约（`queryScope` 字段名、`opencode-go-key` / `command-code-key` scheme id、locale key、窗口保留语义）为准，互不改对方目录。

## Backend checklist

1. `shared_runtime/query_schemes.rs`：方案目录迁移（account: deepseek/newapi；key: newapi/opencode/commandcode），`supports_windows` 语义、`account_target_urls`、错误文案、模块文档、单元测试。
2. `services/usage_service.rs`：保留窗口、`finalize_key_usage`（重命名）、消息与文档、测试。
3. `services/query_test.rs`：key scope 保留 windows、测试。
4. `shared_runtime/provider_presets.rs`：ProviderPreset 增加 `query_scope`，opencode/command code 预设改 key + 去账户脚本，`query_scope_for_preset` helper，测试。
5. `models/mod.rs`：`Provider.query_scope`、`ExportProvider.query_scope`。
6. `db/mod.rs`：建表列、ALTER、迁移调用；新增 `db/quota_scope_upgrade.rs` 模块 + 测试。
7. `db/providers.rs`：PROVIDER_COLUMNS / row_to_provider / INSERT（按 preset 推导）/ UPDATE add_field；必要时补充 query_scope 变更的缓存失效（scope 变化视为查询配置变化）。
8. `services/import_export.rs`：导出字段与导入落库。
9. 修复所有 `Provider { ... }` 字面量、`CreateProviderInput` 相关编译错误（fixture 补 `query_scope`）。
10. 后端验证：`cargo fmt --all -- --check`、`cd src-tauri && cargo test --lib`（或 `cargo test -p cc-use`）与相关集成测试 `cargo test --workspace`（可先跑定向，再全量）。

## Frontend checklist

1. `src/shared/types/index.ts`：`Provider.queryScope`、`ProviderPreset.queryScope`、注释更新（`QuerySchemeInfo.supportsWindows`）。
2. `utils/accountQuery.ts`：`providerQuotaIsPerKey`。
3. `utils/queryScriptShape.ts` + test：移除 commandcode 标记。
4. `components/query/QuerySettingsSection.tsx`：窗口渲染去掉 scope 条件；仅在有金额时渲染金额行。
5. `components/providers/ProviderModal.tsx`：key scope 隐藏账户查询区 + 提示；预设切换联动。
6. `pages/Keys.tsx`：删除 queryNow 链接按钮；key-scope 供应商隐藏账户级入口；密钥卡恢复可点击刷新 + 窗口渲染 + CSS。
7. `locales/zh.ts`、`en.ts`：方案 label/description、keyScopeQueryHint。
8. 更新 vitest：`Keys.query.test.tsx`、`QuerySettingsSection.component.test.tsx`、`ProviderModal.component.test.tsx`、`KeyEditModal.component.test.tsx`、`queryScriptShape.test.ts`、`accountQuery.test.ts` 及各 Provider fixture。
9. 前端验证：`pnpm typecheck`、`pnpm lint`、相关 `pnpm exec vitest run <files>`。

## Lead checklist

1. 审查两方 diff，确认契约一致（字段名、scheme id、locale key、迁移列）。
2. 全量验证：`cargo fmt --all -- --check`、`cargo test --workspace`、`pnpm typecheck`、`pnpm lint`、`pnpm test`。
3. 用 dev 数据库副本验证迁移：`sqlite3` 检查命中行 `query_scope='key'` 且账户查询列清空、未命中行不变；必要时跑 `cargo test` 的迁移用例。
4. 更新 `CHANGELOG.md` [Unreleased]、`.trellis/spec/cc-use/backend/query-script.md` 的 scope 章节。
5. 记录验收结果到 `acceptance.md`，不自动提交 git（由用户决定）。

## Rollback points

- 后端目录/服务改动可独立回退；DB 新列与迁移为追加式，旧版本忽略新列（迁移清空账户配置不可逆，回退版本不会恢复旧账户脚本——CHANGELOG 注明）。
- 前端改动彼此独立，回退后旧 UI 仍可读取 `queryScope` 字段（忽略）。
