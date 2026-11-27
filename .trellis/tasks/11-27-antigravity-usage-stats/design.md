# Technical Design: Antigravity CLI and Desktop Usage Statistics

## 1. Architecture & Boundaries

Antigravity Desktop (`~/.gemini/antigravity`) and Antigravity CLI (`~/.gemini/antigravity-cli`) persist inference telemetry directly inside per-conversation SQLite databases (`conversations/<cid>.db`, table `gen_metadata` + `steps`). Collection lives purely in the **Tauri app control plane**, leaving `crates/cc-use-daemon` and `crates/cc-use-cli` untouched and avoiding any invasive hook injection into Antigravity.

### Core Architectural Choices
1. **Direct SQLite Read-Only Indexing into Dedicated `cc-use.db` Tables**:
   - Store derived indexes in `antigravity_sync_files` and `antigravity_usage_events`, keeping `request_logs` strictly for `cc-use-daemon` proxy records.
   - Read-side observation queries (`overview`, `daily_trend`, `monthly_trend`, `statistics`, `recent_paginated`) share a `UNIFIED_LEDGER_CTE` combining `request_logs` and `antigravity_usage_events`.
2. **Whole-Conversation Reconcile in v1 (No `idx > last_idx` Fast Path Yet)**:
   - When a conversation's `.db` or `.db-wal` changes, v1 re-reads that single conversation DB inside a read-only SQLite transaction and replaces its rows in `cc-use.db` inside one short per-conversation transaction.
   - Deferred follow-up: introduce `idx > last_idx` only after verifying append-only guarantees and benchmarking large conversations.
3. **New Dependency (`notify`)**:
   - Add `notify` (latest compatible `8.x` / macOS `FSEvents` backend) to `src-tauri/Cargo.toml` for event-driven watching without polling timers.
   - Implement a compact, zero-dependency protobuf wire reader (`src-tauri/src/services/antigravity_proto.rs`) rather than adding a protobuf codegen dependency.

---

## 2. Database Schema & Retention (`src-tauri/src/db/`)

### Tables in `src-tauri/src/db/mod.rs` (`run_migrations`)
Added idempotently via `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS antigravity_sync_files (
    file_path TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    db_size INTEGER NOT NULL,
    db_mtime_ns INTEGER NOT NULL,
    wal_size INTEGER NOT NULL DEFAULT 0,
    wal_mtime_ns INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS antigravity_usage_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    gen_idx INTEGER NOT NULL,
    response_key TEXT NOT NULL,
    model TEXT,
    project_name TEXT,
    conversation_title TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thinking_tokens INTEGER,
    response_tokens INTEGER,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    generation_ms INTEGER,
    total_ms INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(source, conversation_id, response_key)
);

CREATE INDEX IF NOT EXISTS idx_antigravity_usage_created
ON antigravity_usage_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_antigravity_usage_source_created
ON antigravity_usage_events(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_antigravity_usage_source_conv
ON antigravity_usage_events(source, conversation_id);
```

### Table Module (`src-tauri/src/db/antigravity_usage.rs`)
- `AntigravitySyncFingerprint { db_size: i64, db_mtime_ns: i64, wal_size: i64, wal_mtime_ns: i64 }`.
- `antigravity_sync_state_map(&self) -> Result<HashMap<String, AntigravitySyncFingerprint>, rusqlite::Error>`.
- `antigravity_sync_apply_conversation(&self, batch: &AntigravityConversationSyncBatch) -> Result<(), rusqlite::Error>`:
  - Short single-conversation `unchecked_transaction()`:
    - `DELETE FROM antigravity_usage_events WHERE source = ?1 AND conversation_id = ?2`
    - Insert deduplicated `antigravity_usage_events` rows (`id = format!("ag:{}:{}:{}", source_short, conversation_id, response_key)`)
    - `INSERT OR REPLACE INTO antigravity_sync_files (...)`
- `antigravity_sync_prune_missing(&self, missing_paths: &[String])`: deletes disappeared file pointers from `antigravity_sync_files` (keeps historical events until retention expiry).
- `antigravity_usage_cleanup_old(&self, max_age_days: i64)`: deletes events older than `365` days on startup (`lib.rs`).

---

## 3. Protobuf Reader, SQLite WAL Reader & FSEvents Reconciler

### Protobuf Wire Reader (`src-tauri/src/services/antigravity_proto.rs`)
- Strict, bounded wire-format parser (`varint`, `length-delimited`, `fixed32`, `fixed64`), skipping unknown fields cleanly without large allocations.
- Extracts from `gen_metadata.data`:
  - `f1.f4`: `f2` (`input_tokens`), `f3` (`output_tokens`), `f4` (`cache_creation_tokens`), `f5` (`cache_read_tokens`), `f9` (`thinking_tokens`), `f10` (`response_tokens`), `f7` (`bot_id`), `f11` (`response_id`).
  - `f1.f11` (`Duration { seconds, nanos }`) → `ttft_ms`
  - `f1.f12` (`Duration { seconds, nanos }`) → `generation_ms`
  - `total_ms = ttft_ms + generation_ms` (when both present)
  - `f1.f21` (fallback `f1.f19`) → `model`
  - `f1.f20` metadata entries → `last_step_index`, `request_id`
