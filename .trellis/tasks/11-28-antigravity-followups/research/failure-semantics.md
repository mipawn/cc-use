# Antigravity Failure / Retry-Chain Semantics — Evidence Report

Read-only forensics over `~/.gemini/antigravity/conversations/*.db` (15 SQLite
conversation DBs). No conversation DB, WAL or repository file was modified.

- **Corpus** — 15 conversations, **2,478** `steps` rows, **704** `gen_metadata`
  rows, 57 user-message steps (`step_type=14`), window 2026-11-22 … 2026-11-27.
- **Headline** — the "consecutive error rows inflate failure counts" premise is
  **wrong about where the data lives, and therefore wrong about the direction of
  the error**. Real retry chains exist, but they are `step_type=17` rows with
  `status=3` and an **empty** `error_details`. `status`/`error_details` counting
  *undercounts* them to zero. Counting `step_type=17` rows instead *over*-counts
  generations by 7.5×. The smallest defensible rule is three lines of arithmetic
  over two fields, verified by three independent counts that agree exactly.
- **Sample size** — 15 failed HTTP attempts, 5 retried generations, **2**
  failed generations, **0** user-visible failures. 13 of the 15 attempts fall in
  one ~75-second network incident on 2026-11-27 22:26–22:28; the other 2 are
  isolated transients. Only **2 distinct failure causes** exist in the corpus.
  **The rule is arithmetically validated, statistically unvalidated.** See §7.

---

## 1. Failure data shape

### `steps.status` distribution (2,478 rows, all 15 DBs)

| status | rows | meaning (inferred) |
|---|---|---|
| `3` | 2,463 | success / completed |
| `6` | 11 | non-success, `run_command` only (see §5.4) |
| `7` | 4 | error — the only status that ever carries `error_details` |

`status=0` never appears (the column default is unused). `status=3` is the
normal path at 99.4 %.

### `steps.step_type` distribution

| step_type | rows | what it is | `step_payload` top-level fields |
|---|---|---|---|
| `14` | 57 | user message (one per user turn) | `f1 f4 f5 f19` |
| `15` | 704 | **model generation** — exactly 1:1 with `gen_metadata` | `f1 f4 f5 f20` (or `f31` on error) |
| `17` | 15 | **failed API attempt record** (see §4) | `f1 f4 f5 f24` |
| `23` | 2 | plan/state event | `f1 f4 f5 f30` |
| `101` | 91 | UI/state event | `f1 f4 f5 f114` |
| `132` | 1,609 | tool call | `f1 f4 f5 f140` (+`f148` task, `f147` question, `f31` on error) |

`step_payload.f1` and `.f4` mirror the `step_type` / `status` columns in all
2,478 rows (0 mismatches), so the columns are authoritative and storable.

### `error_details` vs non-success status — they do **not** agree

| quantity | rows |
|---|---|
| non-empty `error_details` | **4** |
| `status = 7` | 4 |
| `status != 3` | 15 |
| rows with a failed HTTP attempt | **15** |

Relationships (all verified row-by-row):

- `error_details` is `NULL` in 2,474 rows and non-empty in 4 — never empty-present.
- `error_details` ≡ `status = 7` (identical 4-row set) **and** ≡ presence of
  `step_payload.f31` (identical 4-row set). Three encodings, one set.
- `status = 7` splits by step context:
  - `step_type = 15` → **2 rows = real API/stream failures**
  - `step_type = 132` → **2 rows = ordinary tool errors**, not API failures
    (`read_file` on a missing file; `edit_file` target text mismatch)
- The 11 `status = 6` rows are all `run_command` and carry no payload error.
- **The 15 retry-attempt rows (`step_type=17`) have `status=3` and empty
  `error_details`.** Neither column sees them.

⇒ `status` and `error_details` are a *narrower* signal than "the request failed".
They only record a failure that **terminated** a step.

`gen_metadata` carries **no** failure signal at all: its `f1.f20` key/value map
holds only `last_step_index`, `request_id`, `trajectory_id`, `cascade_id`,
`root_cascade_id`, `model_enum`, `used_claude`, `used_claude_conservative`,
`used_non_gemini_model`, `last_execution_id`. No `retry`/`attempt`/`error`/`status`
keys exist. (Also: `gen_metadata.size` is `0` in 704/704 rows — useless as a filter.)

---

## 2. What is inside `error_details`

Structure is flat and identical to `step_payload.f31`:

