# Implementation Contract (frozen for parallel work)

> Every workstream implements against these exact types, signatures and SQL strings.
> Do not rename fields, change modules, or invent alternative shapes. If a signature
> cannot work, stop and report instead of diverging.

## Ownership map (write scopes — never edit a file outside your scope)

| WS | Files |
|---|---|
| A (lead) | `src-tauri/Cargo.toml`, `src-tauri/src/db/mod.rs`, `src-tauri/src/db/antigravity_usage.rs`, `src-tauri/src/models/mod.rs`, `src-tauri/src/models/request_log_filter.rs` |
| B | `src-tauri/src/services/antigravity_proto.rs`, `src-tauri/src/services/antigravity_sync.rs` |
| C | `src-tauri/src/db/request_logs.rs` |
| D | everything under `src/` (renderer/shared) |
| E (lead) | `src-tauri/src/services/antigravity_watcher.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/commands/statistics.rs`, `src-tauri/src/lib.rs` |

B and C must not edit `src-tauri/src/services/mod.rs` / `db/mod.rs`; the lead registers modules.

## 1. Database schema (owned by WS-A, created in `db/mod.rs::run_migrations`)

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

`source` values are exactly `"antigravity_desktop"` / `"antigravity_cli"`.
Event primary key: `format!("ag:{}:{}:{}", source.db_prefix(), conversation_id, response_key)`.

## 2. Models (owned by WS-A)

### `src-tauri/src/models/request_log_filter.rs`

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestLogSource {
    Proxy,
    AntigravityDesktop,
    AntigravityCli,
}

impl RequestLogSource {
    pub const ALL: [RequestLogSource; 3] = [Self::Proxy, Self::AntigravityDesktop, Self::AntigravityCli];
    /// `"proxy" | "antigravity_desktop" | "antigravity_cli"` — the same string stored in `antigravity_usage_events.source`.
    pub fn as_str(self) -> &'static str;
    /// `"Antigravity Desktop" | "Antigravity CLI" | "Proxy Gateway"`.
    pub fn display_name(self) -> &'static str;
    pub fn is_antigravity(self) -> bool;
}
```

`RequestLogFilter` gains (keeping `deny_unknown_fields`):

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub source: Option<RequestLogSource>,
```

### `src-tauri/src/models/mod.rs`

```rust
pub struct UsageStatsSummary {
    // ... existing fields unchanged ...
    /// True when the scoped population mixes Proxy and Antigravity rows with no
    /// explicit `source` filter; the three performance averages are then `None`.
    #[serde(default)]
    pub performance_mixed_sources: bool,
}

pub struct RecentRequestLogDisplay {
    // ... existing fields unchanged ...
    #[serde(default)]
    pub source: Option<String>,          // "proxy" | "antigravity_desktop" | "antigravity_cli"
    #[serde(default)]
    pub thinking_tokens: Option<i64>,
    #[serde(default)]
    pub response_tokens: Option<i64>,
    #[serde(default)]
    pub generation_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravitySyncSummary {
    pub scanned_files: usize,
    pub updated_conversations: usize,
    pub removed_files: usize,
}
```

## 3. `src-tauri/src/db/antigravity_usage.rs` (owned by WS-A)

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AntigravitySyncFingerprint {
    pub db_size: i64,
    pub db_mtime_ns: i64,
    pub wal_size: i64,
    pub wal_mtime_ns: i64,
}

impl AntigravitySyncFingerprint {
    /// Reads `(len, mtime_ns)` for `<db>` and `<db>-wal`; missing WAL is `(0, 0)`.
    pub fn read(db_path: &std::path::Path) -> Self;
    pub fn differs_from(&self, other: &Self) -> bool;
}

#[derive(Debug, Clone)]
pub struct AntigravityUsageEvent { /* fields exactly as in §5 */ }

#[derive(Debug, Clone)]
pub struct AntigravityConversationSyncBatch {
    pub source: AntigravitySource,
    pub conversation_id: String,
    pub file_path: String,
    pub fingerprint: AntigravitySyncFingerprint,
    pub events: Vec<AntigravityUsageEvent>,
}

impl Database {
    pub fn antigravity_sync_state_map(
        &self,
    ) -> Result<std::collections::HashMap<String, AntigravitySyncFingerprint>, rusqlite::Error>;

