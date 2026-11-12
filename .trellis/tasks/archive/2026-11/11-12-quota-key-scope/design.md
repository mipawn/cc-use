# 设计：额度归属迁移到密钥级

## 1. Change Boundary

- 查询方案目录与 scope 边界：`src-tauri/src/shared_runtime/query_schemes.rs`
- 密钥查询运行结果（窗口保留）：`src-tauri/src/services/usage_service.rs`、`src-tauri/src/services/query_test.rs`
- 供应商预设（不再预填账户查询、声明 queryScope）：`src-tauri/src/shared_runtime/provider_presets.rs` + `src-tauri/src/shared_runtime/account_scripts.rs`（脚本本体不变）
- Provider 持久化：`providers.query_scope` 列、迁移 `src-tauri/src/db/quota_scope_upgrade.rs`、`db/mod.rs`、`db/providers.rs`、`models/mod.rs`、`services/import_export.rs`
- API 契约：`src/shared/types/index.ts`
- UI：`src/renderer/pages/Keys.tsx`、`src/renderer/components/providers/ProviderModal.tsx`、`src/renderer/components/query/QuerySettingsSection.tsx`、`src/renderer/utils/accountQuery.ts`、`src/renderer/utils/queryScriptShape.ts`、`src/renderer/locales/{zh,en}.ts`
- 测试：上述模块对应的 Rust / vitest 测试
- 文档：`CHANGELOG.md`、`.trellis/spec/cc-use/backend/query-script.md`（scope 章节）

不触碰推理协议、模型目录、网关、客户端连接、终端启动。

## 2. Query catalogue（唯一契约）

`query_schemes.rs`：

- account schemes（仅）：`deepseek-account`、`newapi-account`
- key schemes（显示顺序）：`newapi-key`、`opencode-go-key`、`command-code-key`
  - `opencode-go-key`：script = `script_for(for_legacy_kind("opencode-go"))`（即 `/v1/usage` 脚本）；`supports_windows: true`；credentials `[ApiKey]`；label/description key `querySchemes.openCodeGoKey` / `querySchemes.openCodeGoKeyDescription`
  - `command-code-key`：script = `command_code_script()`；`supports_windows: true`；credentials `[ApiKey]`；label/description key `querySchemes.commandCodeKey` / `querySchemes.commandCodeKeyDescription`
- `supports_windows` 语义从「account-only」改为「该方案是否会返回计量窗口」，两个 scope 都可能 true。
- `account_target_urls(base_url)` 只保留账户级目标：DeepSeek `/user/balance`、`{base}/api/user/self`、`{base}/api/user/balance`。移除 opencode `/v1/usage` 与 command code 三个接口——它们现在是合法密钥级目标。
- `KEY_QUERY_ACCOUNT_TARGET_MESSAGE` 文案不变（仍用于 DeepSeek/New API 账户目标）。
- `scheme_script`、`recognise_key_scheme`、`scheme_for` 自动随目录更新；旧 account scheme id（`opencode-go-account` / `command-code-account`）不再被目录识别（历史行由迁移清理；密钥里若存在旧 id 会显示为无法识别的自定义，不重写脚本）。

## 3. Key-scope runtime

`usage_service.rs`：

- 删除 `strip_to_key_usage` 的「剥离窗口」行为，改为 `finalize_key_usage`（命名可保留 `strip_to_key_usage` 但语义必须改；建议重命名以匹配语义）：
  - 保留 `remaining/total/used/unit/is_unlimited/expire_at` 与 `windows`；
  - 「报告了内容」的判定 = 金额类字段任一存在 **或** `windows` 非空；
  - 两者都没有 → `Err`，消息改为「查询未返回当前密钥的额度」（不再有「只返回了周期窗口」分支）。
- 返回 envelope 携带 `windows`（以及空 `groups`）；模块文档更新：窗口不再是 account 专属。
- 账户目标拦截保留：DeepSeek/New API 账户脚本仍拒绝作为密钥额度执行。

`query_test.rs`：

