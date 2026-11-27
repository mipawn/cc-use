# Research: Antigravity Local SQLite Data Sources, Competitor Lessons & CC Use Touchpoints

> Researched on 2026-11-27 against local macOS Antigravity SQLite databases (14 conversations, 694 `gen_metadata` records), competitor open-source implementations (`cc-switch`, `yetone/magpie`), and the `cc-use` codebase.

---

## 1. Antigravity Local SQLite Storage (Verified on macOS)

### Root Directories
- **Antigravity Desktop**: `~/.gemini/antigravity/conversations/*.db`
- **Antigravity CLI (`agy`)**: `~/.gemini/antigravity-cli/conversations/*.db`
  - Note: `~/.gemini/antigravity-cli` does not exist until `agy` has been run at least once. Missing directories must be treated as empty without error.

### `conversations/<conversation_id>.db` Tables & Protobuf Wire Mapping
Verified across all 14 local DBs (`694/694` `gen_metadata` rows):

- **`gen_metadata(idx, size, data)`** — `data` is a protobuf message:
  - `f1.f4.f2` (`varint`) = `input_tokens`
  - `f1.f4.f3` (`varint`) = `output_tokens` (verified `== f9 + f10`)
  - `f1.f4.f4` (`varint`, optional) = `cache_creation_tokens` (`0` when absent; `0/694` present on Gemini rows)
  - `f1.f4.f5` (`varint`) = `cache_read_tokens`
  - `f1.f4.f9` (`varint`) = `thinking_tokens`
  - `f1.f4.f10` (`varint`) = `response_tokens`
  - `f1.f4.f7` (`string`) = `bot_id` (`0/694` missing, `0` duplicates in sample)
  - `f1.f4.f11` (`string`) = server `response_id` / trace ID (`0/694` missing, `0` duplicates in sample; still deduplicate defensively per Magpie)
  - `f1.f11` (`google.protobuf.Duration` -> `f1` seconds, `f2` nanos) = `ttft_ms` (TTFT; matches `steps.metadata` `f6 - f1` to the millisecond)
  - `f1.f12` (`google.protobuf.Duration` -> `f1` seconds, `f2` nanos) = `generation_ms` (pure streaming generation duration after TTFT; matches `steps.metadata` `f7 - f6` to the millisecond)
  - `f1.f19` (`string`) = model family (e.g. `gemini-4-neon`, `gemini-4-hydrogen`)
  - `f1.f21` (`string`) = exact display model name (e.g. `Gemini 4 Neon (High)`, `Gemini 4 Neon (XHigh)`, `Gemini 4 Hydrogen (High)`)
  - `f1.f20` (repeated `{ f1: key, f2: value }`) = metadata map including `last_step_index`, `cascade_id`, `request_id`, `trajectory_id`, `root_cascade_id`
- **`steps(idx, step_type, status, metadata, error_details)`**:
  - `metadata.f1` (`google.protobuf.Timestamp` -> `f1` seconds, `f2` nanos) = exact `created_at` (`666/666` matched in initial scan via `last_step_index + 1`).
  - `metadata.f6` = first-token timestamp, `metadata.f7` = completion timestamp.
- **Metadata enrichment**:
  - Primary: `<root>/conversation_summaries.db` (read-only) -> `title` and `workspace_uris` (derive `project_name` from decoded `file://` URI basename).
  - Fallback: `<root>/annotations/<conversation_id>.pbtxt` (`title:"..."`).

### SQLite WAL Requirement (Critical)
- Antigravity writes conversations in SQLite WAL mode. Committed transactions can reside solely in `<cid>.db-wal` before being checkpointed back to `<cid>.db`.
- Reader MUST:
  1. Open `<cid>.db` with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` (never use `immutable=1`, which skips `.db-wal`!).
  2. Set `PRAGMA query_only = ON; PRAGMA busy_timeout = 500;` and execute reads inside `BEGIN DEFERRED`.
  3. Track **both** `(db_size, db_mtime_ns)` and `(wal_size, wal_mtime_ns)` in `antigravity_sync_files` so WAL-only commits are detected.

### Failure Semantics Caveat
- Observed real conversations contain consecutive API retry chains (e.g., 5 sequential error rows belonging to one logical retry attempt). Counting raw error rows inflates failure counts.
- **Decision for v1**: Defer Antigravity failure counting (`failedRequests` / `todayFailedRequests` remain strictly Proxy-verified) until retry-chain collapse semantics are validated on multi-retry DB samples.

---

## 2. Competitor Lessons (`farion1231/cc-switch` & `yetone/magpie`)

- **`farion1231/cc-switch`** (Rust + Tauri + SQLite):
  - Keeps proxy `request_logs` separate from standalone local tool indexes and attributes non-proxy traffic by explicit source.
  - Experienced SQLite `database is locked` storms under heavy concurrent proxy writes + long background sync transactions; solved via single-flight serialization and short per-file transactions.
  - Performs startup backfill + page-open catch-up + manual sync without modifying third-party agent hooks.
- **`yetone/magpie`** (Go desktop gateway):
  - Reads Antigravity `conversations/*.db` directly inside read-only SQLite transactions.
  - Deduplicates same-response entries defensively and relies on OS file watching rather than injecting hooks into target agents.

---

## 3. Relevant `cc-use` Codebase & Specs

### Design Decision: New Rust Dependency
- Add `notify` crate (`notify = "8"` or latest compatible macOS `FSEvents` version verified at implementation) to `src-tauri/Cargo.toml` for zero-polling OS file watching.
- No external protobuf crate needed: implement a minimal, strict ~120-line wire-format decoder (`services/antigravity_proto.rs`) that skips unknown fields cleanly.

### Trellis Specs Consulted
- `.trellis/spec/cc-use/backend/database.md` — rusqlite conventions, table-per-module pattern, idempotent migrations, retention rules, `TempDb` testing.
- `.trellis/spec/cc-use/backend/data-model-contract.md` — `models/mod.rs` ↔ `src/shared/types/index.ts` camelCase mirror, `Option<T>` semantics, `deny_unknown_fields`.
- `.trellis/spec/cc-use/backend/architecture.md` — control-plane vs daemon ownership, no DB lock across `.await` or heavy I/O.
- `.trellis/spec/cc-use/frontend/observation-contract.md` — URL `ObservationContext` whitelist, SQL-before-pagination, invalid scope never falling back to global.

### Key Codebase Touchpoints
- Backend: `src-tauri/Cargo.toml`, `src-tauri/src/db/mod.rs`, `src-tauri/src/db/request_logs.rs`, `src-tauri/src/models/request_log_filter.rs`, `src-tauri/src/models/mod.rs`, `src-tauri/src/commands/statistics.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/tray.rs`, `src-tauri/src/lib.rs`.
- Frontend: `src/shared/types/index.ts`, `src/renderer/api/types.ts`, `src/renderer/api/index.ts`, `src/renderer/utils/observationContext.ts`, `src/renderer/pages/Dashboard.tsx`, `src/renderer/pages/Statistics.tsx`, `src/renderer/components/usage/RecentRequestDetailDrawer.tsx`, `src/renderer/locales/observation.ts`, `src/renderer/dev/fixtureData.ts`, `src/renderer/dev/fixtureLedger.ts`, `src/renderer/dev/fixtureApi.ts`.
