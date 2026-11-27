# Implementation Plan: Antigravity CLI and Desktop Usage Statistics

## Execution Order

### Step 1: Schema, Cache Table Module & Models
1. Update `src-tauri/Cargo.toml`: add `notify` crate (macOS `FSEvents`).
2. Update `src-tauri/src/db/mod.rs`:
   - Register `pub mod antigravity_usage;`.
   - Add `antigravity_sync_files` (with `db_size`, `db_mtime_ns`, `wal_size`, `wal_mtime_ns`) and `antigravity_usage_events` (with `thinking_tokens`, `response_tokens`, `ttft_ms`, `generation_ms`, `total_ms`, `UNIQUE(source, conversation_id, response_key)`) + indexes in `run_migrations()`.
3. Create `src-tauri/src/db/antigravity_usage.rs`:
   - Implement `antigravity_sync_state_map`, `antigravity_sync_apply_conversation` (short per-conversation transaction), `antigravity_sync_prune_missing`, and `antigravity_usage_cleanup_old`.
   - Add unit tests in `antigravity_usage.rs` covering atomic replacement, WAL fingerprint storage, and 365-day retention cleanup.
4. Update `src-tauri/src/models/request_log_filter.rs` and `src-tauri/src/models/mod.rs`:
   - Add `RequestLogSource` (`proxy` | `antigravity_desktop` | `antigravity_cli`) and `source: Option<RequestLogSource>` to `RequestLogFilter` (`deny_unknown_fields`).
   - Add `performance_mixed_sources: bool` to `UsageStatsSummary`, `source`, `thinking_tokens`, `response_tokens`, `generation_ms` to `RecentRequestLogDisplay`, and `AntigravitySyncSummary`.
   - Extend serde contract unit tests.

### Step 2: Protobuf Wire Reader & Read-Only SQLite WAL Reader
1. Create `src-tauri/src/services/antigravity_proto.rs`:
   - Zero-dependency protobuf wire-format decoder for `gen_metadata.data` and `steps.metadata` timestamps.
   - Unit tests covering wire parsing, Duration/Timestamp conversion, thinking+response tokens, model fallback (`f1.f21` -> `f1.f19`), and malformed byte resilience.
2. Create `src-tauri/src/services/antigravity_sync.rs`:
   - `read_conversation_events(db_path, source, metadata_lookup)` using `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`, `PRAGMA query_only = ON`, `PRAGMA busy_timeout = 500`, `BEGIN DEFERRED` (no `immutable=1`), with same-response deduplication.
   - `conversation_summaries.db` read-only loader + `annotations/*.pbtxt` fallback.
   - Integration tests with `tempfile::TempDir`:
     - **Uncheckpointed WAL test** (`PRAGMA wal_autocheckpoint = 0`, committed rows only in `.db-wal`).
     - Same-response deduplication test.
     - Missing roots & missing/corrupt `conversation_summaries.db` graceful degradation.

### Step 3: FSEvents Watcher & Single-Flight Async Reconciler
1. Create `src-tauri/src/services/antigravity_watcher.rs` and export services in `src-tauri/src/services/mod.rs`:
   - `AntigravitySyncManager` single-flight background worker coalescing `ReconcileTargets` (from `notify` watcher, 400ms debounce, `.db`/`.db-wal`/`.db-shm` mapped to canonical `<cid>.db`) and `ReconcileAll` (async startup / page-open / manual refresh).
   - Dynamic `~/.gemini/` creation watch + `<root>/conversations/` watch.
   - Emit `usage:antigravityUpdated` and call `tray::refresh_tray_badge` when `updated_conversations > 0`.
2. Wire into:
   - `src-tauri/src/lib.rs`: `antigravity_usage_cleanup_old(365)`, manage `AntigravitySyncManager`, trigger async initial full import + start watcher, register `antigravity_usage_sync` command.
   - `src-tauri/src/commands/statistics.rs`: add async `antigravity_usage_sync` command.
3. Add tests for `.db` + `.db-wal` path coalescing and missed-event recovery via `reconcile_all`.

### Step 4: Unified Observation SQL (`src-tauri/src/db/request_logs.rs`)
1. Implement `UNIFIED_LEDGER_CTE` and `filter.source` support in `request_log_where`.
2. Route `request_log_get_overview`, `request_log_get_daily_trend`, `request_log_get_monthly_trend`, `request_log_get_statistics_filtered`, and `request_log_get_recent_paginated_filtered` through `unified_logs`.
3. Enforce `performance_mixed_sources` guard in `request_log_get_statistics_filtered` when both proxy and Antigravity rows exist without a `source` filter.
4. Keep `request_log_list_all`, `request_log_get_resource_statistics`, `request_log_get_key_token_stats`, `request_log_session_performance`, `request_log_cleanup_old` strictly on `request_logs`.
5. Add `TempDb` tests verifying merged usage, source filtering, mixed-source summary nulling, single-source TTFT/generation speed accuracy, deferred failure exclusion, and proxy-only query isolation.

### Step 5: Frontend Types, API Bridge, Observation Contract, UI, i18n & Fixtures
1. Update `src/shared/types/index.ts`, `src/renderer/api/types.ts`, `src/renderer/api/index.ts`.
2. Update `src/renderer/utils/observationContext.ts` (`observationSources`, URL parsing & whitelist serialization).
3. Update `src/renderer/locales/observation.ts` (`zh` and `en` keys in parity).
4. Update `src/renderer/pages/Dashboard.tsx` & `src/renderer/pages/Statistics.tsx` (async sync trigger on mount/refresh, `onAntigravityUpdated` subscription, Source `<Select>`, mixed-source summary tooltip, table display).
5. Update `src/renderer/components/usage/RecentRequestDetailDrawer.tsx` (Source label, Thinking + Response token split, Generation duration label for Antigravity).
6. Update `src/renderer/dev/fixtureData.ts`, `src/renderer/dev/fixtureLedger.ts`, `src/renderer/dev/fixtureApi.ts`.
7. Update/add Vitest tests in `observationContext.test.ts`, `Statistics.observation.test.tsx`, `fixtureApi.test.ts`, `api/__tests__/index.contract.test.ts`.

### Step 6: Verification & Phase 3 Spec Sync
- Run Rust checks:
  ```bash
  cargo fmt --all -- --check && cargo clippy --workspace && cargo test --workspace
  ```
- Run Frontend checks:
  ```bash
  pnpm typecheck && pnpm lint && pnpm test
  ```
- Update `.trellis/spec/cc-use/backend/database.md` and `.trellis/spec/cc-use/frontend/observation-contract.md` during Phase 3.3.
