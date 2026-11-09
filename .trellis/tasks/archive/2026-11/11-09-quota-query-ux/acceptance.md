# Acceptance Evidence — 统一供应商与密钥额度查询交互

日期：2026-11-10 00:40
分支：`main`（工作树，v3.17.0 基线上保留 Command Code 修复未提交改动）
任务：`.trellis/tasks/11-09-quota-query-ux`

## Automated gates

| 命令 | 结果 |
| --- | --- |
| `cargo test --workspace` | 通过，693 tests / 0 failed（新增 query_schemes/query_test/db_query_invalidation 套件） |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets` | 相对 v3.17.0 基线 worktree 逐一比对，**无新增警告**（其中一项既有类别计数减少） |
| `pnpm typecheck`（tsc --noEmit） | 通过，0 error |
| `pnpm lint`（eslint src） | 通过，0 error / 0 warning |
| `pnpm exec vitest run` | 通过，43 files / 375 tests（含新增 QuerySettingsSection / queryScriptShape / contract 用例） |
| `pnpm build:frontend` | 通过 |
| zh/en 键位 parity（i18n spec 片段） | 与既有 drift 完全一致，无新增缺口 |
| 触碰文件 prettier | 干净（consoleLogBridge 两个文件为仓库既有未格式化债务，未触碰） |

## Per-criterion evidence

### A1（默认代码隐藏：方案选择即可完成配置）

- `src/renderer/components/query/QuerySettingsSection.tsx`：代码仅存在于显式「自定义脚本」或「基于此方案自定义」入口（`editorOpen && !schemeStateIsPure`）；`QuerySettingsSection.component.test.tsx` 覆盖命名方案选择 → 不见代码、开关不隐式开启（D3）。
- `ProviderModal.component.test.tsx`：新供应商打开 OFF+空文本；`KeyEditModal.component.test.tsx`：create 不再出现 starter 脚本（`apiKeyEditor` fallback 改 `''`）。

### A2（密钥只查自身额度，无账户数据冒名）

- 后端目录隔离：`query_schemes.rs` 测试断言账户脚本永不进入密钥目录、目录中密钥方案仅 `newapi-key` 且不携带 `supportsWindows`。
- 运行时强制：`usage_service.rs::guard_key_scope_targets`（账户端点 URL 证据拒跑，命令测试覆盖 Command Code / New API 账户模板）+ `guard_key_scope_credentials`（拒绝 {{accessToken}}/{{userId}}，密钥级文案）；`vars_for` 不借供应商 token/userId（测试 `the_key_scope_borrows_no_account_credential`）。
- 结果剥离：`strip_to_key_usage` — 仅窗口返回 → 报错（`a_window_only_answer_is_not_this_key_s_quota`）；UI 双保险：Keys.tsx 密钥卡已移除 `ProviderUsageWindows`，QuerySettingsSection 仅 account scope 渲染窗口（测试断言）。
- 草稿测试 `query_test.rs`：key 作用域拒绝任何 borrow（`a_key_draft_never_borrows_the_saved_fallback`）。

### A3（缺失/关闭状态可执行解释）

- 凭据镜像能力标签：scheme credentialRequirements → `querySchemes.credential*` Tags；ProviderModal token/userId 仅按所选方案/脚本实际引用显示。
- 关闭状态信封：「额度查询已关闭」（balance/usage 服务 disabled）、「尚未配置…」（not_configured）、「请先填写或保存当前 API 密钥」（key scope）、账户借用缺钥 → 「添加并启用 API 密钥后可查询额度」（`query_test`/`balance_service` 测试断言文案）。
- 无独立适配说明：密钥目录仅 New API；无方案时选择器占位 + customHint（组件测试）。

### A4（草稿显式测试、无持久化、不泄露、不虚构 0）

- `services/query_test.rs`：全流程不落库（核查点：service 不引用 Database；命令 `query_test` 只读 fallback 凭据 under 短锁）；无缓存/时间写入路径。
- 凭据脱敏：`a_failure_message_never_echoes_a_draft_credential`；结果仅规范化字段（usage/isValid/invalidMessage/error），无原始 response/headers/带凭据 URL。
- 失败语义：无效答案 usage=None + is_valid=false（`an_account_draft_relays_the_script_s_invalidation_reason`、引擎空值路径）；无虚构 0。
- 测试仅用户显式触发（按钮），输入 revision guard 丢弃迟到响应（组件测试）。

### A5（重开/编辑/复制/导入导出保留；旧脚本不覆盖）

- D4 保留：DB 侧 `closing_and_reopening_keeps_script_and_config`（disabled 保留 script+scheme）；disabled 信封走 ConfigGate（`a_disabled_quota_says_so_instead_of_running`）。
- 分布：`KeyEditModal` edit/duplicate 从 key.queryConfig ?? effectiveQuery 恢复、duplicate 继承完整查询配置（组件测试 `duplicate inherits newapi-key config exactly`）；`buildDuplicatedKeyDraft` spread 携带 queryConfig。
- Import/export：ExportProvider/ExportApiKey 增列；import 两条路径（保 ID / 新 ID）逐字段传递（`import_export.rs`）；导出自带 queryConfig（含禁用状态）。
- 旧脚本原文：识别仅整字匹配（`recognition_is_whole_text_only`：一处注释即 custom）；ProviderModal legacy 识别仅显示层且 touched 后停用；account-shaped 旧密钥脚本 Alert 提示不重写（组件测试）。

### A6（配置改变后旧结果失效，测试结果随输入失效）

- DB 同事务清空：`db_query_invalidation.rs` 7 tests（地址变更同时清供应商+密钥缓存；无关保存不清；借用凭据移位清供应商缓存）。
- 异步 guard：`balance_refresh` / `key_usage_refresh` 写回前重读快照，配置/凭据/地址漂移则丢弃该结果；DB 清空与迟到写回的复活路径由「清空 → 重读不一致 → return」链路覆盖。
- 草稿测试 revision（QuerySettingsSection）+ `onDraftTest` identity 作为输入新鲜度信号（KeyEditModal：修改 key value 即重建；ProviderModal：地址/代理/token/userId 变即重建）。
- UI 保存后刷新触发扩展：Keys.tsx `handleSaveKey` 增加 value/queryConfig 变更判定。

### A7（查询区改动不触非查询配置）

- `ProviderModal.component.test.tsx` A7 用例：切方案/自定义不改 name/icon/baseUrl/requestHeaders；preset 复用既有「全量字段」语义未变。
- 后端对应：`query_config` 仅经显式输入替换（Update 语义 Some→replace / 无缺省保留），provider_update 以字段对照清缓存，不动其他列。

## Verification scope 之外的遗留

- 原生 Tauri WebView 内的手工验收（真实供应商联调截图、无溢出/暗色视觉）本轮无法自动化：**留给用户按需人工复查**，任何断言只覆盖到离线 fixture 等价层。
- 真实密钥未读写：所有测试使用合成 fixture/temp assembler 数据。