```
steps.error_details            step_payload.f31 (same message, duplicated)
  f2 (string)  short message      f2 (string)  short message
  f3 (string)  long message       f3 (string)  long message   [tool errors only]
```

There is **no** error-code / HTTP-status / error-type field. The only stable
discriminator is free text, plus `step_type` to tell API errors from tool errors.

All 4 messages, verbatim and complete (nothing else is in these blobs):

| step_type | context | `error_details.f2` |
|---|---|---|
| 15 | API stream | `stream reading error: unexpected EOF` (×2) |
| 132 | `read_file` tool | `file does not exist` |
| 132 | `edit_file` tool | `target content not found in the file; the Target must exactly match existing file text, including whitespace` |

**Conclusion:** nothing that resembles `HTTP 4xx/5xx`, `RESOURCE_EXHAUSTED`,
`UNAVAILABLE`, `PERMISSION_DENIED` or a quota/rate-limit code exists anywhere in
this dataset. A keyword sweep over every step blob found the words
`quota`/`rate limit`/`429`/`503` only inside ordinary conversation and file
content — never as a structured error signal. **A code-based error taxonomy is
not constructible from this data.**

The richer error text lives somewhere else: `gen_metadata.data.f1.f17[].f3`
(§4), which is where HTTP-level failures are written.

---

## 3. Retry chains — the core question

### 3.1 The note's claim, tested against the data

> "consecutive API retry chains (e.g., 5 sequential error rows belonging to one
> logical retry attempt)" — *antigravity-data-sources.md*, Failure Semantics Caveat

| claim | verdict |
|---|---|
| a chain of 5 retries exists | **CONFIRMED** (max observed chain = 6 attempts: 5 failures + 1 success) |
| the members are consecutive rows | **CONFIRMED** (5 consecutive `step_type=17` rows, indices 122–126) |
| the members are error rows (`status`/`error_details`) | **REFUTED** — all 15 have `status=3`, empty `error_details` |
| counting raw error rows inflates the count | **REFUTED for `status` counting (it yields 0), TRUE for `step_type=17` counting (15 vs 2 generations = 7.5×)** |

Runs of consecutive rows by every "error-ish" definition:

| definition | rows | longest consecutive run |
|---|---|---|
| `status = 7` | 4 | **1** (never 2 in a row) |
| `status != 3` | 15 | **1** |
| `error_details != ''` | 4 | **1** |
| `step_type = 17` | 15 | **5** ← the real retry chain |

There are **zero** adjacent `step_type=15` steps (0 rows have a `step_type=15`
predecessor), and every `idx` sequence is gap-free in both tables. So retries
never duplicate a generation row.

### 3.2 Where retries actually live — two encodings, same 15 events

**(a) `steps` rows with `step_type = 17`** — one row per failed HTTP attempt:

```
payload.f1  = 17
payload.f4  = 3                          ← status is SUCCESS
payload.f5.f3   = 5
payload.f5.f20  = { f1: <trajectory_id>, f2: 1, f4: <cascade_id> }
payload.f24.f3.f2 = "API error (attempt N): <error text>"   ← the failure
payload.f24.f3.f6 = "<trajectory_id>-<step_idx>"            ← request id
```
All 15 rows: `status=3`, `error_details` empty, identical payload shape, message
prefix `API error (attempt N):`. Attempt numbers observed: 1×7, 2×3, 3×2, 4×2, 5×1.

**(b) `gen_metadata.data.f1`** — the same events, nested inside the generation
that eventually succeeded:

```
f1.f14            = retry counter (absent when never retried) → 1,1,2,4,5
f1.f17[]          = repeated attempt records
    .f2           = { f1: model_enum }        on a failed attempt
                      <usage block>           on the successful attempt
    .f3           = error text                on a failed attempt
    .f5           = 1
    .f7           = Duration { f1 seconds, f2 nanos }  — meaning unvalidated, see below
```

`f14` equals the number of failed attempts in every one of the 5 retried
generations (see §3.3). The full error text is:

```
request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse":
  read tcp <ip:port>: ...                                        (×13, redacted)
stream reading error: unexpected EOF                             (×2, terminal)
```

> `f17[].f7` is a `Duration` whose values escalate monotonically
> (`4.000, 6.771, 10.910, 26.181, 60.883` s on the 5-retry chain). It is **not**
> the sum of per-attempt latencies — those sum to 108.7 s against a 74.6 s
> wall-clock span from the first to the last retry record — and the only clean
> coincidence is the last value vs the 60.9 s wait before the succeeding
> generation. Its exact meaning (attempt timeout / backoff delay / something
> else) is **not determinable from 15 samples**. Do not build a metric on it.

