# Antigravity conversation DBs: append-only evidence + full re-read cost

Read-only forensics on `~/.gemini/antigravity/conversations/*.db`. Every connection was opened as `file:<path>?mode=ro` (`sqlite3.connect(..., uri=True)`); nothing under `~/.gemini` was written, no `VACUUM`, no checkpoint. All generated files live under `/tmp/ag-evidence/`.

| item | value |
|---|---|
| DBs | 15 |
| `gen_metadata` rows | 704 |
| `steps` rows | 2478 |
| total `.db` bytes | 82,378,752 (82.4 MB) |
| `gen_metadata.data` bytes | 10,249,244 (10.25 MB) |
| `steps.metadata` bytes | 3,978,812 (3.98 MB) |
| `.db-wal` bytes (all DBs) | 0 |

## Verdict table

| # | Question | Verdict |
|---|---|---|
| 1 | Append-only, no deletions (count == max+1, no gaps, freelist 0) | **HOLDS** 15/15 for both tables |
| 2a | `size` column == `length(data)` | **DOES NOT HOLD** — `size` is 0 in all 704 rows (uniformly unpopulated, not a partial-write signal) |
| 2b | Every row decodes to a complete usage block | **HOLDS** — 704/704 decode, 0 truncated, 0 missing required fields; only "absent means zero" optionals absent |
| 2c | Every gen's `last_step_index + 1` exists; newest gen's anchor exists | **HOLDS** — 0 exceptions; tail closed in 15/15 |
| 3 | Live re-dump vs snapshot (`idx <= snapshot max`) | **NO CHANGE OBSERVED** — 30/30 length files byte-identical and 3,182 row hashes unchanged after ~11 min; 0 changed, 0 removed, 0 added |
| 4 | Time ordering of gens; `response_key` uniqueness; retries | **HOLDS with one caveat** — 0 gen inversions, 704 distinct keys, 0 dup; 2 backdated `step_type=14` step timestamps |
| 5 | Cost of a full re-read | **6.31 ms for all 15 DBs; 2.26 ms worst DB** — incremental would save ~4.6 ms total |
| 6 | WAL state | **CLEAN** — all `-wal` 0 bytes, no rows only in WAL |
| 7 | Are already-completed rows immutable? | **DOES NOT HOLD for `gen_metadata`** — one payload-bearing tail row per conversation implies the previous rows were rewritten in place |

## 1. Append-only: no deletions

**Verdict: HOLDS** for both tables in all 15 DBs.

- `COUNT(*) == MAX(idx) + 1` for `gen_metadata`: PASS in 15/15
- `COUNT(*) == MAX(idx) + 1` for `steps`: PASS in 15/15
- idx gaps: `gen_metadata` 0 DBs, `steps` 0 DBs
- `PRAGMA freelist_count > 0`: 0 DBs (all 15 report 0 freed pages)
- Non-null rows: `gen_metadata.data` NULL in 0 rows; `steps.metadata` NULL in 0 rows.
- `journal_mode=wal`, `page_size=32768`, `auto_vacuum=0`, `user_version=1`, `schema_version=9` in every DB.

| cid | gen rows | gen max idx | step rows | step max idx | gen gaps | step gaps | freelist |
|---|---|---|---|---|---|---|---|
| `00824055` | 3 | 2 | 9 | 8 | 0 | 0 | 0 |
| `29c809c1` | 8 | 7 | 21 | 20 | 0 | 0 | 0 |
| `36457f3c` | 12 | 11 | 58 | 57 | 0 | 0 | 0 |
| `36f80a92` | 237 | 236 | 853 | 852 | 0 | 0 | 0 |
| `51c3d8ff` | 4 | 3 | 8 | 7 | 0 | 0 | 0 |
| `63512703` | 38 | 37 | 159 | 158 | 0 | 0 | 0 |
| `6e6bdd05` | 33 | 32 | 113 | 112 | 0 | 0 | 0 |
| `7269c94d` | 7 | 6 | 17 | 16 | 0 | 0 | 0 |
| `82072e83` | 45 | 44 | 167 | 166 | 0 | 0 | 0 |
| `86e64099` | 5 | 4 | 11 | 10 | 0 | 0 | 0 |
| `89dc2929` | 22 | 21 | 63 | 62 | 0 | 0 | 0 |
| `a9045bbe` | 3 | 2 | 6 | 5 | 0 | 0 | 0 |
| `c0121e72` | 245 | 244 | 801 | 800 | 0 | 0 | 0 |
| `c5287535` | 36 | 35 | 179 | 178 | 0 | 0 | 0 |
| `deda4e6e` | 6 | 5 | 13 | 12 | 0 | 0 | 0 |