    /// One short `unchecked_transaction()`: delete this conversation's events,
    /// insert the batch rows, upsert the file fingerprint. Empty `events` still
    /// deletes the old rows and records the fingerprint.
    pub fn antigravity_sync_apply_conversation(
        &self,
        batch: &AntigravityConversationSyncBatch,
    ) -> Result<(), rusqlite::Error>;

    /// Delete `antigravity_sync_files` rows whose `file_path` is in `missing_paths`.
    /// Historical events are kept (retention handles them). Returns rows deleted.
    pub fn antigravity_sync_prune_missing(
        &self,
        missing_paths: &[String],
    ) -> Result<usize, rusqlite::Error>;

    /// Delete events whose `created_at` is older than `max_age_days`. Returns rows deleted.
    pub fn antigravity_usage_cleanup_old(&self, max_age_days: i64) -> Result<i64, rusqlite::Error>;
}
```

LANDED in `db/antigravity_usage.rs` (read it before writing WS-B code):

```rust
pub enum AntigravitySource { Desktop, Cli }   // Copy + Eq + Hash
impl AntigravitySource {
    pub const ALL: [AntigravitySource; 2];
    pub fn as_str(self) -> &'static str;        // "antigravity_desktop" | "antigravity_cli"
    pub fn display_name(self) -> &'static str;  // "Antigravity Desktop" | "Antigravity CLI"
    pub fn db_prefix(self) -> &'static str;     // "desktop" | "cli"
    pub fn root_dir(self) -> Option<std::path::PathBuf>; // ~/.gemini/antigravity{,-cli}
    pub fn ledger_source(self) -> RequestLogSource;
}
pub struct AntigravitySyncFingerprint { pub db_size: i64, pub db_mtime_ns: i64, pub wal_size: i64, pub wal_mtime_ns: i64 }
impl AntigravitySyncFingerprint { pub fn read(db_path: &Path) -> Self; pub fn differs_from(&self, other: &Self) -> bool; }
pub struct AntigravityUsageEvent { /* §5 */ }
impl AntigravityUsageEvent { pub fn event_id(&self, source: AntigravitySource, conversation_id: &str) -> String; }
pub struct AntigravityConversationSyncBatch { pub source, pub conversation_id: String, pub file_path: String, pub fingerprint, pub events: Vec<AntigravityUsageEvent> }
```

WS-B imports these with `use crate::db::antigravity_usage::{...}`. Do not redefine them.

## 4. `src-tauri/src/services/antigravity_sync.rs` (owned by WS-B)

```rust
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConversationMetadata {
    pub title: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConversationMetadataIndex { /* private maps */ }

impl ConversationMetadataIndex {
    /// Loads `<root>/conversation_summaries.db` (read-only, `busy_timeout = 500`)
    /// and falls back to `<root>/annotations/<cid>.pbtxt`. Every failure is
    /// swallowed into an empty index — never an error.
    pub fn load(source: AntigravitySource) -> Self;
    pub fn lookup(&self, conversation_id: &str) -> Option<&ConversationMetadata>;
}

#[derive(Debug, Clone)]
pub struct AntigravityConversationFile {
    pub source: AntigravitySource,
    pub conversation_id: String,
    pub db_path: std::path::PathBuf,
    pub fingerprint: AntigravitySyncFingerprint,
}

/// `<root>/conversations/*.db` for both sources. Missing roots yield no entries.
pub fn scan_conversations() -> Vec<AntigravityConversationFile>;

/// Read one conversation DB inside a read-only transaction
/// (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`, `PRAGMA query_only = ON`,
/// `PRAGMA busy_timeout = 500`, `BEGIN DEFERRED`), deduplicated by response key.
pub fn read_conversation_events(
    db_path: &std::path::Path,
    source: AntigravitySource,
    metadata: Option<&ConversationMetadata>,
) -> Result<Vec<AntigravityUsageEvent>, String>;

/// `read_conversation_events` + `file_path`/`fingerprint` packaging.
pub fn build_conversation_batch(
    file: &AntigravityConversationFile,
    metadata: &ConversationMetadataIndex,
) -> Result<AntigravityConversationSyncBatch, String>;
```

`src-tauri/src/services/antigravity_proto.rs` (owned by WS-B) exposes the wire reader used by
`antigravity_sync.rs` and nothing else outside that module:

```rust
/// `<cid>.db` `gen_metadata.data` → decoded generation telemetry.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GenerationTelemetry {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub thinking_tokens: Option<i64>,
    pub response_tokens: Option<i64>,
    pub bot_id: Option<String>,
    pub response_id: Option<String>,
    pub ttft_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    pub model: Option<String>,
    pub last_step_index: Option<i64>,
    pub request_id: Option<String>,
}

