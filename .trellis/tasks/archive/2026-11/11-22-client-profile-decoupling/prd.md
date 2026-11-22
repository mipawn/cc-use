# PRD: Client Profile Decoupling & UX Overhaul (Scheme A)

## Background & Problem Statement

Currently, `cc-use` stores all heterogeneous client configurations (Claude Code per-launch environment variables, model discovery/rewriting, auto-mode classifier; Claude Desktop 4 canonical role slots; Codex Desktop catalog & default model; Grok startup model; per-client connection overrides) directly inside `api_keys`, while `Gateway` is modeled as a separate entity referencing a provider + key.

This causes severe UX and mental-model friction:
1. **Overloaded Key Editor**: Editing an API key requires navigating a 960px modal with 3 tabs, 4 client accordions, and nested sub-views that hijack the modal footer.
2. **Multi-Account Duplication**: For key-scoped multi-account services (e.g. OpenCode Go with 5 people's accounts), identical client settings must be configured 5 times, and switching accounts requires duplicating/re-editing.
3. **Single-Key Multi-Setup Conflict**: Running two different Claude Code local env/model setups on the same API key forces users to duplicate the key record, splitting quota and token statistics.
4. **Fragmented Model Settings**: Model catalog is hidden in a provider `...` menu; client model menu, local startup env vars, and proxy upstream rewriting are mashed together with colliding names (e.g. Sonnet/Opus/Haiku tier env vs family forwarding); Claude Code global defaults live in a raw JSON box in an unrelated Instances drawer.
5. **Disconnected Navigation**: Gateway floats between Management and Observation; Desktop and Instances screens lack direct access to configure the active route's models/connections.

## Goals

1. **Decouple Credentials from Client Usage (Scheme A)**:
   - **Provider**: Owns service identity, default base URL, HTTP proxy, extra request headers, Responses rectifier, account-level quota, and the **first-class Provider Model Catalog**.
   - **API Key (Account)**: Lightweight credential (`alias`, `value`, `isActive`, `isExhausted`, per-key quota). No client model/env/connection clutter.
   - **Client Profile (`client_profiles`)**: First-class per-client configuration entity (`claude_code`, `grok`, `codex`, `claude_desktop`) that references a `providerId + apiKeyId` and owns ONLY that client's native settings (connection override, model menu/roles/default/rewriting, and `launchEnv` for Claude Code).
   - **Gateway**: Unchanged conceptual model (independent outlet referencing `providerId + apiKeyId`, with own connection override and model exposure policy), enhanced with inline LAN toggle and inline catalog fetch.

2. **Redesign Information Architecture & UX**:
   - **Sidebar**:
     - `概览` (`/`)
     - `接入与使用`: `Claude Code` (`/clients/claude-code`), `Codex Desktop` (`/clients/codex`), `Claude Desktop` (`/clients/claude-desktop`), `Grok Build` (`/clients/grok`), `API 网关` (`/gateway`)
     - `上游资源`: `供应商与密钥` (`/keys`)
     - `观测`: `用量统计` (`/stats`), `实时控制台` (`/console`)
     - `设置` (`/settings`)
   - **Providers & Keys Master-Detail Workspace (`/keys`)**:
     - Left sortable provider sidebar + right 3-tab workspace: `密钥 / 账号`, `模型清单` (promoted to first-class tab!), `供应商设置`.
     - Lightweight Add/Edit Key modal (alias, secret, key-scope quota only).
     - Key cards show referencing profiles/gateways and per-key quota windows.
   - **Dedicated Per-Client Pages**:
     - **Claude Code**: Tabs for `启动方案` (cards with 1-click inline key switcher for same-provider account rotation + clean Drawer editor), `运行实例`, `会话管理`, `全局偏好与状态栏` (structured form + JSON toggle).
     - **Codex Desktop**: Desktop connection status card (preserving full Desktop contract) + Codex profile cards (1-click apply/switch, inline key swap, clean Codex Drawer editor).
     - **Claude Desktop**: Desktop connection status card + Claude Desktop profile cards (4 canonical role slots editor in clean Drawer).
     - **Grok Build**: Tabs for `启动方案` + `运行实例`.
   - **Redesigned Model Settings**:
     - Step 1: Client visible model scope (`跟随供应商全部模型` vs `仅开放指定模型`, with inline link/modal to manage provider catalog).
     - Step 2: Client-native model controls (Claude Code default model + tier env vars; Codex default model; Claude Desktop 4 role slots; Grok startup model).
     - Step 3: Upstream proxy rewriting (collapsed by default: `原样透传` / `统一改写` / `按家族改写`, with live route preview `请求 → 改写 → 上游`).
     - Step 4: Connection override (collapsed by default: inherits provider).

3. **Lossless Migration & Backward Compatibility**:
   - One-shot transactional DB migration (`migration.clientProfiles.v1`) automatically creates `client_profiles` from every existing `api_key` × enabled `client_kind`, backfilling `client_profile_id` on active desktop sessions, active managed instances, and project bindings.
   - Legacy `api_keys` columns remain intact; legacy sessions without `client_profile_id` continue to work identically.
   - Legacy routes (`/instances`, `/desktop`, `/claude-code`, `/grok-build`, `/codex`, `/claude-desktop`) redirect cleanly.
   - CLI (`cc-use claude`, `cc-use grok`) selects and launches via `client_profiles` when present, with full fallback to legacy keys.

4. **Security & Testing**:
   - Production DB is NEVER queried for secret values; syncing prod → dev uses pure SQLite `.backup()` without reading/printing any credentials.
   - Full automated test coverage: Rust workspace tests (`cargo test --workspace`), frontend vitest + typecheck + lint + build, and isolated browser fixture E2E verification (`VITE_CC_USE_FIXTURE=1`).

## Non-Goals

- Multi-key automatic failover/load balancing inside Gateway or Proxy (explicit single bound key per session/profile remains authoritative).
- Removing legacy `api_keys` columns from SQLite (keep for downgrade/import compatibility).
- Touching real external desktop client files or production DB credentials during automated testing.

## Acceptance Criteria

1. Adding a new OpenCode Go account key takes only `alias + value` (and optional key quota); switching a Claude Code profile from Key A to Key B preserves all local env vars, model config, and connection overrides.
2. Two Claude Code profiles can bind the same `ApiKey` with completely different `launchEnv` and model mappings without duplicating the key or colliding alias tables.
3. Provider model catalog is directly accessible as a first-class tab in `/keys`, and reachable inline from Client Profile and Gateway editors when empty.
4. `KeyEditModal` no longer contains client-type multiselect, model mapping accordions, or per-client connection tabs.
5. `Claude Code`, `Codex Desktop`, `Claude Desktop`, `Grok Build`, and `API 网关` each live under `接入与使用` with zero cross-client clutter.
6. Desktop takeover/switch/restore/sync preserves the entire `desktop-connection.md` contract (atomic rollback, partial state, reopen notice, key/profile edit sync).
7. `cargo test --workspace`, `cargo clippy --workspace`, `cargo fmt --all -- --check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:frontend`, and browser E2E checks in isolated fixture mode all pass.