## 2. Append-only: no in-place rewrites (content evidence)

### 2a. `size` column vs `length(data)`

**Verdict: DOES NOT HOLD as stated — but this is not evidence of partial writes.**

The two disagree for **704 / 704 rows across all 15 DBs**, because `size` is `0` in every single row (`sum(size<>0) = 0` for all 15 DBs) while `length(data)` ranges 1,186–1,803,077 bytes. The column is uniformly unpopulated, including on the newest rows, so it carries no information about partial or later updates. If it were a "row grew after insert" marker we would expect non-zero values somewhere; there are none.

### 2b. Can every `gen_metadata.data` be decoded into a complete usage block?

**Verdict: HOLDS.** 704/704 rows decode; 0 truncated blobs, 0 rows missing a required field.

| field consumed by cc-use | present |
|---|---|
| `f1.f4.f2` input tokens | 704/704 = 100.0% |
| `f1.f4.f3` output tokens | 704/704 = 100.0% |
| `f1.f4.f5` cache-read tokens | 659/704 = 93.6% (missing 45) |
| `f1.f4.f4` cache-creation tokens | 0/704 = 0.0% (missing 704) |
| `f1.f4.f7` bot id (fallback response key) | 704/704 = 100.0% |
| `f1.f4.f9` thinking tokens | 701/704 = 99.6% (missing 3) |
| `f1.f4.f10` response tokens | 703/704 = 99.9% (missing 1) |
| `f1.f4.f11` response id (primary response key) | 704/704 = 100.0% |
| `f1.f11` TTFT duration | 704/704 = 100.0% |
| `f1.f12` generation duration | 704/704 = 100.0% |
| `f1.f21`/`f1.f19` model name | 704/704 = 100.0% |
| `f1.f20["last_step_index"]` | 704/704 = 100.0% |
| `f1.f20["request_id"]` (fallback response key) | 704/704 = 100.0% |

The only absent fields are the ones the format defines as "absent means zero": `f4` cache-creation is 0% (never emitted on this account), `f5` cache-read is 93.6%, `f9` thinking 99.6%, `f10` response-token 99.9%. The 45 rows that lack `f5` are exactly the 45 rows flagged as "core missing"; `idx 0` lacks it in all 15 DBs (nothing can be cached on the first generation), and the rest are scattered, not a contiguous old prefix. Absence is therefore semantically "no cache read", not "row not finished".

