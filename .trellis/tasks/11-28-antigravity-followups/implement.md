# Implementation Plan: Antigravity Incremental Cursor & Failure-Rate Follow-Ups

## Execution Order

### Step 0: Precondition validation (done before any code)
1. Independent forensics over `~/.gemini/antigravity/conversations/*.db` (read-only, `mode=ro`):
   append-only invariants, in-place rewrite detection, WAL state, per-DB re-read cost.
2. Independent forensics over failure/retry structure: `steps.status` / `step_type` / `error_details`
   distributions, retry chains, cross-validation of three derivations.
3. Verdict recorded in `research/append-only-invariant.md` and `research/failure-semantics.md`.
   The cursor was rejected on evidence (see `prd.md` §1, `design.md` §0); the failure rule was
   accepted with an explicit "counts exact, distribution unrepresentative" caveat.

### Step 1: Proto reader
`services/antigravity_proto.rs`
- `RETRY_COUNT = 14` field constant; `GenerationTelemetry.retry_count` decoded from `f1.f14`.
- Test builder `Generation` gains `retry_count`; tests for decode and absent-means-zero.

### Step 2: Conversation reader
`services/antigravity_sync.rs`
- `STEPS_SQL` → `idx, metadata, status, step_type`; `StepRecord` map replaces the timestamp map.
- `resolve_failed` (anchor step `status == 7 && step_type == 15`), wired into `build_event`.
- Tests: erroring completion step ⇒ failed; tool error on the anchor ⇒ not failed; five retry rows
  before a successful generation ⇒ `retry_count = 5`, `failed = false`.

### Step 3: Storage and migration
`db/antigravity_usage.rs`, `db/mod.rs`, `models/mod.rs`
- `retry_count` / `failed` columns (CREATE + idempotent ALTER), event fields, insert columns.
- `RecentRequestLogDisplay.retry_count`.
- Tests: failure signal survives apply → read; existing fixtures updated.

### Step 4: Ledger semantics
`db/request_logs.rs`
- CTE: conditional `outcome`, `retry_count` projected (`NULL` on the proxy side).
- Failure counts move to `unified_logs` for both the statistics summary and the overview.
- Tests: per-generation failure counting; recency families do not borrow each other's failures;
  retries stay successes with `retryCount`; time-range scope applies; proxy denominators unchanged.

### Step 5: Real-corpus verification (temporary, deleted after the run)
Whole pipeline against the live 15-conversation corpus in a temp `cc-use.db`:
`failed = 2`, `SUM(retry_count) = 13`, attempts `= 15`, the two failed generations match the
forensics report by conversation and `gen_idx`, the with-usage denominator is unchanged at 704, and
the ledger failure drilldown returns exactly those two rows with `outcome = failed`.

### Step 6: Renderer
`src/shared/types/index.ts`, `RecentRequestDetailDrawer.tsx`, `locales/observation.ts`,
`src/renderer/dev/fixtureData.ts` + `fixtureLedger.ts`, and the covering tests:
`retryCount` shown only when positive; one failed Antigravity fixture row so the failure path is
visible in the isolated preview.

### Step 7: Verification
```bash
cargo fmt --all -- --check && cargo clippy --workspace && cargo test --workspace
pnpm typecheck && pnpm lint && pnpm test
```
Then the isolated-preview end-to-end pass (fixture server + Playwright), spec update
(`backend/database.md`, `frontend/observation-contract.md`), CHANGELOG, commit, release.

## Review Gates

- After Step 4: an adversarial review of the counting rule against `research/failure-semantics.md`
  (does any path inflate or under-count?).
- After Step 6: the isolated preview must show a non-zero Antigravity failure count and a retry row.
- Before release: `cargo fmt` clean, no clippy warning from the touched modules, all suites green.

## Rollback Points

- Steps 1–4 are additive: the new columns are `NOT NULL DEFAULT 0`, so reverting the migration is a
  no-op for existing databases and the ledger falls back to "Antigravity rows are successes".
- The cursor work has no rollback risk because it was never started.

## Deferred / Rejected

- `idx > last_idx` cursor — rejected with evidence (see `research/append-only-invariant.md`).
- Failure rate percentage, error taxonomy, tool-failure tile, `f1.f17[].f7` interpretation — all
  explicitly out of scope; the sample cannot support them.
