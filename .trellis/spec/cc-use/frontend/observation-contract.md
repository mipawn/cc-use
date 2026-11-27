# Observation Contract

## 1. Scope / Trigger

Apply when changing ledger scopes, statistics/pagination, request-detail navigation, or precise Console lookup. The GUI observes requests; it does not regain project launching or project aggregation. Historical directory/name context is detail-only.

Use [API Bridge](./api-bridge.md) for transport rules. Authoritative implementations: [URL context](../../../../src/renderer/utils/observationContext.ts), [Statistics](../../../../src/renderer/pages/Statistics.tsx), [request-log SQL](../../../../src-tauri/src/db/request_logs.rs), [precise projection](../../../../src/renderer/hooks/useConsoleRequestProjection.ts), and [retained Console reads](../../../../src-tauri/src/services/console_log_store.rs).

## 2. Signatures (API / Command / DB)

Renderer calls `getApi()`; no direct native invocation:

```ts
requestLog.getStatistics(timeRange: StatsTimeRange, filter?: RequestLogFilter): Promise<UsageStatistics>
requestLog.getRecentPaginated(timeRange: StatsTimeRange, page?: number,
  pageSize?: number, filter?: RequestLogFilter): Promise<PaginatedRecentRequests>
console.readRequest(requestId: string, limit?: number): Promise<ConsoleLogPage>
```

| API | Tauri command / camelCase arguments |
|---|---|
| `getStatistics` | `request_log_get_statistics({ timeRange, filter? })` |
| `getRecentPaginated` | `request_log_get_recent_paginated({ timeRange, page, pageSize, filter? })` |
| `readRequest` | `console_log_read_request({ requestId, limit })` |

The [bridge](../../../../src/renderer/api/index.ts) omits `filter` when absent; Rust uses `Option<RequestLogFilter>` and defaults to an empty filter. [Statistics commands](../../../../src-tauri/src/commands/statistics.rs) return `Result<_, String>` and delegate to:

```rust
request_log_get_statistics_filtered(&self, time_range: &str, filter: &RequestLogFilter)
    -> Result<UsageStatistics, rusqlite::Error>
request_log_get_recent_paginated_filtered(&self, time_range: &str, page: i64,
    page_size: i64, filter: &RequestLogFilter)
    -> Result<PaginatedRecentRequests, rusqlite::Error>
read_request(dir: &Path, request_id: &str, limit: usize) -> Result<ConsoleLogPage, String>
```

The shared SQL builder `request_log_where(time_range, filter, prefix)` returns a parameterized clause and values; `prefix` is internal, never an IPC identifier. No schema migration or new environment variable is required.

## 3. Contracts (State / Payload / Lifetime)

### URL is the ledger scope

```ts
interface ObservationContext {
  timeRange: StatsTimeRange
  filter: RequestLogFilter
  page: number
  pageSize: number
}
// RequestLogFilter: providerId?, apiKeyId?, instanceId?, outcome?, population?, source?
// outcome: success | failed | client_error | upstream_error | transport_error
// population: all | with_usage (omitted means all)
// source: proxy | antigravity_desktop | antigravity_cli (omitted means the merged ledger)
```

- Use `parseObservationContext`, `buildStatisticsUrl`, and `buildConsoleUrl`; do not forward arbitrary search strings or route state. Allowed parameters are `timeRange`, legacy `startDate`/`endDate`, the six filter fields (including `source`), `page`, `pageSize`, `requestId`, and `requestDate` only.
- Defaults: `week`, empty filter, page 1, page size 10. Ranges: `today`, `yesterday`, `week`, `last30Days`, `lastYear`, `month`, `lastMonth`, `year`, `all`, or inclusive `custom:YYYY-MM-DD:YYYY-MM-DD`. Legacy dates must be valid, ordered, supplied together, and consistent with an explicit range.
- Resource IDs and request IDs match `[A-Za-z0-9_-]{1,128}` in the URL. Dates are real calendar dates. URL page values are positive safe integers; page size is at most 100. Unknown keys, duplicates, empty/malformed values invalidate the **whole** context, never broaden it.
- Statistics → drawer → Console → return preserves range, filters, page, and page size. Drawer handoff adds only `requestId` and optional local `requestDate` derived from the stored timestamp. Clearing the locator keeps a return-to-ledger action with the original context. Missing/invalid request ID disables handoff.
- Any selected failure outcome uses `withObservationOutcome`: reset page to 1 and switch population to `all`, retaining date/resource scopes. Time/filter changes reset pagination; page refresh keeps the current URL.
- Session tokens, credentials, connection/query drafts, and filesystem paths never enter observation URLs or filter DTOs. `instanceId` is a stable managed-instance ID, not its session token.