- Extracts `created_at` from `steps.metadata` (`f1` `Timestamp { seconds, nanos }`) mapped by `last_step_index + 1` (falling back to any step timestamp near `gen_idx` or DB mtime if absent), normalized to RFC 3339 UTC (`+00:00`).

### SQLite Read-Only Session Reader (`src-tauri/src/services/antigravity_sync.rs`)
- **Read-only WAL-safe open**: `Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)` — never `immutable=1`.
- Executes `PRAGMA query_only = ON; PRAGMA busy_timeout = 500;` then `BEGIN DEFERRED` to read `steps(idx, metadata)` and `gen_metadata(idx, data)` in one consistent snapshot, including committed uncheckpointed `.db-wal` pages.
- **Same-response deduplication**: Keys each `gen_metadata` row by `f1.f4.f11` → `f1.f4.f7` → `request_id` → `format!("idx:{idx}")`; on duplicate keys within a conversation, retains the highest `gen_idx`.
- **Metadata enrichment**: Lazily loads `<root>/conversation_summaries.db` (read-only + `busy_timeout = 500`) for `title` and `workspace_uris` (`project_name`), falling back to `<root>/annotations/<cid>.pbtxt` (`title:"..."`).

### Single-Flight Async Reconciler & FSEvents Watcher (`src-tauri/src/services/antigravity_watcher.rs`)
- **`AntigravitySyncManager`** (Tauri managed state):
  - Runs a single background worker loop backed by a coalescing channel + `spawn_blocking`, guaranteeing at most one reconciliation runs at a time and zero `Mutex<Database>` locking across external I/O.
  - Supports two messages:
    1. `ReconcileTargets(Vec<(AntigravitySource, PathBuf)>)`: sent by the `notify` watcher after a 400ms debounce, mapping `.db`, `.db-wal`, and `.db-shm` paths back to canonical `<cid>.db` and deduplicating by `(source, cid)`.
    2. `ReconcileAll { reply: Option<oneshot::Sender<Result<AntigravitySyncSummary, String>>> }`: scans `<root>/conversations/*.db`, compares `(db_size, db_mtime_ns, wal_size, wal_mtime_ns)` against `antigravity_sync_files`, and reconciles only changed conversations via per-conversation short transactions.
  - Whenever `updated_conversations > 0`: calls `tray::refresh_tray_badge(&app)` and emits `app.emit("usage:antigravityUpdated", summary)`.
- **Triggers**:
  1. App startup (`lib.rs`): `antigravity_usage_cleanup_old(365)` + enqueue `ReconcileAll` asynchronously + start `AntigravityWatcher`.
  2. Watcher (`antigravity_watcher.rs`): watches `<root>/conversations/` (and `~/.gemini/` for directory creation so newly created CLI dirs attach dynamically).
  3. Catch-up / Manual Refresh: `antigravity_usage_sync` async Tauri command enqueues `ReconcileAll` without blocking the UI thread; called non-blockingly when opening Dashboard/Statistics and awaited during manual refresh (`⌘R`).

---

## 4. Unified Observation SQL (`src-tauri/src/db/request_logs.rs`)

### `UNIFIED_LEDGER_CTE`
Combines `request_logs` (`'proxy' AS source`) and `antigravity_usage_events`:
- For Antigravity rows:
  - `provider_id`, `api_key_id`, `project_id`, `session_id`, `request_model`, `request_kind`, `request_id`, `status_code`, `error_message` → `NULL`
  - `outcome` → `'success'` (v1 defers Antigravity failure counting)
  - `first_token_ms` → `ttft_ms`
  - `latency_ms` → `total_ms` (`ttft_ms + generation_ms` when present)
  - `last_token_ms` → `CASE WHEN ttft_ms IS NOT NULL AND generation_ms IS NOT NULL THEN ttft_ms + generation_ms ELSE NULL END`
  - `is_streaming` → `CASE WHEN generation_ms > 0 AND output_tokens > 0 THEN 1 ELSE 0 END`
  - Note: with `first_token_ms = ttft_ms` and `last_token_ms = ttft_ms + generation_ms`, existing `output_speed_sql` (`output_tokens * 1000.0 / (last_token_ms - first_token_ms)`) computes exact `output_tokens * 1000.0 / generation_ms`!
  - `thinking_tokens`, `response_tokens`, `generation_ms` → projected directly (`NULL` for `request_logs`)
  - `provider_name` → `'Antigravity Desktop'` | `'Antigravity CLI'`
  - `key_alias` → `conversation_title`, `project_name` → `project_name`