- key scope 结果不再清空 windows：按 account scope 相同方式映射 `usage.windows`；`groups` 仍为空。
- 模块文档与测试同步（原先「密钥窗口被剥离」的用例改为「窗口型答案合法且保留窗口」；command code 脚本作为 key 脚本可通过 guard 并在 fake send 下得到窗口+余额）。

## 4. Provider 契约：queryScope

- Rust `Provider` 增加 `pub query_scope: String`，serde camelCase `queryScope`，`#[serde(default = "account")]`。
- DB：`providers` 建表列 `query_scope TEXT NOT NULL DEFAULT 'account'`；`run_alter_migrations` 追加 `ALTER TABLE providers ADD COLUMN query_scope TEXT NOT NULL DEFAULT 'account'`；`PROVIDER_COLUMNS`、`row_to_provider`、`provider_create` INSERT 同步；`provider_update` 不动该列（保留原值）。
- 新建：`CreateProviderInput` 不新增字段；`provider_create` 由 `preset_id` 经共享 helper 推导：`opencode-go` / `command-code` → `key`，其余（含未知/custom）→ `account`。helper 放 `provider_presets.rs`，例如 `pub fn query_scope_for_preset(preset_id: Option<&str>) -> &'static str`。
- `UpdateProviderInput` 不新增字段（UI 不编辑 scope）；更新保留原值。
- `ExportProvider` 增加 `#[serde(default)] pub query_scope: Option<String>`；导出写入；稳定 ID 导入的 raw INSERT 写入（缺省按预设推导），无稳定 ID 的兼容导入在 `provider_create` 后补一条 UPDATE 保留导出的值。
- TS `Provider.queryScope: QueryScope`；`ProviderPreset.queryScope: QueryScope`（Rust 预设结构同样增加 `query_scope: String`，serde camelCase）。
- 迁移后回退旧版本：旧版忽略新列，回退可见但不会丢数据；CHANGELOG 说明。

## 5. Presets

- `opencode-go`：`query_scope = "key"`；`wallet_balance_type = "none"`、`wallet_balance_url/headers/script = None`、`usage_type = "none"`、`usage_url/headers = None`（其余不变）。
- `command-code`：同上，`query_scope = "key"`，不再携带账户级 script/URL/headers。
- `deepseek`、`newapi`、`custom`：`query_scope = "account"`，其余不变。
- `apply_preset_defaults` 不需要改动 query_scope（由 Provider 落库时按 preset 推导）。

## 6. 数据库迁移

新模块 `src-tauri/src/db/quota_scope_upgrade.rs`，marker `migration.quota-scope.key-level`，`run_migrations` 在 `upgrade_command_code_scripts()` 之后调用（保证 v3.17 模板已升级、`lift_queries_onto_scripts` 已在 alter 阶段完成）。

判定命中的供应商（任一成立）：

1. `wallet_balance_script` 全文等于 shipped opencode-go 脚本或 command-code 脚本；
2. `wallet_balance_type IN ('opencode-go','command-code')`；
3. `preset_id IN ('opencode-go','command-code')`。

对命中行（同一事务）：

```
query_scope = 'key',
wallet_balance_script = NULL, query_config = NULL,
cached_usage = NULL, last_usage_checked_at = NULL,
cached_wallet_balance = NULL, cached_wallet_balance_currency = NULL,
last_balance_checked_at = NULL,
wallet_balance_type = 'none', wallet_balance_url = NULL,
wallet_balance_path = NULL, wallet_balance_headers = NULL,
usage_type = 'none', usage_url = NULL, usage_path = NULL, usage_headers = NULL
```

不写密钥；不删除 token/userId；marker 写入后永不重复执行（用户之后自行配置的账户查询不会被再次清空）。迁移后旧字段为空，`lift_queries_onto_scripts` 不会在下次启动重建脚本（必须在清空时同时清旧 kind/url/headers）。

## 7. Renderer