Cross-check of a semantic invariant (also asserted in the repo's own parser comment): `output_tokens == thinking_tokens + response_tokens` — violations: **0** across all rows that carry both fields.

### 2c. Anchor step existence (`last_step_index + 1`)

**Verdict: HOLDS.** Every generation's `last_step_index + 1` exists in `steps`; so does `last_step_index` itself.

- Generations whose anchor step `last_step_index + 1` is missing: **0** DBs
- Generations whose `last_step_index` itself is missing: **0** DBs
- `last_step_index` monotonic non-decreasing with gen idx: **True**
- **Tail safety**: for the newest generation in every DB the anchor step already exists (15/15), and `max(steps.idx) == last_step_index + 1` in 15/15 DBs.
- Interpretation: at rest the newest generation row and the step it produced are both committed, so the tail is "closed".

| cid | newest gen idx | its last_step_index | anchor (=lsi+1) | anchor exists | steps max |
|---|---|---|---|---|---|
| `00824055` | 2 | 7 | 8 | True | 8 |
| `29c809c1` | 7 | 19 | 20 | True | 20 |
| `36457f3c` | 11 | 56 | 57 | True | 57 |
| `36f80a92` | 236 | 851 | 852 | True | 852 |
| `51c3d8ff` | 3 | 6 | 7 | True | 7 |
| `63512703` | 37 | 157 | 158 | True | 158 |
| `6e6bdd05` | 32 | 111 | 112 | True | 112 |
| `7269c94d` | 6 | 15 | 16 | True | 16 |
| `82072e83` | 44 | 165 | 166 | True | 166 |
| `86e64099` | 4 | 9 | 10 | True | 10 |
| `89dc2929` | 21 | 61 | 62 | True | 62 |
| `a9045bbe` | 2 | 4 | 5 | True | 5 |
| `c0121e72` | 244 | 799 | 800 | True | 800 |
| `c5287535` | 35 | 177 | 178 | True | 178 |
| `deda4e6e` | 5 | 11 | 12 | True | 12 |

## 3. Live-diff experiment

- Lead snapshot: `2026-11-28T01:03:11Z`
- Dump #1: `2026-11-28T01:04:24+00:00`
- Hash baseline #1: `2026-11-28T01:09:19+00:00`
- Dump #2: `2026-11-28T01:14:24+00:00`
- Hash baseline #2: `2026-11-28T01:14:24+00:00`

Context: the whole conversation set was completely idle. Every `.db` mtime predates the snapshot (newest is 2026-11-27 23:36 local) and every `-wal` is 0 bytes, so **no change was expected**. This is a negative control: it shows the re-dump pipeline and the snapshot format are stable and that nothing changed in the window — it does *not* prove rows cannot be rewritten.

### 3.1 Snapshot vs dump #2 (the ~10 minute window)

- Files compared: 30; byte-identical: 30
- Already-indexed rows that changed (idx <= snapshot max idx): **0**
- Rows removed: **0**
- Rows added (conversation grew): **0**

### 3.2 Full-row sha256 baseline: hash #1 vs hash #2

Lengths and the first 24 bytes are a weak fingerprint: a same-length in-place rewrite would be invisible. So a full sha256 of every blob was taken at both timestamps.

- Rows compared (all gen_metadata.data + all steps.metadata): **3,182**
- Content changed: **0**
- Rows added: **0**; removed: **0**

```
snapshot_vs_dump1: files=30 identical=30 changed_rows=0 new=0 removed=0
snapshot_vs_dump2: files=30 identical=30 changed_rows=0 new=0 removed=0
hash1_vs_hash2: compared=3182 changed=0 added=0 removed=0
WAL / sizes (dump2):
```


## 4. Ordering assumptions and response-key uniqueness

### 4a. Are `gen_metadata` rows ordered by time?

`gen_metadata` has no timestamp of its own, so each row was anchored to the timestamp of its anchor step (`steps.metadata.f1` = `google.protobuf.Timestamp`, `last_step_index + 1`, falling back to `last_step_index`).

- Rows with a resolvable timestamp: 704/704 (all 15 DBs 100%)
- Timestamp inversions between consecutive gen idx: **0** across all 15 DBs
- Step timestamps themselves are monotonic with idx **except 2 rows**, both in `89dc2929`, both `step_type=14`, backdated by −31.2 s and −43.1 s relative to their neighbours. Inversions not involving type 14: **0**. Type-14 rows are therefore stamped at creation time but assigned a higher idx later (out-of-order insertion of that one type).

### 4b. `response_key` uniqueness / retries

Key = `f1.f4.f11` (server response id), falling back to `f1.f4.f7` (bot id), falling back to `f1.f20.request_id`.

- Rows with a key: 704/704; source used: {'f11': 704} (the fallbacks were never needed)
- Distinct keys: **704** — duplicate keys: **0** in every DB
- No generation was ever seen twice under the same key, so there is no *observed* duplicate-retry record. This does **not** prove retries are impossible: a retry that obtained a new server response id would look like a brand-new generation.
- Supporting evidence: `request_id` in `f1.f20` is `{trajectory_id}-{gen idx}` — the numeric suffix equals the row idx in **704/704** rows (0 mismatches), i.e. the request sequence number never repeats or rolls back.

## 5. Cost of a full re-read (data side)

Measured with a fresh read-only connection per DB, 7 repetitions, median of the two queries the current implementation issues (`SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC` and `SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL`). OS page cache warm (the realistic steady state for a polled local app); see the cold-cache bound below.

| cid | db MB | gens | steps | gen blob MB | step blob MB | gen_ms | steps_ms | full_ms | tail_ms |
|---|---|---|---|---|---|---|---|---|---|
| `00824055` | 0.7 | 3 | 9 | 0.17 | 0.01 | 0.03 | 0.01 | 0.04 | 0.02 |
| `29c809c1` | 1.0 | 8 | 21 | 0.19 | 0.01 | 0.02 | 0.01 | 0.04 | 0.02 |
| `36457f3c` | 1.5 | 12 | 58 | 0.35 | 0.05 | 0.05 | 0.03 | 0.09 | 0.05 |
| `36f80a92` | 26.3 | 237 | 853 | 2.07 | 1.32 | 0.61 | 1.66 | 2.26 | 0.34 |
| `51c3d8ff` | 0.9 | 4 | 8 | 0.16 | 0.00 | 0.03 | 0.01 | 0.03 | 0.02 |
| `63512703` | 4.6 | 38 | 159 | 1.13 | 0.31 | 0.30 | 0.31 | 0.61 | 0.17 |
| `6e6bdd05` | 4.8 | 33 | 113 | 0.99 | 0.23 | 0.20 | 0.11 | 0.31 | 0.13 |
| `7269c94d` | 0.8 | 7 | 17 | 0.18 | 0.01 | 0.02 | 0.01 | 0.03 | 0.03 |
| `82072e83` | 4.0 | 45 | 167 | 0.80 | 0.28 | 0.14 | 0.10 | 0.23 | 0.12 |
| `86e64099` | 1.0 | 5 | 11 | 0.20 | 0.01 | 0.03 | 0.01 | 0.04 | 0.02 |
| `89dc2929` | 2.0 | 22 | 63 | 0.31 | 0.09 | 0.05 | 0.03 | 0.08 | 0.04 |
| `a9045bbe` | 0.8 | 3 | 6 | 0.15 | 0.00 | 0.02 | 0.00 | 0.02 | 0.02 |
| `c0121e72` | 22.9 | 245 | 801 | 2.11 | 1.28 | 0.46 | 1.43 | 1.88 | 0.48 |
| `c5287535` | 10.1 | 36 | 179 | 1.23 | 0.39 | 0.19 | 0.41 | 0.61 | 0.20 |
| `deda4e6e` | 1.0 | 6 | 13 | 0.22 | 0.01 | 0.04 | 0.01 | 0.04 | 0.03 |
| **total** | **82.4** | **704** | **2478** | **10.25** | **3.98** | **2.18** | **4.13** | **6.31** | **1.70** |

- **Worst case today**: `36f80a92` — 26.3 MB file, 237 generations, 853 steps → 2.26 ms per full re-read.
- **Whole dataset**: 6.31 ms to re-read all 15 conversations (704 gens, 2,478 steps, 10.25 + 3.98 MB of blobs). Across the 7 repetitions the total ranged 5.21–10.97 ms, so treat the headline as ~6 ms ± a factor of two, not a benchmark of record.
- **Tail-only read** (simulating `idx > last_idx - 5`): 1.70 ms — i.e. an incremental cursor would save ~4.62 ms (73%) across the entire dataset, and it saves least on `gen_metadata` because the newest row is the biggest one.
- Opening a connection is ~1.31 ms total for all 15 DBs; so the read is not dominated by connection setup.
- **Realistic per-event saving** (simulating one new generation + its ~4 new steps, the worst conversation `36f80a92`): `gen_metadata` 0.448 → 0.281 ms (must read the new 1.77 MB tail row), `steps` 1.238 → 0.004 ms, and the max-idx sanity query costs 0.003 ms. Net ~1.4 ms saved per sync event on the worst conversation, ~0.3 ms on a typical one.
- Page accounting (dbstat) on the 26.3 MB DB: the `steps` table occupies **21.82 MB** of pages but only **1.32 MB** of that is `metadata` — the weight is `step_payload`, which the current query never selects, so overflow pages for it are not read. `gen_metadata` occupies 3.15 MB of pages for 2.07 MB of blobs.
- Cold-cache bound: a `F_NOCACHE` sequential read of the 26.3 MB file took 5.3–14.6 ms (1.8–4.9 GB/s), so even a fully cold read of the entire 82.4 MB dataset is ~17–46 ms. A 100 ms full re-read needs roughly **40–45× the largest conversation that exists today** (≈10,000 generations, ≈38,000 steps in one conversation), warm or cold.

Extrapolation caveat: this scales row count linearly. Blob volume does **not** scale linearly in practice — 91% of `gen_metadata` bytes sit in a single tail row per conversation (see §7), so growth is closer to linear-in-rows than linear-in-context-length.

## 6. WAL state

**Verdict: nothing is pending in WAL.**

| cid | .db bytes | .db-wal bytes | -shm exists | db mtime (local) |
|---|---|---|---|---|
| `00824055` | 720,896 | 0 | True | 2026-11-27T23:36:58.067320+08:00 |
| `29c809c1` | 983,040 | 0 | True | 2026-11-22T16:09:14.970039+08:00 |
| `36457f3c` | 1,474,560 | 0 | True | 2026-11-27T12:42:53.148968+08:00 |
| `36f80a92` | 26,279,936 | 0 | True | 2026-11-23T22:34:54.785140+08:00 |
| `51c3d8ff` | 851,968 | 0 | True | 2026-11-23T21:45:08.773016+08:00 |
| `63512703` | 4,620,288 | 0 | True | 2026-11-27T22:58:52.768251+08:00 |
| `6e6bdd05` | 4,849,664 | 0 | True | 2026-11-25T21:07:56.119320+08:00 |
| `7269c94d` | 819,200 | 0 | True | 2026-11-22T15:57:17.634091+08:00 |
| `82072e83` | 4,030,464 | 0 | True | 2026-11-26T21:56:38.586775+08:00 |
| `86e64099` | 950,272 | 0 | True | 2026-11-25T23:18:24.380480+08:00 |
| `89dc2929` | 1,966,080 | 0 | True | 2026-11-27T12:30:46.649311+08:00 |
| `a9045bbe` | 786,432 | 0 | True | 2026-11-24T20:31:18.325392+08:00 |
| `c0121e72` | 22,904,832 | 0 | True | 2026-11-22T17:56:41.330464+08:00 |
| `c5287535` | 10,125,312 | 0 | True | 2026-11-27T22:30:39.456602+08:00 |
| `deda4e6e` | 1,015,808 | 0 | True | 2026-11-27T23:05:52.260083+08:00 |

- All 15 `-wal` files are **0 bytes**, so every committed row is in the main `.db` file and **no committed row exists only in WAL** right now.
- `-shm` files exist for all 15 DBs (32,768 bytes each) with mtime 2026-11-28 09:03 — that is the timestamp of the read-only snapshot, not a write: opening a WAL database read-only touches the shm/-wal header. No `.db` file has been modified since 2026-11-27 23:37 local (see mtimes).
- Consequence for the live-diff experiment: with an empty WAL there is nothing that "only exists in WAL" for a snapshot to miss — the snapshot is the whole truth at rest. It also means the spaces for growth signals are the row counts and the row lengths, not file mtime alone.

## 6b. Read-only integrity check (did the experiment write anything?)

Measured after all reads finished:

| file class | state |
|---|---|
| `*.db` | all 15 mtimes unchanged and predate this session (newest: 2026-11-27 23:36 local); sizes unchanged |
| `*.db-wal` | all 15 still 0 bytes, mtimes unchanged (2026-11-27) |
| `*.db-shm` | mtime moved to now (32,768 bytes each) — side effect of any read-only WAL connection, not conversation data |
| repository | not modified (read-only inspection for the field map) |

So no conversation data was written, no `VACUUM`, no checkpoint. The `-shm` mtime change is unavoidable when a WAL database is opened even with `mode=ro`; the `.db` and `.db-wal` timestamps prove the data files were not touched.

## 7. Critical finding not covered by the questions: `gen_metadata` rows are not immutable

While checking "no in-place rewrites" against content, one pattern showed up in **all 15 DBs** and it decides how safe an `idx > last_idx` cursor is.

### Observed

- Exactly **one** `gen_metadata` row per conversation carries the generation's request payload (`data.f1.f1` prompt, `data.f1.f2` message list, `data.f1.f8` tool definitions, `data.f1.f16` context sections). In **15/15** DBs that row is the newest row, i.e. `max(idx)` — including the 237-row and 245-row conversations.
- Every other row is small telemetry: 1,186–2,363 bytes (median ≈1,200–1,400 B), versus 149,583–1,803,077 bytes for the payload-carrying tail row.
- **91% of all `gen_metadata` bytes (9.37 of 10.25 MB) are these 15 tail rows.**
- The `steps` table shows no such pattern: average `step_payload` is flat across idx deciles (no age-based pruning), so there is no general "strip old payloads" maintenance pass operating on this database.
- The payload is not stored somewhere else either: `executor_metadata` holds 20 near-identical ~45 KB configuration snapshots, `trajectory_metadata_blob` is 764 B, and `parent_references`/`battle_mode_infos` are empty. So the old rows' payloads were removed, not relocated.

### Inferred (not directly observed)

The "only the newest row has the payload" state cannot be produced by a writer that only ever appends:

1. Each `gen_metadata` row is a generation record, and the payload it contains is the request that produced *that* generation: in all 15 DBs the tail row's embedded message list reaches exactly step `last_step_index + 1` (its own anchor) and never a later step — verified 15/15. So a row is semantically a payload-carrying record.
2. Rows are never deleted or renumbered (Q1: contiguous idx, `count == max+1`, `freelist_count = 0`, and `dbstat` accounts for 100% of the file with 0% unaccounted pages). So older rows did not lose their payload by being deleted and re-inserted.
3. Therefore the only way older rows can lack a payload is that the payload was **removed from the row in place** — either the row is written small and later grown when it is the newest (also an in-place update), or it is written large and stripped when the next generation arrives.
4. "Old app version wrote small rows, new version writes big ones" is ruled out: a version change would leave one big row per generation written after the update, yet conversations with 237 and 245 generations have exactly one big row — the newest.

### Consequence

- **"Already-completed rows are never rewritten" does NOT hold for `gen_metadata.data`.** 689 of the 704 rows are (inferred) rewritten content: every row that is not currently the tail has had its payload stripped.
- The rewrite demonstrably preserves the fields cc-use reads: all 689 stripped rows still carry input/output/thinking/response tokens, both durations, model, `last_step_index`, `request_id` and `response_id`, the `output == thinking + response` invariant holds in all of them, and `request_id` suffix == idx holds in all 704 rows. That is consistent with "re-serialize, drop the payload, keep telemetry", but it is *not* proof that telemetry values can never change during that rewrite.
- For cc-use specifically the practical risk is bounded: it reads only the telemetry fields, never the payload fields that get stripped. But an `idx > last_idx` cursor **must not** be sold as "safe because rows are immutable" — the row body is mutable, at least once, by design.

## Recommendation

**Ship the `idx > last_idx` cursor only as a size optimisation, not as a correctness-guaranteed mirror of an append-only log — and at current data sizes don't ship it yet.**

1. **Cost does not justify it today.** A full re-read of every conversation is 6.31 ms; the worst conversation is 2.26 ms; opening the DBs costs 1.31 ms. An incremental cursor would save about 4.6 ms across the whole dataset (~1.4 ms on the worst conversation), and it saves least on `gen_metadata` because 91% of that table's bytes are in the newest row, which any cursor has to read anyway. That is noise next to protobuf decode and UI work. Revisit at ~40–45× today's row counts (a single conversation with ≈10k generations / ≈38k steps), which is where a warm full re-read approaches 100 ms.
2. **Do the cheap 98% instead.** If read cost ever matters, the win is in `steps` (4.13 ms → 0.07 ms by reading only the tail), not in `gen_metadata`. An `idx >` guard on the `steps` query is low-risk (no rewrite evidence at all: uniform payload sizes by age, monotonic timestamps except 2 type-14 rows, and cc-use only reads the immutable timestamp column).
3. **If the gen cursor ships anyway, it needs these guards** (each is cheap):
   - **Tail overlap / re-read window**: always re-read the last K rows (K ≥ 2) rather than strictly `idx > last_idx`. That is the only guard that covers the §7 finding — the newest row is exactly the row that changes shape later — and it costs one extra ~1.2 KB row plus the row you already read.
   - **Shrink / reset detection**: if `max(idx) < cursor.last_idx` or `COUNT(*) != MAX(idx)+1`, do a full re-read and rebuild.
   - **Gap detection**: if the new `max(idx)` is not exactly `last_idx + rows_read`, re-read from scratch (an apparently-appended batch that skips an idx means the cursor assumption broke).
   - **Never cache the payload fields** (`f1.f1`, `f1.f2`, `f1.f8`, `f1.f16`) across a cursor; only cache the telemetry the app consumes. Recompute derived aggregates from the union of cached telemetry + the re-read tail.
   - **Keep the `steps` side honest too**: status values 6 and 7 exist at rest (15 rows, all interior, never at the tail), so `status` is a mutable-looking column. cc-use does not read it today — make sure no future reader starts trusting a cached `status`.
4. **Do not use `idx` monotonicity as a time source.** Generations are time-ordered in the data (0 inversions across 704 rows when anchored on step timestamps), but the ordering evidence is derived, not a column; keep sorting by the step timestamp as today.

## What this evidence does NOT establish

- **A static snapshot cannot prove "never rewritten".** It can only show the at-rest state is complete and self-consistent, plus structural fingerprints (the §7 tail-payload pattern) that are *inconsistent* with a pure append-only writer. The actual rewrite event was never observed.
- **Transient states are invisible.** All 704 rows are complete at rest, but nothing here observes a row between insert and final update. If a row is briefly missing its durations, a reader that acts inside that window would still see it; the snapshot cannot show it either way.
- **Write ordering between the two tables is unknown.** At rest every generation's anchor step exists; that does not prove the step is committed *before* the generation row, only that both are present when the database is at rest.
- **The live-diff window is short and Antigravity was idle.** No conversation changed during the window (see §3), so the experiment could not catch a mutation event in the act. "No change observed" is the correct reading — it is a useful negative control, not proof of immutability.
- **Whether telemetry values change during the §7 rewrite is unknown.** Invariants hold across all stripped rows, which is consistent with "same values re-serialized", but no direct observation exists.
- The `-shm` mtimes moved when the read-only snapshots were opened; the data files did not. That is an artifact of read-only WAL access, not a write to the conversation data.

## Artifacts

| path | contents |
|---|---|
| `/tmp/ag-evidence/append-only/pb.py` | minimal protobuf wire decoder |
| `/tmp/ag-evidence/append-only/analyze.py` | Q1/Q2/Q4/Q6 scan → `analysis.json` |
| `/tmp/ag-evidence/append-only/bench.py` | Q5 timings → `bench.json`, `bench_totals.json` |
| `/tmp/ag-evidence/append-only/dump.py` | snapshot-format re-dump (dump1/dump2) |
| `/tmp/ag-evidence/append-only/hashdump.py` | full sha256 per row (hash1/hash2) |
| `/tmp/ag-evidence/append-only/livediff.py` | Q3 diffs → `livediff.json` |
| `/tmp/ag-evidence/append-only/gen_report.py` | this report |
