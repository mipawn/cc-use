# PRD: Antigravity Incremental Cursor & Failure-Rate Follow-Ups

## Context

`11-27-antigravity-usage-stats` (shipped as v3.24.0) deliberately deferred two items, each gated on a
validation that had not been performed:

1. `WHERE idx > last_idx` incremental row cursor — gated on "verifying append-only guarantees and
   benchmarking large conversations".
2. Antigravity failure-rate counting — gated on "validating retry-chain collapse semantics on real
   multi-retry DB samples".

Both validations are now done against the real local corpus (15 conversation DBs, 704 generations,
2,478 steps). Evidence: `research/append-only-invariant.md`, `research/failure-semantics.md`.

## 1. Incremental cursor — **NOT IMPLEMENTED (evidence rejects it)**

The gating invariant does not hold, and the performance motive does not exist:

- **Rows are mutated after creation.** In all 15/15 DBs exactly one `gen_metadata` row carries the
  generation request payload and it is always the row at `max(idx)`; 91 % of all `gen_metadata`
  bytes (9.37 of 10.25 MB) are those 15 tail rows, including in the 237- and 245-generation
  conversations. Append-only writes cannot produce that state, so 689 of 704 rows have had content
  rewritten in place. A cursor that assumes "already indexed ⇒ final" is unsafe.
- **There is no cost to remove.** A full re-read of all 15 conversation DBs takes 6.31 ms median;
  the worst conversation (26.3 MB, 237 generations) takes **2.26 ms**. A realistic incremental read
  would save ~1.4 ms per event, behind a 400 ms debounce.
- Reaching ~100 ms per full re-read would need roughly 40–45× today's largest conversation
  (~10k generations).

Decision: **do not ship the cursor.** Record the evidence and the guards a future attempt would
need (tail re-read of the last K≥2 rows, shrink/reset detection, gap detection, never caching
payload-derived fields) in `research/append-only-invariant.md` §7 so the item is closed with a
reason rather than silently dropped.

## 2. Failure-rate statistics — **IMPLEMENTED**

Goal: report Antigravity generation failures in the observation ledger without inflating counts the
way raw retry rows would, and without changing Proxy failure semantics.

Validated data model (evidence §3–§5 of `research/failure-semantics.md`):

- A logical model response is exactly one `gen_metadata` row.
- Intra-generation retries are `steps` rows with `step_type = 17`; they are **not** failures of the
  user's request and must not be counted as such. Their count is recorded on the surviving
  generation as `gen_metadata.data.f1.f14` ("retry counter").
- A generation that ended in an API/stream error carries `steps[last_step_index + 1].status = 7`
  with `step_type = 15`. Tool errors also use `status = 7` but appear on `step_type = 132` rows and
  must be excluded.

Counting rule:

```
failed_generations = COUNT(*) WHERE failed = 1
failed_attempts    = SUM(retry_count) + COUNT(*) WHERE failed = 1
```

Cross-validated three ways on the corpus (all agree at 15 failed attempts / 2 failed generations).

## Requirements

### R1. Index the failure signal
- Add `failed` and `retry_count` to `antigravity_usage_events` (CREATE + idempotent ALTER, per
  `backend/database.md`).
- `failed` = the generation's anchor step has `status = 7` **and** `step_type = 15`.
- `retry_count` = `gen_metadata.data.f1.f14`, absent ⇒ 0.

### R2. Ledger outcome
- The unified ledger projects an Antigravity row's `outcome` as `failed` when `failed = 1`,
  otherwise `success`.
- `failedRequests` (statistics summary) and the overview's today-failed count move to the unified
  ledger so an Antigravity scope reports its own failures instead of a hard-coded 0.
- Proxy failure counting is unchanged: same rows, same population semantics, same denominators.
- A failed generation keeps its real token usage (it consumed input tokens), so it still belongs to
  the with-usage denominator — the failure rate must not be computed against a different population.

### R3. Retry visibility
- Expose `retryCount` on the ledger row and show it in the request detail drawer only when > 0, so a
  long generation that succeeded after retries is explainable instead of looking like a failure.

### R4. Honest labelling
- These are **generation-level** failures. Do not present them as a validated failure *rate*: the
  corpus has 15 failed attempts from essentially one network incident and no quota/auth/5xx samples.
  The counts are exact; the distribution behind them is not representative.

## Acceptance Criteria

- [ ] AC1: `failed`/`retry_count` are indexed from real data; on the full local corpus they
      reproduce exactly 2 failed generations and 15 failed attempts (sum retry_count 13 + 2).
- [ ] AC2: Antigravity rows project `outcome = failed` only for the two `status = 7` generation
      steps; tool errors (`step_type = 132`, `status = 7`) never become failures.
- [ ] AC3: `failedRequests` is scoped-correct for `source = antigravity_*` and for the merged view;
      Proxy failure counts and denominators are byte-for-byte unchanged.
- [ ] AC4: Retried-but-successful generations are not failures; they only carry `retryCount`.
- [ ] AC5: `cargo fmt --all -- --check`, `cargo clippy --workspace`, `cargo test --workspace`,
      `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Non-Goals

- No incremental cursor (rejected with evidence, section 1).
- No failure-rate *percentage* surface, no error taxonomy/classification by message text, no tool
  failure tile. No `step_type = 6` (abnormal command exit) accounting — unvalidated semantics.