### SQL scope precedes every aggregation and LIMIT

- Apply one `request_log_where` scope to summary, trend/dimensions, ledger count, and ledger rows **before** aggregation or `LIMIT/OFFSET`. Never download an unscoped page and filter it in React.
- Provider/Key/instance IDs must still exist; combined Key/provider scopes must belong together. Resolve the instance-to-session-token association only inside SQL. A removed association is an error, not an empty/global retry. Historical request rows are not deleted merely because a resource disappears.
- `with_usage` means at least one of input/output/cache-read/cache-creation token counts is positive; cache-only records count. `failed` means non-null outcome other than `success`, including future/legacy failure strings.
- `summary.totalRequests`, token totals, trends and usage dimensions retain the **with-usage** denominator within the selected scope. `summary.failedRequests` and ledger `total` use the selected population. Do not relabel the billable request count as all requests or compute a failure rate from those unlike denominators.
- The ledger merges proxy rows with the Antigravity conversation index. `source` scopes the union; omitting it is the only view that can mix both families. Proxy end-to-end `latency_ms` and Antigravity `generation_ms` are different measurements: when `source` is omitted **and** the scoped billable population contains both a proxy and a non-proxy row, the backend returns `performanceMixedSources = true` with `avgLatencyMs`, `avgFirstTokenMs` and `avgOutputTokensPerSecond` all `null`, and the UI renders `—` plus a hint to pick one source. Never average the two, and never treat the missing average as `0 ms`.
- Antigravity rows carry `source`, `thinkingTokens`, `responseTokens` and `generationMs`; proxy rows leave them `null`. `generationMs` is the streaming duration after the first token, so `outputTokensPerSecond` for those rows is `outputTokens * 1000 / generationMs`. v1 never counts Antigravity failures: `failedRequests` stays strictly proxy-verified, and an Antigravity scope reports `0` rather than borrowing proxy failures.
- Paginated response is `{ items, total, page, pageSize }`; `total` is the scoped count, not page length. Backend clamps page ≥1 and page size to 1–100 and rejects offset overflow; stricter malformed-URL rejection happens before IPC.
- Both Statistics reads publish together under URL identity + request revision. Scope changes clear old numbers; stale/failed responses never replace another scope or trigger an unfiltered retry.

### Console projection is not global hydration

- `useConsoleRequestProjection(requestId)` calls `console.readRequest(requestId, 500)` across retained owners, matching the exact request **before** applying the result limit. Backend default is 500, capped to 1–5000. It uses a shared directory lock; lock/I/O failures reject instead of becoming a miss.
- Response: `{ generation, records, truncated, retention? }`; retention carries `retentionStartDate`, `capacityEvicted`, `trimmed`, `corrupted`, `limited`. Preserve these facts; bounded history is never advertised as a complete archive.
- Merge request stages with `mergeConsoleEventList`, but keep the result in hook-local state. Never append/hydrate it into the process-long 500-row global buffer. Runtime-log view remains global and is labeled as such.
- Accept a response only for the current request identity/revision, `clearRevision`, and persisted generation. If a known current generation differs, reject it. [The store](../../../../src/renderer/api/consoleStore.ts) increments clear/history revisions and notifies at **both** clear start and finish; no precise read or projection display while clearing. This also applies when the backend clear partly fails.
- `clearConsoleHistory()` pauses the renderer persistence bridge, settles its in-flight write, clears owners, resets the in-memory history, then reports `{ ok, app, daemon }`. It does not delete statistics/audit rows. `generation` is persisted history identity; `clearRevision` is a renderer invalidation counter—do not conflate them.
- Retention is current **local** day plus the previous two days, not a rolling UTC 72 hours. The projection rechecks every 25 seconds and on focus/visibility. A known request date before the cutoff may say expired; an undated/in-window empty result only says missing/cleared/not recorded. Refresh/retry preserves pause/search state.

## 4. Validation & Error Matrix