These are **transport-level** failures (TCP read / EOF mid-stream). No HTTP
status code, no gRPC code, no quota code appears in any of the 15 records.

### 3.3 The 7 chains, exactly

| # | conversation | gen_idx | step idx run | chain len | `f14` | outcome | duration per attempt (s) |
|---|---|---|---|---|---|---|---|
| 1 | `63512703` | 27 | 122,123,124,125,126 → 127 | 5 | 5 | recovered | 4.000, 6.771, 10.910, 26.181, 60.883 |
| 2 | `c5287535` | 30 | 155,156,157,158 → 159 | 4 | 4 | recovered | 4.000, 5.894, 15.543, 19.969 |
| 3 | `c5287535` | 33 | 170,171 → 172 | 2 | 2 | recovered | 4.000, 6.554 |
| 4 | `c5287535` | 31 | 162 → 163 | 1 | 1 | recovered | 4.000 |
| 5 | `c5287535` | 32 | 166 → 167 | 1 | 1 | recovered | 4.000 |
| 6 | `63512703` | 30 | 136 (`status=7`) → 137 → 138 | 1 | – | recovered by a **new** generation | 4.000 |
| 7 | `c5287535` | 11 | 45 (`status=7`) → 46 → 47 | 1 | – | recovered by a **new** generation | 4.000 |

Chain lengths: `5, 4, 2, 1, 1, 1, 1` (15 failed attempts total).

### 3.4 Concrete examples and why they are one logical attempt

**Example A — the 5-retry chain the note was describing** (`63512703`):

```
idx=121  step_type=132 status=3   tool result
idx=122  step_type=17 status=3    API error (attempt 1): request failed: Post "...streamGenerateContent..."
idx=123  step_type=17 status=3    API error (attempt 2): request failed: Post "..."
idx=124  step_type=17 status=3    API error (attempt 3): request failed: Post "..."
idx=125  step_type=17 status=3    API error (attempt 4): request failed: Post "..."
idx=126  step_type=17 status=3    API error (attempt 5): request failed: Post "...": EOF
idx=127  step_type=15 status=3    ← the generation that finally succeeded
```
Timestamps run `22:26:16 → 22:26:30 → 22:26:44 → 22:27:02 → 22:27:30`
(14 s, 14 s, 18 s, 28.6 s between records; 74.6 s from first to last retry
record) and then a further **60.9 s** before the succeeding generation at
`22:28:31`.
One chain because: consecutive `idx`, all `step_type=17`, monotonic
`attempt N` numbering, identical `f5.f20` trajectory/cascade, and the enclosing
`gen_metadata` row (gen_idx 27) records exactly `f1.f14 = 5` with 6 `f1.f17`
entries whose 5 error entries are textually identical to these 5 rows.

**Example B — a terminal failure recovered at the generation level** (`c5287535`):

```
idx=45  step_type=15 status=7   error_details.f2 = "stream reading error: unexpected EOF"
                                 gen_idx=11: in=7226 out=5309 ttft=5039ms gen=71270ms
idx=46  step_type=17 status=3   API error (attempt 1): stream reading error: unexpected EOF
idx=47  step_type=15 status=3   ← a new generation retried the whole request
```
Chain of 1 failed attempt: the app did not retry inside generation 11; it ended
that generation as an error and started generation 12 for the same user turn.
`gen_idx=11` has `f14` absent and a single `f17` entry carrying both the error
text and the usage block — the only shape where a failed attempt still consumed
tokens.

**Example C — the two tool errors, which are NOT API failures** (`36f80a92`):

```
idx=391  step_type=132 status=3   read_file  (ok, 5.5 s)
idx=392  step_type=132 status=7   read_file  error: "file does not exist"    ← 0.32 s
idx=393  step_type=15 status=3    model continues normally
```
Each tool error is an isolated row (run length 1), has no `gen_metadata` of its
own, and the model simply recovers. These are agent-tool failures, not API
failures, and must not enter a "failed requests" metric.

### 3.5 What identifies chain membership

- **Consecutive `idx`** — works: both tables are gap-free, so the retry rows are
  physically adjacent to the generation they precede.
- **`step_type = 17`** — the cleanest single key: all 15 rows are this type, and
  no other row in the corpus is.
