# Technical Design: Antigravity Incremental Cursor & Failure-Rate Follow-Ups

## 0. Scope decision

This task implements **only** the failure-rate half. The incremental cursor was gated on two
preconditions, and both were tested against the real corpus before writing code:

| Precondition | Result | Evidence |
|---|---|---|
| `gen_metadata` / `steps` are append-only | **FALSE** | One `gen_metadata` row per DB carries the request payload and it is always `max(idx)`; 91 % of `gen_metadata` bytes (9.37 of 10.25 MB) are those 15 tail rows. 689 of 704 rows have had content rewritten in place. |
| Full re-read is expensive enough to optimise | **FALSE** | 6.31 ms median for all 15 DBs; worst conversation 2.26 ms. An incremental read would save ~1.4 ms per event behind a 400 ms debounce. |

A cursor is only correct if "already indexed ⇒ final", which the first row falsifies. The item is
closed in `research/append-only-invariant.md` together with the guards a future attempt would need.

## 1. Failure signal — data model

Verified structure (`research/failure-semantics.md`):

- One `gen_metadata` row == one logical model response. Antigravity collapses intra-generation
  retries into that single row under `f1.f14` (retry counter).
- Intra-generation HTTP retries are `steps` rows with `step_type = 17`, `status = 3`, empty
  `error_details`. Counting them as failures over-states by 7.5×; counting `status != 3` folds in
  unrelated `run_command` rows.
- A generation that ended in an API/stream error is the generation's own completion step
  (`last_step_index + 1`) with `status = 7` **and** `step_type = 15`. Tool errors reuse `status = 7`
  on `step_type = 132` and must be excluded.

```
failed_generations = COUNT(*) WHERE failed = 1
failed_attempts    = SUM(retry_count) + COUNT(*) WHERE failed = 1
```

Reproduced exactly on the corpus: 2 failed generations, 13 recovered attempts, 15 failed attempts,
verified by three independent field derivations.

## 2. Reader (`services/antigravity_proto.rs`, `antigravity_sync.rs`)

- `GenerationTelemetry.retry_count: i64` ← `f1.f14` (absent ⇒ 0). Zero extra decode work: the
  wrapper is already parsed.
- `STEPS_SQL` now selects `idx, metadata, status, step_type` (previously `idx, metadata` only), and
  the map holds `StepRecord { created_at, status, step_type }`. Rows with NULL `metadata` are kept
  so a status is never lost just because a timestamp is missing.
- `resolve_failed(last_step_index, steps) -> bool` implements the `status == 7 && step_type == 15`
  rule. It reuses the same `last_step_index + 1` anchor as `resolve_created_at`, so the failure and
  the timestamp always describe the same step.

## 3. Storage (`db/antigravity_usage.rs`, `db/mod.rs`)

Two columns on `antigravity_usage_events`:

```sql
retry_count INTEGER NOT NULL DEFAULT 0,
failed      INTEGER NOT NULL DEFAULT 0,
```

Added to both the `CREATE TABLE` block (fresh installs) and `run_alter_migrations()`
(upgraded installs), per `backend/database.md`. `AntigravityUsageEvent` gains the matching
`retry_count: i64` / `failed: bool` and the insert carries them.

## 4. Ledger semantics (`db/request_logs.rs`)

- `UNIFIED_LEDGER_CTE` projects the Antigravity `outcome` as
  `CASE WHEN failed = 1 THEN 'failed' ELSE 'success' END` and passes `retry_count` through
  (`NULL` for proxy rows, which have no retry concept).
- `request_log_get_statistics_filtered` and `request_log_get_overview` count failures over
  `unified_logs` instead of `request_logs`. Consequence: an Antigravity scope now reports its own
  failures instead of a hard-coded `0`, and the merged view sums both families.
- Deliberately unchanged: the **with-usage denominator**. A failed generation consumed input
  tokens, so it stays in `total_requests`; only the failure count grows. Proxy failure rows behave
  exactly as before (same rows, same population predicate).

## 5. Contract (`models/mod.rs` ↔ `src/shared/types/index.ts`)

`RecentRequestLogDisplay.retry_count: Option<i64>` → `retryCount?: number | null`. The drawer shows
a `重试次数` row only when `retryCount > 0`, so a slow-but-successful generation is explainable
without being mistaken for a failure.

## 6. Deliberate override of the evidence's UI recommendation

`research/failure-semantics.md` §7 recommends keeping `failedRequests` un-merged with Proxy data and
labelling the Antigravity failure tile "API failures (local, transport-level)". This task instead
merges the counts into the existing `failedRequests` tile, because the observation ledger already
promises one scope for every family and a second tile would fragment the same question. The
consequence is accepted and must stay explicit: on the reference corpus the merged tile reports
2 failures while **0 of 57 user turns** actually ended without an answer (both were retried into a
successful generation). The counts are exact; the tile is **not** a "requests the user lost" metric.
A dedicated label is the follow-up once there is a sample that can distinguish the two meanings.

## 7. Upgrade path

The failure signal only exists in rows written after the two columns exist. Because the watcher
skips a conversation whose stored fingerprint is unchanged, a v3.24.0 install would keep
`failed = 0` / `retry_count = 0` for untouched conversations — on the reference corpus that is the
whole two-failure history. `db/mod.rs::reset_antigravity_index_once` therefore deletes
`antigravity_sync_files` exactly once (settings marker `migration.antigravityFailureSignal.v1`), so
the next reconciliation pass re-reads every conversation. Only the file pointers are dropped: events
stay, each conversation is replaced atomically, and pruning is bookkeeping.

## 8. Non-goals (explicit)

- No incremental cursor (section 0).
- No failure **rate** percentage and no error taxonomy: the corpus has 15 failed attempts from
  essentially one transport incident and zero quota/auth/5xx samples. Counts are exact; the
  distribution is not representative.
- No `step_type = 132` tool-failure tile and no `status = 6` (abnormal command exit) accounting —
  semantics unvalidated.
- No `f1.f17[].f7` surface — its meaning is still undetermined.