### Source-Scoped Performance Summary Rule
In `request_log_get_statistics_filtered`:
- Also query `EXISTS(SELECT 1 FROM unified_logs ... AND source = 'proxy')` and `EXISTS(SELECT 1 FROM unified_logs ... AND source != 'proxy')` inside the scoped billable population.
- If `filter.source.is_none()` AND both proxy and Antigravity rows exist in scope:
  - Set `summary.avg_latency_ms = None`, `summary.avg_first_token_ms = None`, `summary.avg_output_tokens_per_second = None`
  - Set `summary.performance_mixed_sources = true`
- Otherwise (`filter.source` specified OR only one source family exists in scope):
  - Return exact averages and `performance_mixed_sources = false`.

### Scope Split
- **Unified (`unified_logs`)**: `request_log_get_overview`, `request_log_get_daily_trend`, `request_log_get_monthly_trend`, `request_log_get_statistics_filtered`, `request_log_get_recent_paginated_filtered` (`ORDER BY r.created_at DESC, r.id DESC`).
- **Proxy-only (`request_logs`)**: `request_log_list_all`, `request_log_get_resource_statistics`, `request_log_get_key_token_stats`, `request_log_session_performance`, `request_log_cleanup_old`.

---

## 5. Rust ↔ TS Contract & Frontend UI

### Rust Models (`models/request_log_filter.rs`, `models/mod.rs`)
- `RequestLogSource { Proxy, AntigravityDesktop, AntigravityCli }` (`#[serde(rename_all = "snake_case")]`)
- `RequestLogFilter`: add `#[serde(default, skip_serializing_if = "Option::is_none")] pub source: Option<RequestLogSource>` (retaining `deny_unknown_fields`).
- `UsageStatsSummary`: add `#[serde(default)] pub performance_mixed_sources: bool`.
- `RecentRequestLogDisplay`: add `#[serde(default)] pub source: Option<String>`, `pub thinking_tokens: Option<i64>`, `pub response_tokens: Option<i64>`, `pub generation_ms: Option<i64>`.
- `AntigravitySyncSummary`: `{ scannedFiles: number, updatedConversations: number, removedFiles: number }`.

### TypeScript & Observation Contract (`src/shared/types/index.ts`, `observationContext.ts`, `api/`)
- Mirror `RequestLogSource`, `RequestLogFilter.source`, `UsageStatsSummary.performanceMixedSources`, `RecentRequestLogDisplay.{source, thinkingTokens, responseTokens, generationMs}`, `AntigravitySyncSummary`.
- `api.requestLog.syncAntigravity(): Promise<AntigravitySyncSummary>` (`antigravity_usage_sync`) and `api.requestLog.onAntigravityUpdated(cb)` (`usage:antigravityUpdated` event).
- `observationContext.ts`: whitelist `source` in `allowed`, validate against `['proxy', 'antigravity_desktop', 'antigravity_cli']`, serialize in `observationSearch()`.

### UI (`Dashboard.tsx`, `Statistics.tsx`, `RecentRequestDetailDrawer.tsx`, `observation.ts`)
- `Dashboard.tsx` & `Statistics.tsx`: trigger async `syncAntigravity()` on mount (non-blocking) and on manual refresh (`⌘R`), and reload when `usage:antigravityUpdated` fires.
- `Statistics.tsx`:
  - Add Source `<Select>` next to Outcome/Population (`All sources` / `Proxy Gateway` / `Antigravity Desktop` / `Antigravity CLI`), resetting `page` to 1 while preserving other scopes.
  - When `summary.performanceMixedSources` is true, display `—` for summary `avgLatencyMs`, `avgFirstTokenMs`, and `avgOutputTokensPerSecond` with localized hint explaining to select a source filter.
  - Table shows Antigravity source/title in route column and exact TTFT / generation duration / speed per row.
- `RecentRequestDetailDrawer.tsx`:
  - Show Source label (`代理网关` / `Antigravity Desktop` / `Antigravity CLI`).
  - Show Thinking + Response token split when `thinkingTokens != null || responseTokens != null`.
  - Label duration as `生成耗时` / `Generation duration` for Antigravity rows vs `总耗时` / `Latency` for Proxy rows.
  - Keep `openConsole` disabled when `requestId` is null.
- Paired `zh`/`en` keys in `src/renderer/locales/observation.ts`; fixture data & ledger updates in `src/renderer/dev/`.

---

## 6. Deferred Follow-Ups
- `WHERE idx > last_idx` incremental row fast path after verifying append-only guarantees and benchmarking large conversations.
- Antigravity failure-rate & retry-chain collapsing after validating real multi-retry DB samples.