- **Same `trajectory_id` / `cascade_id`** — useless for scoping a chain: every DB
  has exactly **one** trajectory (`trajectory_meta` = 1 row/DB), so the id is
  conversation-scoped, not request-scoped.
- **`request_id`** — `gen_metadata.f1.f20.request_id` is `<trajectory_id>-<gen_idx>`,
  i.e. derived and unique per generation; it does not group retries. The retry
  rows carry their own `<trajectory_id>-<step_idx>` in `f24.f3.f6`.
- **Same `step_type`** — yes, all 17s, but it only narrows to "some retry".
- **Best key** — `step_type=17` run length immediately preceding a `step_type=15`
  row == that generation's `f14`; verified equal for all 5 recovered chains.

---

## 4. Do failures produce `gen_metadata` rows (i.e. usage)?

`gen_metadata` ↔ generation mapping is exact: `gen_metadata.f1.f20.last_step_index
+ 1` is the `step_type=15` step, 704/704 rows, no gaps or fallbacks.

| failure class | rows | has its own `gen_metadata` row | tokens recorded |
|---|---|---|---|
| terminal API failure (`step_type=15`, `status=7`) | 2 | **yes, both** | **yes, non-zero** |
| retried-then-succeeded attempt (`step_type=17`) | 13 | no own row (nested in the surviving generation's `f17`) | **no** usage block on failed attempts |
| tool error (`step_type=132`, `status=7`) | 2 | no (tool calls have no generation) | n/a |

Token cost of the two terminal failures:

| conversation | gen_idx | input | output | thinking | cache read | ttft | generation |
|---|---|---|---|---|---|---|---|
| `63512703` | 30 | 274,157 | 1,956 | 1,926 | 0 | 8,781 ms | 19,975 ms |
| `c5287535` | 11 | 7,226 | 5,309 | 5,309 | 204,549 | 5,039 ms | 71,270 ms |

Against the corpus (8,284,672 input / 961,203 output tokens over 704
generations), failed generations account for **3.40 % of input tokens and 0.76 %
of output tokens** — i.e. a handful of *long-context* failures, not a broad
token-tax.

**No zero-usage generation exists** (0/704), so "failure with no usage row" is
unobserved. Note the 13 intra-generation retries produce **no double-counted
tokens**: only the successful attempt carries a usage block, so the existing
ledger totals are already correct.

⚠️ One real gap: `decode_gen_metadata` returns `None` when `f1.f4` is absent, so
a failure that never reached the usage block would be **skipped entirely** —
invisible to the ledger *and* to any rule based on `antigravity_usage_events`.
Unobserved here, but the rule cannot see it.

---

## 5. Recommended counting rule

### 5.1 The rule

Index two extra integers per `antigravity_usage_events` row:

| column | source | cost |
|---|---|---|
| `retry_count INTEGER NOT NULL DEFAULT 0` | `gen_metadata.data.f1.f14` (absent → 0) | free: `data` is already decoded in `decode_gen_metadata` |
| `failed INTEGER NOT NULL DEFAULT 0` | `steps[last_step_index + 1].status == 7` | nearly free: `STEPS_SQL` already loads that exact row for `created_at`; add `status` to the `SELECT` |

Then:

```
failed_generations      = COUNT(*)                      WHERE failed = 1
failed_attempts         = SUM(retry_count) + COUNT(*)   WHERE failed = 1
total_attempts          = COUNT(*) + SUM(retry_count)
generation_failure_rate = failed_generations / COUNT(*)
attempt_failure_rate    = failed_attempts    / total_attempts
```

On this corpus: `failed_generations = 2` (0.28 % of 704),
`failed_attempts = 13 + 2 = 15` (2.09 % of 719 attempts), verified in §6.

### 5.2 Why this is the *smallest defensible* rule

- It needs **no new table and no new file scan** — one extra `status` column in a
  query that already runs, and one map key already sitting in the decoded blob.
- It counts a logical failure **exactly once** at each granularity:
  retries inside a generation never create rows, so `failed_generations` cannot
  inflate; a cross-generation retry adds one failure row and one success row, so
  it also stays at 1 failure per exhausted generation.
- It is **robust to chain length**: chain length lives in `retry_count`, which is
  reported separately instead of being confused with failures.
- `SUM(retry_count) + failed` and `COUNT(step_type=17)` are equal here, but the
  former is safer: it needs no adjacency assumption and survives a future build
  that emits the retry record in a different position.

### 5.3 Explicitly rejected alternatives

| rule | result here | why rejected |
|---|---|---|
| `COUNT(*) WHERE steps.status != 3` | 15 | folds 11 unrelated `run_command` rows and 2 tool errors into "API failures" |
| `COUNT(*) WHERE error_details IS NOT NULL` | 4 | 50 % of them are tool errors; misses all 13 recovered retries |
| `COUNT(*) WHERE step_type = 17` | 15 | correct *now*, but it is attempt-level; calling it "failed requests" over-states user-visible failures 7.5× |
| count `gen_metadata` rows whose tokens are 0 | 0 | no such rows |
| derive from `gen_metadata.size` | 0 | column is always `0` |
| classify by error-message text | n/a | only transport strings exist; no codes to key on |

### 5.4 Two adjacent signals that must NOT be folded in

- **`step_type=132 AND status=6` — 11 rows, all `run_command`.** No
  `error_details`, a real result payload, duration 18–774 s, and the turn
  continues with a normal model response immediately after. Internal state
  history (`step_payload.f5.f26`) is `(1 → 2 → 6)` where the normal tool path is
  `(1 → 2 → 3)`. Most consistent with "command finished abnormally (non-zero exit
  or user-cancelled command)". **Unvalidated** — the tool-result blob is
  opaque binary (not plain text), so no exit status or cancellation flag is readable. It is emphatically not an API
  failure; excluding it from a request-failure metric is correct, but it means
  `status` must not be used as a proxy.