| Input / condition | Required behavior |
|---|---|
| Unknown/duplicate URL key, malformed ID/date/enum/page | `invalid: true`; no Statistics or precise-request IPC; invalid Console URL must not show the global stream as a fallback |
| Unknown filter DTO field/enum over IPC | Rust `deny_unknown_fields` / enum deserialization rejects; no ignored scope field |
| Resource removed or Key/provider mismatch | SQL error; localized scope-unavailable UI; retry same scope or explicitly clear scope |
| Invalid range or offset overflow at DB boundary | Error; no fallback to `all` |
| Either Statistics read rejects | Clear both results; generic read/scope error and retry; no raw rejection in UI or console logs |
| Invalid precise request ID | Backend returns `Invalid request ID` without echoing input |
| Precise lock/I/O/metadata failure | Generic read error + retry, not empty/expired |
| Successful empty precise read | Missing unless a valid known local request date proves expiry |
| Stale request/clear/generation result | Discard; never refill global or precise history from the obsolete result |
| Truncated/trimmed history or partial clear | Show bounded-window/partial-result state; never report completeness/global success |

Observation errors must not expose raw URL values, paths or credentials. Existing generic error-display/logging examples elsewhere are not permission to echo these inputs.

## 5. Good / Base / Bad Cases

- **Good:** a provider+Key scoped custom-range ledger on page 3 opens one request outside the global 500 rows, finds its retained events, and returns to that same page/scope. Selecting failures changes only outcome/population/page, not the provider/Key/date.
- **Base:** `/stats` uses week/page 1/size 10 with all ledger outcomes; billable summary stays explicitly labeled. `/console` has no precise request call and displays the bounded global stream.
- **Bad:** a deleted instance, `providerId=`, duplicate scope, unknown `sessionToken`, impossible date, or mismatched Key/provider never silently becomes global data. A failed precise read never becomes an expiry assertion.

## 6. Tests Required (Assertions)

Use mocked renderer APIs, `TempDb`, temporary log directories and fake clocks; no real daemon/database/client credentials.

- [URL tests](../../../../src/renderer/utils/observationContext.test.ts): roundtrip scope/date/page; legacy dates; unknown/duplicate/malformed rejection; failure→all/page 1; whitelist/no raw input in serialization errors; local date and zh/en key/interpolation parity.
- [Statistics tests](../../../../src/renderer/pages/Statistics.observation.test.tsx): identical scoped summary/page arguments, refresh preservation, no calls for invalid URLs, safe deleted-scope retry, stale response rejection, drawer roundtrip and disabled missing-ID action.
- [Projection tests](../../../../src/renderer/hooks/useConsoleRequestProjection.test.tsx): target outside 500 global rows still found; global array untouched; absent ID causes no lookup; late identity/generation responses ignored; clear invalidates at both ends; retry/error vs empty; focus TTL pruning.
- [Console component tests](../../../../src/renderer/pages/Console.component.test.tsx): locator clear retains return scope, runtime logs explicitly global, missing vs known expired vs failure, invalid URL hides global fallback, retry preserves pause.
- [SQL tests](../../../../src-tauri/src/db/request_logs.rs): mixed scopes across multiple pages, matching totals/trends, cache-only usage, failure denominators, local/custom dates, deleted associations and malformed ranges without input disclosure. [DTO tests](../../../../src-tauri/src/models/request_log_filter.rs) reject unknown fields/enums.
- [Store tests](../../../../src-tauri/src/services/console_log_store.rs): exact match before limit, outside-global-buffer lookup, retention/corruption metadata, read failure vs miss, invalid IDs, new generation after clear. [Bridge tests](../../../../src/renderer/api/__tests__/index.contract.test.ts) pin command/argument shapes and optional-filter omission.

```bash
pnpm exec vitest run src/renderer/utils/observationContext.test.ts src/renderer/hooks/useConsoleRequestProjection.test.tsx src/renderer/pages/Statistics.observation.test.tsx src/renderer/pages/Console.component.test.tsx src/renderer/api/__tests__/index.contract.test.ts
cargo test --manifest-path src-tauri/Cargo.toml observation_
```

## 7. Wrong vs Correct

| Wrong | Correct |
|---|---|
| Filter the current unscoped 10 rows in React | Bind SQL scope before COUNT, aggregation, LIMIT and OFFSET |
| Catch an invalid/deleted scope and retry without filter | Keep the scope; expose a safe error and an explicit clear-scope action |
| Search `getConsoleEvents()` for the request and call absence “expired” | Read retained exact results; distinguish known expiry, miss and read failure |
| Merge a precise result into global hydration; validate only request ID | Keep a local projection; validate request revision, clear revision and generation |
| Store the full source URL or instance token for the return link | Serialize only the validated observation context and stable resource IDs |
