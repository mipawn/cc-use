# Implementation Plan: Client Profile Decoupling & UX Overhaul (Scheme A)

## Stage 1: Backend Schema, Migration, Runtime & IPC
- [ ] Add `ClientProfile`, `ClientProfileConnectionConfig`, `CreateClientProfileInput`, `UpdateClientProfileInput` to `src-tauri/src/models/mod.rs`.
- [ ] Add `client_profiles` table + `client_profile_id` column on `proxy_sessions`, `managed_instances`, `project_client_bindings` in `src-tauri/src/db/mod.rs` (both CREATE and idempotent ALTER).
- [ ] Implement `src-tauri/src/db/client_profiles.rs` CRUD, reorder, and active-session binding sync on profile key switch.
- [ ] Implement `src-tauri/src/db/client_profile_migration.rs` (`migration.clientProfiles.v1`, transactional, lossless, backfills active sessions/instances/bindings).
- [ ] Add `alias_table_key_for_profile` in `src-tauri/src/shared_runtime/model_mapping.rs` and single-client mapping helpers.
- [ ] Update `src-tauri/src/proxy/handler.rs` and `src-tauri/src/services/model_catalog.rs` to resolve `client_profile_id` (model_config, connection_config, profile-scoped alias table, skip `api_key.types` gate when profile-backed).
- [ ] Update `src-tauri/src/commands/desktop_connection.rs`, `codex_config.rs`, `claude_desktop_config.rs` to support `client_profile_id` on apply/state/sync (keeping legacy callers 100% compatible).
- [ ] Update `src-tauri/src/terminal/mod.rs`, `commands/managed_instances.rs`, `commands/terminal.rs`, and `crates/cc-use-cli/src/cmds.rs` to support `client_profile_id` launch preview, launch, assignment switch, and CLI profile picker.
- [ ] Add `src-tauri/src/commands/client_profiles.rs` and register commands in `src-tauri/src/lib.rs`.
- [ ] Update `src-tauri/src/services/import_export.rs` for optional `client_profiles` round-trip.
- [ ] Write Rust unit & integration tests (migration, CRUD, proxy profile resolution + alias isolation, desktop profile apply/sync, CLI profile selection).
- [ ] Gate: `cargo test --workspace && cargo clippy --workspace && cargo fmt --all -- --check`.

## Stage 2: Frontend Types, API Bridge, Store, Fixtures & Locales
- [ ] Mirror `ClientProfile*` types and `DesktopRoute.profileId` in `src/shared/types/index.ts`.
- [ ] Update `src/renderer/api/types.ts`, `src/renderer/api/index.ts`, and `src/renderer/api/__tests__/index.contract.test.ts`.
- [ ] Create `src/renderer/stores/clientProfileStore.ts` and hook into `src/renderer/stores/reloadStores.ts`.
- [ ] Update `src/renderer/dev/fixtureData.ts` & `src/renderer/dev/fixtureApi.ts` with `clientProfile` namespace + multi-account OpenCode Go & multi-profile scenarios.
- [ ] Add complete `zh.ts` and `en.ts` locale keys.

## Stage 3: Frontend UX Overhaul
- [ ] Refactor `ProviderModelModal` into reusable `ProviderModelCatalogPanel` + modal wrapper.
- [ ] Redesign `src/renderer/pages/Keys.tsx` into Master-Detail workspace (left sortable provider rail + right 3-tab workspace: Keys/Accounts, Model Catalog, Provider Settings) + simplified Key create/edit modal showing referencing profiles/gateways.
- [ ] Build `ClientProfileCard` (with 1-click inline key switcher) and `ClientProfileDrawer` (clean 3-step Model Settings, live route preview, collapsed upstream rewriting & connection overrides, inline catalog modal trigger).
- [ ] Build `ClaudeGlobalPrefsPanel` (structured common fields + JSON toggle + statusline).
- [ ] Build dedicated client pages: `ClaudeCodePage`, `GrokPage`, `DesktopClientPage` (Codex & Claude Desktop with profile cards + full Desktop connection contract).
- [ ] Upgrade `GatewayPage` with inline LAN toggle/addresses and inline provider catalog fetch button.
- [ ] Update `Sidebar.tsx`, `App.tsx`, and `workspaceNavigation.tsx` (new navigation grouping + legacy route redirects).

## Stage 4: Verification, Browser E2E & Safe Prod→Dev DB Sync
- [ ] Update/add frontend tests so `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build:frontend` are 100% green.
- [ ] Re-run full Rust gate (`cargo fmt --all -- --check`, `cargo clippy --workspace`, `cargo test --workspace`).
- [ ] Start isolated fixture preview (`VITE_CC_USE_FIXTURE=1`) and run browser verification across all pages & key flows (overview, keys master-detail, Claude Code profiles & inline key switch, Codex/Claude Desktop profiles, Grok, Gateway, Stats/Console, Settings) checking zero errors & zero fixture violations.
- [ ] Safely mirror production SQLite DB to dev DB via `.backup()` (zero secret reading/output) and verify migration completes cleanly on the dev DB copy.
- [ ] Update `.trellis/spec/` and `CHANGELOG.md` if warranted.
