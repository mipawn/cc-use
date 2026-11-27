# PRD: Antigravity CLI and Desktop Usage Statistics

## Goal

Index local usage statistics directly from **Antigravity Desktop** (`~/.gemini/antigravity/conversations/*.db`) and **Antigravity CLI** (`~/.gemini/antigravity-cli/conversations/*.db`) in read-only mode—using FSEvents real-time per-conversation reconciliation plus asynchronous startup, page-open, and manual refresh catch-up—and present merged Token/request usage, source-scoped performance metrics, and thinking/response Token breakdowns in `cc-use`.

---

## Requirements

### 1. Direct Read-Only SQLite Indexing (No `transcript.jsonl` Scraping, No Antigravity Hooks)
- Read `gen_metadata` and `steps` directly from `<root>/conversations/*.db` inside a SQLite read-only transaction (`SQLITE_OPEN_READ_ONLY`, `query_only = ON`, no `immutable=1`) so committed transactions residing only in `.db-wal` are captured accurately.
- Never modify, write to, or inject hooks into `~/.gemini/antigravity*` or `~/.gemini/config/hooks.json`.
- Missing root directories (e.g., CLI not yet used) and missing/locked `conversation_summaries.db` degrade gracefully without errors (`annotations/*.pbtxt` fallback for conversation title).
- Deduplicate same-response entries defensively within each conversation.
- Extract exact metrics: `input_tokens`, `cache_read_tokens`, `cache_creation_tokens` (0 if absent), `output_tokens`, `thinking_tokens`, `response_tokens`, `ttft_ms`, `generation_ms`, exact display model name (`f1.f21` with `f1.f19` fallback), and `created_at` normalized to RFC 3339 UTC.

### 2. Event-Driven Updates & Async Reconciliation (No Polling Timer)
- **Cold-start import**: Asynchronously reconcile all conversations on app startup into dedicated index tables in `cc-use.db`.
- **Real-time FSEvents watcher**: Watch `conversations/` directories (and `~/.gemini/` for directory creation) via `notify` (macOS `FSEvents`), coalescing `.db` / `.db-wal` / `.db-shm` events for the same `conversation_id`, debounced and serialized via single-flight. V1 re-reads the entire changed conversation DB and updates `cc-use.db` in one short per-conversation transaction (no premature `idx > last_idx` fast path in v1).
- **Catch-up & manual refresh**: Opening Dashboard/Statistics or pressing manual refresh (`⌘R`) triggers an **asynchronous** reconciliation pass across all conversations (checking both `.db` and `.db-wal` `(size, mtime_ns)`) to recover from any missed FSEvents without blocking UI rendering. When changes are committed, refresh the macOS tray badge and emit `usage:antigravityUpdated` to reload active views.

### 3. Metric Semantics (Usage Merged, Performance Scoped by Source, Failure Rate Deferred)
- **Merged Token & request usage**: Dashboard (`todayTokens`, `todayRequests`), annual `UsageHeatmap` (`getMonthlyTrend`), `getDailyTrend`, Tray badge, and Statistics default view (`All sources`) combine Proxy + Antigravity Desktop + Antigravity CLI totals.
- **Source-scoped performance**: Proxy end-to-end `latency_ms` and Antigravity `generation_ms` keep their distinct meanings.
  - In Statistics summary bar: when a single source is selected (or only one source family is present in the scoped data), show `avgFirstTokenMs`, `avgLatencyMs`, and `avgOutputTokensPerSecond`; when mixed sources (Proxy + Antigravity) coexist under `All sources`, return `null` (`—`) with a localized hint prompting the user to filter by source instead of averaging incompatible latencies.
  - In the ledger table and `RecentRequestDetailDrawer`: show per-request TTFT, output speed (`tok/s`), duration (labeled `生成耗时` / `Generation duration` for Antigravity vs `总耗时` / `Latency` for Proxy), and **Thinking + Response** token breakdown.
- **Failure rate deferred**: V1 does NOT count unverified Antigravity retry-chain errors in `failedRequests` / `todayFailedRequests`; failure counts remain strictly Proxy-verified.

### 4. Storage, Isolation & URL Observation Contract
- Store Antigravity indexes in dedicated tables (`antigravity_sync_files`, `antigravity_usage_events`) in `cc-use.db` with 365-day retention; keep `request_logs` untouched.
- Statistics page supports a `source` filter (`All sources` / `proxy` / `antigravity_desktop` / `antigravity_cli`) persisted in `ObservationContext` URL parameters per `.trellis/spec/cc-use/frontend/observation-contract.md`.
- Keep `openConsole` disabled in the detail drawer when `requestId` is null.
- Keep `request_log_get_resource_statistics`, `request_log_get_key_token_stats`, `request_log_session_performance`, and `import_export` strictly Proxy-only.

### 5. Localization
- Add paired Chinese (`zh`) and English (`en`) copy across `src/renderer/locales/observation.ts` (and `zh.ts`/`en.ts` if needed) with full key parity.

---

## Explicit Non-Goals (Out of Scope)

- No Antigravity provider, API key, client profile, sidebar page, config takeover, terminal launch, or hook injection.
- No Settings UI for custom Antigravity directories or sync toggles.
- No periodic polling timer for Antigravity usage.
- No `idx > last_idx` incremental row cursor in v1 (deferred until append-only invariant and large-conversation benchmarks are verified).
- No Antigravity failure-rate counting in v1.

---

## Acceptance Criteria

- [ ] **AC1 (Direct SQLite + Protobuf Extraction & Dedup)**: Pure-Rust protobuf wire reader + SQLite read-only transaction reader accurately extracts input/cache/output/thinking/response tokens, TTFT, generation duration, exact model name, and UTC timestamp from `conversations/*.db`, deduplicating same-response rows.
- [ ] **AC2 (Uncheckpointed WAL Coverage)**: Committed rows present only in `.db-wal` (`PRAGMA wal_autocheckpoint = 0`, never checkpointed to `.db`) are detected via `(db_size, db_mtime_ns, wal_size, wal_mtime_ns)` and indexed accurately.
- [ ] **AC3 (FSEvents Coalescing & Missed-Event Recovery)**: `.db` / `.db-wal` / `.db-shm` events coalesce to a single serialized per-conversation sync; missed events are recovered asynchronously via startup, page-open, and manual refresh (`⌘R`) reconciliation without holding `cc-use.db` locks across external I/O.
- [ ] **AC4 (Merged Usage, Source-Scoped Performance & Token Split)**: Dashboard/heatmap/tray merge tokens & billable requests; Statistics `source` filter obeys `observation-contract.md` (SQL before pagination, strict whitelist); mixed-source summary suppresses incompatible latency/speed averages (`performanceMixedSources = true`) while single-source summary shows exact averages; Detail Drawer displays Thinking + Response tokens, TTFT, and Generation Duration; Antigravity errors do not inflate `failedRequests`.
- [ ] **AC5 (Proxy Ledger Isolation)**: `request_log_get_resource_statistics`, `request_log_get_key_token_stats`, `request_log_session_performance`, and `request_log_list_all` continue querying `request_logs` only.
- [ ] **AC6 (Quality Gates)**: `cargo fmt --all -- --check`, `cargo clippy --workspace`, `cargo test --workspace`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass.
