# Account Query Scripts (`services/query_script.rs`)

> The account query ("how much of this account is left") is user-authored
> JavaScript split into a request half the engine executes and an extractor
> half that reads the answer. This contract covers what the engine accepts,
> how several requests combine, and what a preset ships. Added 2026-11-06 with
> the Command Code multi-request work; every rule cites its enforcing file.

## Two script forms; they are exclusive

- **Single (legacy)**: `{ request: {...}, extractor(response) }` — one GET,
  one response object. The canonical example lives in
  `services/query_script.rs`'s module header. `resolve_request` keeps this
  path byte-for-byte, including the "no request at all" error.
- **Named (multi)**: `{ requests: { <name>: { url, method?, headers?,
  optional? } }, extractor(responses) }` — `responses.<name>` is the parsed
  body, or `null` when an `optional: true` request failed. Built by
  `resolve_requests` / `run_extractor_many`.
- **Both present is an error** (`request 与 requests 二选一`), never a merge:
  silent merging makes "which request actually ran" unreadable.

## Per-request rules (a set cannot weaken one request's checks)

- Every named request must independently pass `ensure_query_credentials`
  (unfilled placeholders stop the refresh with the same message the single
  form uses) and `is_permitted_target` (HTTPS + provider origin) *before any
  send* — `services/balance_service.rs::run_many`.
- Only GET is accepted; POST needs separate product evidence (presets must
  not ship what the product did not verify).

## Failure semantics (do not weaken into "weird cache state")

- **Required request fails** (HTTP non-2xx, non-JSON body, missing
  credential, bad target) → the whole refresh fails, nothing is written;
  `commands/balance.rs::balance_refresh` only overwrites the cache on success
  (`error` empty and `isValid != false`).
- **`optional: true` request fails** → its name arrives in the extractor as
  `null`; the script decides what is missing (template outputs a
  percent-null monthly row rather than dropping the row silently when other
  windows exist, and no rows at all when the provider reports no
  `windowLimits` — metered accounts get no invented windows).
- ** extractor strictness** unchanged: `AccountUsage` is
  `deny_unknown_fields`; extractor output that is neither balance nor windows
  still errors with "查询未返回余额或用量".

## No fabricated zeros

A script must never turn "the provider did not say" into `0`. Engine-level
guard: an extract that reports nothing errors. Template-level guard
(`shared_runtime/account_scripts.rs::COMMAND_CODE`): when all credit amounts
are absent the result is `isValid: false` ("credits 数值缺失"), while a real
`0` is reported as `0`.

## Presets carry the whole request, and their label is not behavior

- A preset that queries ships `wallet_balance_script` **and** the wallet URL /
  headers columns (`shared_runtime/provider_presets.rs`), so the settings
  dialog shows what will actually be sent.
- `preset_id` records origin only. Never branch runtime behavior on it
  (doc header of `provider_presets.rs`); capabilities are data (script text,
  columns), not preset names — the loading-placeholder UI keys off
  "query configured + no cache / in flight", not off preset ids.

## Verification

- `cargo test -p cc-use --lib query_script::` for engine/form behavior; the
  Command Code template must keep passing both credits-response shapes the
  public client reading allows (flat and nested `credits.credits`).
- Save-check remains offline: `provider_script_check` (Single: `{url, method,
  headers}`; Many: `{requests:{name:{url,method,headers,optional}}}`)
  evaluates the script without credentials or network.
- New frontend-visible branches (pending placeholders) belong to
  `ProviderCard` with a data-driven condition; see
  `src/renderer/components/providers/ProviderCard.tsx`.