- `utils/accountQuery.ts`：新增 `providerQuotaIsPerKey(provider)`（`provider.queryScope === 'key'`）。
- `pages/Keys.tsx`：
  - 删除 `balance === undefined && 无窗口` 时的 `providers.queryNow` 链接按钮整块（含 `providerQuotaAction` 分支；CSS 类可删）。
  - `providerQuotaIsPerKey` 时隐藏：账户余额 chip、`providers.configureQuery` 按钮、刷新余额图标、供应商级 ProviderUsageWindows 块。
  - 密钥卡额度条目恢复可点击查询：`refreshingKeyUsageIds` state + `handleRefreshKeyUsage` finally 清理；Tooltip `keys.refreshQuota`、aria-label 同名、spinner `ReloadOutlined spin`；值：`isUnlimited → ∞`，`remaining != null → formatAccountAmount`，存在窗口 → `t('querySchemes.capabilityWindows')`，否则 `t('providers.queryNow')`。
  - 当 `key.cachedUsage.windows/groups` 非空时，在 statsRow 下方渲染 `ProviderUsageWindows`（新 CSS `keyQuotaWindows`）。
- `components/providers/ProviderModal.tsx`：`accountQueryAvailable = (provider?.queryScope ?? preset?.queryScope ?? 'account') === 'account'`；为 false 时隐藏账户查询区（QuerySettingsSection + token/userId 凭据块 + queryError），显示 `providers.keyScopeQueryHint` 提示。预设切换时随之更新。
- `components/query/QuerySettingsSection.tsx`：测试结果中，金额行仅在 `isUnlimited || remaining != null` 时渲染；窗口/分组在 `usage.windows/groups` 非空时渲染（去掉 `scope === 'account'` 条件）。capability 标签继续由 `scheme.supportsWindows` 决定。
- `utils/queryScriptShape.ts`：`ACCOUNT_SCRIPT_MARKERS` 移除 `commandcode.ai/alpha/billing`；保留 `/api/user/self`、`/api/user/balance`、`api.deepseek.com/user/balance`。测试同步（command code 脚本不再提示，New API/DeepSeek 仍提示）。
- locales zh/en：
  - `querySchemes.openCodeGoKey` / `openCodeGoKeyDescription`、`querySchemes.commandCodeKey` / `commandCodeKeyDescription`；移除旧 `openCodeGo` / `commandCodeAccount`（如无引用）。
  - `providers.keyScopeQueryHint`（例如：额度按密钥查询；请在「密钥额度」中为每个密钥选择方案）。
  - 其余复用既有键（`querySchemes.capabilityWindows`、`keys.refreshQuota`、`providers.queryNow`）。

## 8. Tests

Rust：

- `query_schemes`：两 scope 目录 id 断言；key 方案含窗口能力；account targets 不再包含 /v1/usage 与 commandcode；识别；command code key scheme 解析成 3 个具名请求。
- `usage_service`：窗口型密钥答案合法且 envelope 带 windows；deepseek/newapi 账户目标仍被拒；command code 脚本不再被目标 guard 拒绝。
- `query_test`：key draft 保留窗口；command code 脚本可运行（fake send）返回余额+窗口；账户目标仍拒。
- `provider_presets`：opencode/command code 预设不再带账户脚本、`query_scope == "key"`；deepseek/newapi `account`；`apply_preset_defaults` 期望同步。
- `quota_scope_upgrade`：命中判定（脚本/type/preset 三种证据）、清空列、非命中行不动、marker 只跑一次。
- `db_providers`：`query_scope` 默认与按预设推导落库。
- `import_export`：导出/导入保留 queryScope（至少一个断言）。
- 其余因 `Provider` 结构体字面量新增字段而需补 `query_scope` 的测试 fixture。

vitest：

- `Keys.query.test.tsx`：删除「queryNow link action」用例；新增/恢复「密钥额度条目可点击刷新并渲染窗口」；key-scope provider 不显示配置查询/刷新余额。
- `QuerySettingsSection.component.test.tsx`：key scope 现在渲染窗口；capability 标签在 key scheme 为 true；窗口型结果不显示金额行也仍是成功。
- `ProviderModal.component.test.tsx`：queryScope key 时隐藏账户查询区并显示提示；account 时仍显示。
- `KeyEditModal.component.test.tsx`：fixture 补 queryScope；command code 脚本不再出现 legacy alert。
- `queryScriptShape.test.ts`、`accountQuery.test.ts`、各 Provider fixture 补 `queryScope`。