pub fn decode_gen_metadata(data: &[u8]) -> Option<GenerationTelemetry>;
/// `steps.metadata` protobuf → exact UTC created-at string (`+00:00`).
pub fn decode_step_timestamp(metadata: &[u8]) -> Option<String>;
```

## 5. `AntigravityUsageEvent` (owned by WS-A, produced by WS-B)

```rust
pub struct AntigravityUsageEvent {
    pub gen_idx: i64,
    pub response_key: String,
    pub model: Option<String>,
    pub project_name: Option<String>,
    pub conversation_title: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub thinking_tokens: Option<i64>,
    pub response_tokens: Option<i64>,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub ttft_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    pub total_ms: Option<i64>,
    pub created_at: String, // RFC 3339 UTC, fixed width: YYYY-MM-DDTHH:MM:SS.mmm+00:00
}
```

**`created_at` format is pinned**: `chrono::DateTime<Utc>::to_rfc3339_opts(SecondsFormat::Millis, false)`
→ `2026-11-27T10:00:00.000+00:00`. Retention deletes with a lexicographic `<` comparison, so
variable-width fractional seconds would silently mis-order. Never use plain `to_rfc3339()`.

## 6. Unified observation SQL (owned by WS-C, `db/request_logs.rs`)

A single shared CTE text constant used by five read paths:

```rust
const UNIFIED_LEDGER_CTE: &str = "WITH unified_logs AS ( ... )";
```

Antigravity rows project:
`provider_id/api_key_id/project_id/session_id/request_model/request_kind/request_id/status_code/error_message → NULL`,
`provider_name → 'Antigravity Desktop' | 'Antigravity CLI'`,
`outcome → 'success'`, `first_token_ms → ttft_ms`,
`latency_ms → total_ms`, `last_token_ms → CASE WHEN ttft_ms IS NOT NULL AND generation_ms IS NOT NULL THEN ttft_ms + generation_ms ELSE NULL END`,
`is_streaming → CASE WHEN generation_ms > 0 AND output_tokens > 0 THEN 1 ELSE 0 END`,
`thinking_tokens/response_tokens/generation_ms → projected`,
`key_alias → conversation_title`, `project_name → project_name`, `request_kind/model → model`.

Rules:
- `request_log_where` gains `filter.source` handling: `= ?n` against the row's `source`.
- `request_log_get_overview`, `request_log_get_daily_trend`, `request_log_get_monthly_trend`,
  `request_log_get_statistics_filtered`, `request_log_get_recent_paginated_filtered` read `unified_logs`.
- `request_log_get_statistics_filtered` sets `performance_mixed_sources = true` and nulls
  `avg_latency_ms` / `avg_first_token_ms` / `avg_output_tokens_per_second` when
  `filter.source.is_none()` **and** the scoped billable population contains both `source = 'proxy'`
  and `source != 'proxy'` rows. Failure counts stay on `request_logs` (Proxy only).
- `request_log_list_all`, `request_log_get_resource_statistics`, `request_log_get_key_token_stats`,
  `request_log_session_performance`, `request_log_cleanup_old` stay on `request_logs`.

## 7. Frontend contract (owned by WS-D)

```ts
export type RequestLogSource = 'proxy' | 'antigravity_desktop' | 'antigravity_cli'

export interface RequestLogFilter {
  providerId?: string
  apiKeyId?: string
  instanceId?: string
  outcome?: 'success' | 'failed' | 'client_error' | 'upstream_error' | 'transport_error'
  population?: 'all' | 'with_usage'
  source?: RequestLogSource
}

export interface AntigravitySyncSummary {
  scannedFiles: number
  updatedConversations: number
  removedFiles: number
}
```

- `UsageStatsSummary.performanceMixedSources: boolean`
- `RecentRequestLogDisplay.{source: string | null, thinkingTokens: number | null, responseTokens: number | null, generationMs: number | null}`
- `api.requestLog.syncAntigravity(): Promise<AntigravitySyncSummary>` → `invoke('antigravity_usage_sync')`
- `api.requestLog.onAntigravityUpdated(cb): Promise<() => void>` → listens to `usage:antigravityUpdated`,
  returning an unlisten function (same style as other `on*` helpers in `api/index.ts`).
- `observationContext.ts`: `observationSources: RequestLogSource[]`, whitelist `source`,
  serialize into `observationSearch()`.
