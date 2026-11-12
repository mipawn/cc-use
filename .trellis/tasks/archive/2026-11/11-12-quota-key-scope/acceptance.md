# 验收记录：额度归属迁移到密钥级

日期：2026-11-12
状态：实现完成，质量门通过（未提交 git）。

## 验收标准

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 / R1：Keys 页供应商摘要区不再有「查询额度」链接按钮，刷新图标是唯一手动入口 | 通过 | `Keys.tsx` 删除 `providers.queryNow` 链接块；vitest `Keys.query.test.tsx > keeps the refresh icon as the only provider-level query trigger`；视觉检查 `noQueryNowLinkText` / `deepseekKeepsProviderRefresh` |
| A2 / R2：key scope 返回 OpenCode Go / Command Code 方案；account scope 不再返回；能力标签标明周期用量 | 通过 | `query_schemes.rs` 目录测试；`QuerySettingsSection` vitest；视觉检查 `goKeyEditorSchemeSelected`、`goKeyWindows` |
| A3 / R3：密钥刷新与 draft 测试保留 windows；OpenCode Go 密钥卡显示 5h/周/月，Command Code 显示 credits + 三项窗口 | 通过 | `usage_service` / `query_test` 单测；`Keys.query.test.tsx` 窗口渲染用例；视觉检查 `key2WindowsAfterRefresh`、`ccKeyCredits`、`ccKeyEditorTestCredits`、`ccKeyEditorTestWindows` |
| A4 / R4：密钥卡额度条目可点击查询，查询中显示加载态，失败不清空已有缓存；已查询出结果后仍保留可见的刷新入口 | 通过 | 额度条目恢复为按钮（`refreshingKeyUsageIds` + 旋转的 `ReloadOutlined`），刷新图标常驻（不再只在查询中显示），Tooltip 显示「刷新额度 + 上次检查时间」；`Keys.query.test.tsx > refreshes this key from its clickable quota stat` 断言查询前后都有 reload 图标；视觉检查 `keyQuotaClickRefreshes`、`keyQuotaClickAddsWindows`、`answeredKeyQuotaHasReloadIcon` |
| A5 / R5：Provider 契约新增 `queryScope`；opencode/command code 预设为 key，其他 account；导出/导入保留 | 通过 | `models::Provider.query_scope`、`ExportProvider.query_scope`；`db_providers` 与 `provider_presets` 集成测试；TS `Provider.queryScope` / `ProviderPreset.queryScope` |
| A6 / R6：迁移只清空出厂账户查询的供应商级配置与缓存，不碰密钥；再次启动不重复；手写脚本保留 | 通过 | `db/quota_scope_upgrade.rs` 9 个单测；在 dev 数据库副本上实际运行迁移：opencode go / command code → `scope=key` 且脚本/配置/缓存清空，其它供应商与全部 api_keys 不变 |
| A7 / R7：key scope 供应商编辑弹窗隐藏账户查询区（仅保留说明），列表隐藏配置查询/刷新余额与账户额度展示 | 通过 | `ProviderModal` 条件渲染 + `providers.keyScopeQueryHint`；`Keys.tsx` 条件隐藏；视觉检查 `goProviderDialogHasKeyHint`、`goProviderDialogHidesAccountQuery`、`newProviderPresetSetsKeyHint`、`goNoProviderRefresh`、`ccNoConfigureQuery` |
| A8 / R8：Command Code 脚本不再触发密钥编辑器「账户级脚本」提示；New API / DeepSeek 仍提示 | 通过 | `queryScriptShape.ts` 移除 commandcode 标记；`queryScriptShape.test.ts`、`KeyEditModal.component.test.tsx`；视觉检查 `ccKeyEditorNoLegacyAlert` |
| A9：格式化 / 类型 / lint / 测试通过 | 通过 | 见下 |

## 质量门

- `cargo fmt --all -- --check` → 通过
- `cargo test --workspace` → 通过（exit 0；workspace 全部测试）
- `cd src-tauri && cargo clippy --all-targets` → 无错误，仅存既有 warning
- `pnpm typecheck` → 0 error
- `pnpm lint` → 0 error / 0 warning
- `pnpm test` → 43 files / 385 tests passed + node scripts 全部通过
- 视觉验证（合成数据、headless Chrome、Tauri IPC 全部 stub、无真实凭据/网络）：
  `.trellis/tasks/11-12-quota-key-scope/visual-check.mjs`，26 项检查全部通过，无 console/page error；
  截图在 `evidence/01..06*.png`

## 迁移实跑（dev 数据库副本）

将 `~/Library/Application Support/com.mipawn.cc-use.dev/data/cc-use.db`（含 WAL）复制到 `/tmp` 后执行启动迁移：

- `opencode go`（preset=opencode-go，原出厂账户脚本）→ `query_scope=key`，`wallet_balance_script` / `query_config` / `cached_usage` / `last_*_checked_at` / 旧版 kind/url/headers 全部清空。
- `command code`（preset=command-code，原出厂三请求脚本）→ 同上。
- 其它自有供应商（含带自定义账户脚本的中转供应商）的自定义脚本与缓存保持原样，`query_scope=account`。
- 全部 `api_keys` 行未被修改（脚本、query_config、缓存、检查时间不变）。
- 迁移仅执行一次（marker `migration.quota-scope.key-level`），之后用户再配置的账户查询不会被重复清空。

## 已知边界

- 用户手写/编辑过的 OpenCode Go / Command Code 账户脚本不会被迁移清空：它们保留原文并继续账户级查询（符合「编辑过的脚本是保存的选择」原则）。需要密钥级额度时，用户在密钥「密钥额度」中选择内置方案。
- provider 预设来源为 custom 但持有出厂账户脚本的老数据仍可被脚本全文识别命中（用户实际数据即属此情形）。
- 未运行真实 Tauri 窗口与真实上游查询（避免使用真实密钥/网络）；迁移行为已通过 dev 数据库副本与单元/集成测试验证，UI 行为已通过 vitest + 合成数据视觉验证。
- 未提交 git；`CHANGELOG.md` [Unreleased] 与 `.trellis/spec/cc-use/backend/query-script.md` 已同步。
