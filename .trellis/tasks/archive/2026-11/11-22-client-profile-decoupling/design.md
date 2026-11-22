# Technical Design: Client Profile Decoupling & UX Overhaul (Scheme A)

## 1. Data Model & SQLite Schema

### 1.1 New Table: `client_profiles`

Added to `db/mod.rs::run_migrations()` (`CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS client_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client_kind TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    model_config TEXT,
    connection_config TEXT,
    launch_env TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_profiles_kind ON client_profiles(client_kind, sort_order);
CREATE INDEX IF NOT EXISTS idx_client_profiles_key ON client_profiles(api_key_id);
```

### 1.2 Additive Columns (Idempotent ALTER + CREATE)

- `proxy_sessions`: `client_profile_id TEXT`
- `managed_instances`: `client_profile_id TEXT`
- `project_client_bindings`: `client_profile_id TEXT`

All added to both `CREATE TABLE IF NOT EXISTS` and `run_alter_migrations()` `alter_statements`.

### 1.3 JSON Payloads inside `client_profiles`

1. `model_config` (stored as normalized JSON string, parsed via `shared_runtime::model_mapping`):
   - Reuses the exact v2 single-client model schema `{ version: 2, clients: { [client_kind]: { catalog, upstream, model? } } }` so **zero behavioral drift** occurs in `model_mapping.rs`, `effective_catalog_ex`, `upstream_mapping`, `client_role_entries`, `auto_mode_classifier_model`, `grok_client_model`, and `client_default_model`!
   - Why reuse v2 shape inside `model_config`? Every existing battle-tested Rust helper in `shared_runtime/model_mapping.rs` works out of the box with zero subtle edge-case regressions on 1M suffix, namespacing (`claude-` prefix), Desktop canonical role routes, family forwarding, and auto-mode classifier!
2. `connection_config` (`Option<ClientProfileConnectionConfig>`):
   ```rust
   #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
   #[serde(rename_all = "camelCase")]
   pub struct ClientProfileConnectionConfig {
       #[serde(default)]
       pub base_url: Option<String>,
       #[serde(default)]
       pub auth_scheme: Option<String>, // None = client default; Some("bearer" | "x-api-key" | "none")
       #[serde(default)]
       pub user_agent: Option<String>,
   }
   ```
3. `launch_env` (`Option<serde_json::Value>`):
   - JSON object of environment variable overrides for `claude_code` (replaces `api_key.config`). `null` values suppress a global default env var (preserving existing `launch_preview.rs` semantics).

### 1.4 One-Shot Lossless Migration (`migration.clientProfiles.v1`)

Runs in `db/client_profile_migration.rs`, invoked from `db/mod.rs::run_migrations()` after `run_alter_migrations()` and data cleanups:
- Guarded by settings key `migration.clientProfiles.v1`.
- Runs inside a single `unchecked_transaction()`.
- For each provider (ordered by `sort_order, name`) and each `api_key` (ordered by `priority, id`):
  - Compute effective legacy client kinds from `api_key.types` (normalized `'claude' -> 'claude_code'`, defaulting empty to `['claude_code']`, excluding `'grok'` for official DeepSeek).
  - For each `client_kind`:
    - Build profile name: if provider has 1 key → `provider.name`; else `{provider.name} · {key.alias || Key N}`.
    - Extract single-client `model_config` JSON (using `model_mapping` scoped to `client_kind`, preserving `autoMode` for `claude_code`).
    - Extract `connection_config` from `api_key.client_configs[client_kind]` (`baseUrl`, `authScheme`, `proxyUserAgent` -> `userAgent`).
    - Extract `launch_env` from `api_key.config` if `client_kind == "claude_code"`.
    - Insert `client_profiles` row.
    - Backfill `client_profile_id` on:
      - `proxy_sessions` where `session_kind != 'gateway'` AND `api_key_id = key.id` AND normalized `cli_type = client_kind` AND `client_profile_id IS NULL`.
      - `managed_instances` where `api_key_id = key.id` AND normalized `cli_type = client_kind` AND `client_profile_id IS NULL`.
      - `project_client_bindings` where `api_key_id = key.id` AND normalized `cli_type = client_kind` AND `client_profile_id IS NULL`.
- Mark `migration.clientProfiles.v1 = "1"` and commit.

### 1.5 Alias Table Isolation

Add `alias_table_key_for_profile(profile_id: &str) -> String`:
- `"model-alias-map.profile.{profile_id}"`
- When a session or desktop config uses a `ClientProfile`, catalog serving and inference alias lookup use `alias_table_key_for_profile(profile_id)`.
- Legacy sessions without `client_profile_id` continue using `alias_table_key(api_key_id, kind)`.
- Result: two Claude Code / Claude Desktop profiles bound to the same `ApiKey` never clobber each other's alias tables.

## 2. Backend Commands, Proxy, Desktop & CLI Integration

### 2.1 Rust Models & DB Module

- New `src-tauri/src/db/client_profiles.rs`:
  - `client_profile_list(client_kind: Option<&str>) -> Result<Vec<ClientProfile>>`
  - `client_profile_get(id: &str) -> Result<Option<ClientProfile>>`
  - `client_profile_create(input: &CreateClientProfileInput) -> Result<ClientProfile>`
  - `client_profile_update(input: &UpdateClientProfileInput) -> Result<ClientProfile>`
  - `client_profile_delete(id: &str) -> Result<()>`
  - `client_profile_reorder(client_kind: &str, ids: &[String]) -> Result<()>`
- New `src-tauri/src/commands/client_profiles.rs`:
  - `client_profile_list`, `client_profile_get`, `client_profile_create`, `client_profile_update`, `client_profile_delete`, `client_profile_reorder`
  - `client_profile_update` checks if the updated profile is currently bound to an active `codex` or `claude_desktop` desktop connection; if so, updates the desktop session binding (if `provider_id`/`api_key_id` changed) and calls `refresh_taken_over_profile_after_profile_edit` (preserving the independent `syncFailure` contract — a sync failure never turns a successful profile save into an error!).
  - Validation: `name` non-empty, `client_kind` in `claude_code | grok | codex | claude_desktop`, provider and key exist & belong together, `base_url` valid http(s) without credentials/query/fragment, `user_agent` without CR/LF, `auth_scheme` in `bearer | x-api-key | none`.
- Register all 6 commands in `src-tauri/src/lib.rs` and mirror in `src/shared/types/index.ts`, `src/renderer/api/types.ts`, `src/renderer/api/index.ts`, `src/renderer/api/__tests__/index.contract.test.ts`, and `src/renderer/dev/fixtureApi.ts`.

### 2.2 Proxy Handler (`src-tauri/src/proxy/handler.rs`)

- In `resolve_session_resources`:
  - If `session.client_profile_id` is `Some(pid)`: load `ClientProfile`. Verify `provider.is_active && api_key.is_active && !api_key.is_exhausted && api_key.provider_id == provider.id`. Skip legacy `api_key.types` check because the profile explicitly targets `client_kind`!
  - If `session.client_profile_id` is `None`: keep exact legacy checks.
- In `build_route_execution`:
  - When `client_profile` is present (and non-gateway):
    - `mapping = profile.model_config.clone()`
    - `base_url = profile.connection_config.base_url.unwrap_or(provider.base_url)`
    - `auth_scheme = profile.connection_config.auth_scheme`
    - `user_agent = profile.connection_config.user_agent`
    - `aliases` loaded from `alias_table_key_for_profile(&profile.id)`
    - Store `client_profile_id: Option<String>` on `RouteExecution` so `/v1/models` catalog serving also reads `profile.model_config` and `profile.connection_config` and persists aliases under `alias_table_key_for_profile(&profile.id)`!
- When a user switches a `ClientProfile`'s `api_key_id` (e.g. rotating OpenCode Go accounts):
  - Also update any active `proxy_sessions` referencing `client_profile_id = profile.id` (including desktop sessions and active managed instances) inside the DB transaction so switching key on a profile takes effect immediately on subsequent requests!

### 2.3 Desktop Connection (`commands/desktop_connection.rs`, `codex_config.rs`, `claude_desktop_config.rs`)

- Extend `DesktopRoute` with `#[serde(default)] pub profile_id: Option<String>`.
- Extend `desktop_connection_apply` with optional `client_profile_id: Option<String>` (Tauri optional arg; omitted preserves full backward compatibility for existing callers/tests!).
- When `client_profile_id` is provided:
  - Load `ClientProfile`, verify `profile.client_kind == client_kind.as_str()`, verify provider & key active/non-exhausted.
  - Use `profile.model_config` and `profile.connection_config` to synthesize Codex catalog/default model or Claude Desktop 4 role slots & alias table (under `alias_table_key_for_profile`), and persist `client_profile_id` on the desktop `proxy_sessions` row.
  - Note: Keep `codex_config.rs` and `claude_desktop_config.rs` helper functions taking an effective `(mapping: Option<&str>, client_configs/connection_config, alias_key: &str)` so BOTH profile-based and legacy key-based calls share one single implementation!

### 2.4 Terminal Launch & Managed Instances & CLI

- `terminal_get_launch_preview` accepts optional `client_profile_id: Option<String>`:
  - When provided, uses `profile.launch_env` + `profile.model_config` (autoMode) merged over `settings.claude_config`!
- `managed_instance_update_assignment` accepts optional `client_profile_id: Option<String>` (when switching an active instance to a profile, updates `provider_id`, `api_key_id`, and `client_profile_id` on both `managed_instances` and `proxy_sessions`).
- `crates/cc-use-cli/src/cmds.rs`:
  - `cc-use claude` / `cc-use grok`: queries `db.client_profile_list(Some(client_kind))` filtered to active providers + active non-exhausted keys.
  - If profiles exist: displays clean profile choices (`Profile Name  [Provider / Key Alias]  quota`) and launches with `client_profile_id = Some(profile.id)`.
  - If no profiles exist (e.g. legacy test fixture): falls back seamlessly to `compatible_keys`!

### 2.5 Import / Export

- `ExportData` adds `#[serde(default)] pub client_profiles: Vec<ExportClientProfile>`.
- Export writes `client_profiles` (referencing provider name + key alias/index, never leaking secrets when `include_api_keys = false`).
- Import restores `client_profiles` if present, or runs profile derivation for legacy exports.

## 3. Frontend Information Architecture & Components

### 3.1 Navigation (`Sidebar.tsx` & `App.tsx`)

- `/` — `Dashboard` (概览)
- **接入与使用**:
  - `/clients/claude-code` — `ClaudeCodePage` (Tabs: `启动方案`, `运行实例`, `会话管理`, `全局偏好与状态栏`)
  - `/clients/codex` — `DesktopClientPage` (`clientKind='codex'`)
  - `/clients/claude-desktop` — `DesktopClientPage` (`clientKind='claude_desktop'`)
  - `/clients/grok` — `GrokPage` (Tabs: `启动方案`, `运行实例`)
  - `/gateway` — `GatewayPage` (API 网关 + 顶部局域网快捷开关 + 就地拉模型清单)
- **上游资源**:
  - `/keys` — `Keys` (Master-Detail 供应商与密钥工作区: 左栏供应商列表 + 右侧 3 Tab `密钥 / 账号`、`模型清单`、`供应商设置`)
- **观测**:
  - `/stats`, `/console` — `ActivityPage` (unchanged)
- **底部**:
  - `/settings` — `Settings` (unchanged)
- **Legacy redirects** in `App.tsx`:
  - `/claude-code` → `/clients/claude-code`
  - `/grok-build` → `/clients/grok`
  - `/codex` → `/clients/codex`
  - `/claude-desktop` → `/clients/claude-desktop`
  - `/instances` → `/clients/claude-code?tab=instances` (or `/clients/grok?tab=instances` if `?client=grok`)
  - `/desktop` → `/clients/codex` (or `/clients/claude-desktop` if `?client=claude_desktop`)

### 3.2 Key Reusable Frontend Components

1. `src/renderer/stores/clientProfileStore.ts` — Zustand store for `ClientProfile[]` (CRUD, reorder, optimistic/safe error handling, registered with `reloadMigratedStores`).
2. `src/renderer/components/clients/ClientProfileDrawer.tsx` — Focused, client-specific profile editor Drawer:
   - Header + Name + Provider/Key selector (with quick account switch that preserves all settings)
   - Clean 3-step Model Settings (Client visible scope + client-native controls + collapsed-by-default Upstream Rewriting with live route preview `客户端请求 → 代理改写 → 上游地址`)
   - Collapsed-by-default Connection Override (`Base URL`, `Auth Scheme`, `User-Agent`)
   - Claude Code-specific: Launch Env Preview modal (read-only) + Other Startup Env JSON collapsible + Auto Mode collapsible
   - Inline button to open `ProviderModelModal` when catalog is empty or needs refresh!
3. `src/renderer/components/clients/ClientProfileCard.tsx` — Clean card showing:
   - Profile title + Active/Bound badge
   - Bound `Provider / Key` with **inline quick key switcher dropdown** (rotates among active keys of the same provider in 1 click!)
   - Quota snapshot of the bound key
   - Concise model & connection summary
   - Actions: Apply (Desktop) / Switch Key / Edit / Duplicate / Delete
4. `src/renderer/components/clients/ClaudeGlobalPrefsPanel.tsx` — Upgrades `GlobalConfigModal` from raw JSON to **Structured Common Settings Form** (`ANTHROPIC_MODEL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`, `API_TIMEOUT_MS`) + **Advanced JSON Editor** toggle (bi-directional sync).
5. `src/renderer/pages/Keys.tsx` — Master-Detail Provider & Keys Workspace:
   - Left sortable provider rail + `+ 添加供应商`
   - Right workspace header (provider name, status switch, health, actions) + 3 clean Tabs:
     - `密钥 / 账号`: Clean key cards showing alias, active switch, quota/windows, today/total tokens, referencing profiles/gateways tags, edit/delete/usage/requests; simplified `KeySimpleModal` (alias, value, key quota only — NO client types/model mapping/connection tabs!)
     - `模型清单`: Embedded full-width `ProviderModelCatalogPanel` (refactored out of `ProviderModelModal` so both the tab AND inline quick modal reuse the exact same component!)
     - `供应商设置`: Embedded `ProviderSettingsPanel` (basic info, icon, account quota, HTTP proxy, request headers, Responses rectifier)

## 4. Rollout & Verification Plan

1. **Stage 1 (Backend Core & Migration)**: DB schema, `client_profiles` table & CRUD, lossless migration `migration.clientProfiles.v1`, `proxy/handler.rs` profile resolution + isolated alias tables, `desktop_connection.rs` / `codex_config.rs` / `claude_desktop_config.rs` profile support, `terminal/mod.rs` & `cc-use-cli` profile launch, Tauri commands & IPC contract. Verify with `cargo test --workspace` + `cargo clippy --workspace`.
2. **Stage 2 (Frontend API, Store, Fixtures, i18n)**: Shared TS types, `api/types.ts`, `api/index.ts`, contract tests, `clientProfileStore`, `fixtureData.ts` & `fixtureApi.ts` updated with realistic Scheme A profiles & OpenCode Go multi-account data, full `zh.ts` & `en.ts` locales.
3. **Stage 3 (Frontend Pages & Components)**:
   - Master-Detail `Keys.tsx` (3 Tabs: Keys, Model Catalog, Provider Settings) + simplified Key modal.
   - `ClientProfileDrawer` & `ClientProfileCard` (redesigned 3-step Model Settings + live route preview + inline key switcher).
   - Dedicated pages: `ClaudeCodePage`, `GrokPage`, `DesktopClientPage` (Codex & Claude Desktop), upgraded `GatewayPage` (inline LAN toggle + inline catalog modal), `ClaudeGlobalPrefsPanel`, updated `Sidebar` & `App.tsx` routes.
4. **Stage 4 (Testing, E2E & Safe Prod→Dev Sync)**:
   - Update & expand frontend unit/component tests (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build:frontend`).
   - Run Rust full gate (`cargo fmt --all -- --check`, `cargo clippy --workspace`, `cargo test --workspace`).
   - Run isolated browser fixture server (`VITE_CC_USE_FIXTURE=1`) and test every screen & interactive flow in browser (zero console/page errors, zero isolation violations, responsive layout verified).
   - Safely mirror prod DB → dev DB via SQLite `.backup()` (zero secret reading/printing!) and verify migration succeeds cleanly on the dev DB copy.