- **`step_type=132 AND status=7` — 2 rows.** Tool errors (`file does not exist`,
  `edit_file` target mismatch). If the product wants a "tool failure" tile, this
  is a separate counter keyed on `step_type=132`.

Also worth recording for whoever implements this: `step_payload.f5.f26` is a
per-step state-transition list. `(8 → 3)` = generation ok, `(8 → 7)` = failed
generation, `(1 → 2 → 3)` = tool ok, `(1 → 2 → 9 → 2 → 3)` = **not a retry** —
both instances are `ask_question` tool calls that waited ~36 min each for the
user to answer (state `9` = awaiting user input). Do not read `9` as a retry state.

### 5.5 If no schema change is allowed

Not possible from `antigravity_usage_events` alone: it has no failure column, and
`gen_metadata` carries no failure signal. The minimum viable alternative is a
separate `antigravity_failure_events` table fed from the 15 `step_type=17` rows
(`conversation_id`, `step_idx`, `attempt_number`, `last_execution_id`/trajectory,
`created_at`, `classified_error TEXT`), but that duplicates what `f14` already
gives for free and adds a second source of truth.

---

## 6. Cross-validation

Three independent counts of failed HTTP attempts, computed from different fields:

| derivation | value |
|---|---|
| `COUNT(steps WHERE step_type = 17)` | **15** |
| `SUM(gen_metadata.f1.f14) + COUNT(gen step status = 7)` | 13 + 2 = **15** |
| `COUNT(gen_metadata.f1.f17[] entries carrying f3 error text)` | **15** |

All three agree, per-DB and in total. Per-conversation breakdown:

| db | steps | gens | st7 | st6 | type17 | retried gens | failed gens | tool err |
|---|---|---|---|---|---|---|---|---|
| 00824055 | 9 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| 29c809c1 | 21 | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| 36457f3c | 58 | 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| 36f80a92 | 853 | 237 | 2 | 0 | 0 | 0 | 0 | 2 |
| 51c3d8ff | 8 | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| 63512703 | 159 | 38 | 1 | 0 | 6 | 1 | 1 | 0 |
| 6e6bdd05 | 113 | 33 | 0 | 0 | 0 | 0 | 0 | 0 |
| 7269c94d | 17 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| 82072e83 | 167 | 45 | 0 | 1 | 0 | 0 | 0 | 0 |
| 86e64099 | 11 | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| 89dc2929 | 63 | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| a9045bbe | 6 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| c0121e72 | 801 | 245 | 0 | 10 | 0 | 0 | 0 | 0 |
| c5287535 | 179 | 36 | 1 | 0 | 9 | 4 | 1 | 0 |
| deda4e6e | 13 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| **TOTAL** | **2,478** | **704** | **4** | **11** | **15** | **5** | **2** | **2** |

Reproduce with `validate.py` in this directory.

### Integrity

- `.db` SHA-256 identical before and after the whole analysis (15/15).
- Directory membership unchanged (15 `.db` + 15 `.db-wal` + 15 `.db-shm`).
- All 15 `-wal` files are 0 bytes → everything is checkpointed, so the read view
  is complete rather than a stale snapshot.
- Every connection opened as `sqlite3.connect('file:…?mode=ro', uri=True)` with
  `PRAGMA query_only = ON`. Unavoidable side effect: SQLite updates its read-marks
  in the `-shm` wal-index (mtime changed; no conversation data, and no `.db`/
  `-wal` byte changed). `immutable=1` was deliberately not used — it would ignore
  committed WAL content.
- Repository untouched; all artefacts under `/tmp/ag-evidence/failures/`.

---

## 7. Sample size and confidence

### How much evidence actually backs this

| quantity | count |
|---|---|
| conversations | 15 |
| generations | 704 |
| user turns (`step_type=14`) | 57 |
| failed HTTP attempts | **15** |
| generations with ≥1 retry | **5** |
| retry chain lengths observed | 1, 1, 1, 1, 2, 4, 5 |
| failed generations | **2** |
| **user-visible failures** | **0** |
| distinct failure causes | **2** (TCP read reset; mid-stream EOF) |
| time span of all failures | **one ~75 s window**, 2026-11-27 22:26:16–22:27:30 (+2 isolated: 21:42:02, 22:48:51) |

**This is a tiny, clustered sample.** 15 failed attempts across 704 generations
is 2.1 %, and 13 of them (87 %) belong to a single ~75-second network blip spanning two
conversations. There is **not a single** quota error, rate-limit response, auth
failure, model-side 5xx or timeout of the `DEADLINE_EXCEEDED` kind anywhere in
the corpus. Whatever the production failure mix looks like, this dataset does not
contain it.

**Zero user-visible failures.** In both terminal-failure cases the app emitted a
`step_type=17` retry record and then a *new successful generation* for the same
user turn (step 138 and step 47). Verified turn by turn: segmenting each
conversation on `step_type=14` (user message) yields **57 user turns, and
0 of them ended without a `status=3` generation**. So "did the user eventually
get a response?" is **yes, 57/57**. If the product metric is "turns that ended
without an answer", the correct count here is 0, not 2.

### Confidence statement

- **High confidence** in the *structural* findings: three encodings agree
  row-for-row (`status=7`, `error_details`, `payload.f31`); retries appear in two
  places that agree exactly (15/15/15); the generation↔step mapping is 704/704
  exact. These are not guesses — they are exhaustively cross-checked over the
  whole corpus.
- **High confidence** that the note's stated mechanism is wrong: consecutive
  `status=7` / `error_details` runs **do not exist** (max run = 1). The premise
  "counting raw error rows inflates the count" does not hold for those columns;
  it holds only for `step_type=17`, which is a different thing.
- **Medium confidence** in the field semantics: `f1.f14` = retry count fits all 5
  cases but is inferred from 5 observations; `steps.status` ∈ {3=ok, 6=?, 7=error}
  is inferred (undocumented); `f1.f17[].f7` is *not* understood at all (see §3.2)
  and must not be surfaced.
- **The counting rule is arithmetically validated and statistically UNVALIDATED.**
  It reproduces these 15 failures exactly from two cheap fields; it has not been
  tested against a failure mode other than transport-level TCP/EOF — the cases
  most likely to break `retry_count` semantics (retried *and then* terminal,
  retried across a model switch, retry after a 429) are entirely absent.
- **What would change the recommendation:**
  1. a retried-then-failed generation — then `SUM(retry_count) + failed` needs
     checking against `SUM(retry_count)+1` (off-by-one risk in `f14`);
  2. any failure recorded with `status != 7` outside `step_type=17`;
  3. a generation rejected before its usage block exists — currently invisible,
     so the rule would undercount;
  4. a chain that rewrites the same `gen_metadata.response_id` — the ledger's
     `response_key` dedup would then silently keep only the last attempt.

### Bottom line for the ledger

Ship `failed` (generation-level, from `steps.status = 7` on the generation step)
and `retry_count` (from `gen_metadata.f1.f14`) as separate fields, keep
`failedRequests` un-merged with Proxy data, and label the Antigravity failure
tiles **"API failures (local, transport-level)"** with the attempt/generation
distinction visible. Do not claim a failure *rate* with confidence from this
sample — do claim the *counts* are exact.
