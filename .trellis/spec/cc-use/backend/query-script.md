# Account Query Scripts (`services/query_script.rs`)

> The account query ("how much of this account is left") is user-authored
> JavaScript split into a request half the engine executes and an extractor
> half that reads the answer. This contract covers what the engine accepts,
> how several requests combine, what a preset ships, the two scopes
> (account vs per-key), the persisted scheme switch and the draft test.
> Added 2026-11-06 with the Command Code multi-request work; extended
> 2026-11-09 with the unified query UX. Every rule cites its enforcing file.

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

## Shipped templates are copied into the database

- What a preset ships is *stored* as the provider's (and possibly a key's)
  script text when it is saved or created. Fixing a shipped template therefore
  does not fix existing rows: a one-time, marker-gated upgrade must rewrite the
  rows that still hold the previous text verbatim, and must leave an edited
  script alone (it is a saved choice). Precedent:
  `db/command_code_script_upgrade.rs` (marker
  `migration.command-code.window-limits-fixed`), same shape as
  `db/go_preset_cleanup.rs` / `db/model_config_cleanup.rs`.
- The superseded text is frozen in the upgrade module, not derived from the
  current template, so later template edits cannot change what "untouched
  shipped copy" means.

## Verification

- `cargo test -p cc-use --lib query_script::` for engine/form behavior; the
  Command Code template must keep passing every credits-response shape the
  public client reading allows:
  - live: amounts under `credits`, `windowLimits` beside it on the response
    body (client's `usageData.credits.windowLimits`, where `usageData.credits`
    is that body);
  - legacy inner placements: `credits.windowLimits` and
    `credits.credits.windowLimits`, kept as fallbacks.
  This nesting was the v3.17.0 defect: the template only looked inside
  `credits`, so a real refresh answered balance + zero windows and the monthly
  row (gated on limits) never appeared.
- `cargo test -p cc-use --lib command_code_script_upgrade` for the one-time
  upgrade; it must move untouched copies and leave edited scripts.
- `cargo test -p cc-use --lib query_schemes query_test` for the catalogue,
  the draft-test scope guards and the no-fabricated-zero reporting.
- `cargo test -p cc-use --test db_query_invalidation` for save-time cache
  invalidation (address/proxy/credential/script/switch, borrowed credential
  moves, unrelated saves keeping caches).
- Save-check remains offline: `provider_script_check` (Single: `{url, method,
  headers}`; Many: `{requests:{name:{url,method,headers,optional}}}`)
  evaluates the script without credentials or network.
- New frontend-visible branches (pending placeholders) belong to
  `ProviderCard` with a data-driven condition; see
  `src/renderer/components/providers/ProviderCard.tsx`.

---

## Two scopes: account and per-key — separated by evidence, not labels
(Authoritative module: `shared_runtime/query_schemes.rs`, `services/usage_service.rs`)

- The catalogue ships two disjoint scheme sets: `account` (DeepSeek, New API,
  OpenCode Go, Command Code) and `key` (only New API's `/api/usage/token/`
  per-key route). No account entry doubles as a key scheme; `supports_windows`
  is account-only capability metadata.
- A key query resolves `{{apiKey}}` with the key's own value; provider
  `token` / `walletBalanceUserId` do NOT enter the key-scope variable set.
  Placeholders naming account credentials in a key script are refused with
  key-scope wording *before any send* (`ensure_key_query_credentials`).
- The scope boundary is TARGET evidence: `account_target_urls(base_url)` turns
  every shipped account endpoint into the concrete URL it reads for this
  provider; a key script whose resolved request lands on one is refused with
  "该脚本查询的是账户级额度…" (`KEY_QUERY_ACCOUNT_TARGET_MESSAGE`) — the draft
  test runs the exact same refusal before sending (`usage_service::
  guard_key_scope_targets`, `query_test.rs` shares the guards).
- Key results strip windows/groups (`strip_to_key_usage`); a window-only
  answer fails the refresh with a repair message instead of decorating an
  account reading as the key's quota. A real `0` is a real `0`: absent data is
  an error, never 0, never success.

## Persisted scheme switch (`query_config`)

- `providers.query_config` / `api_keys.query_config` hold a serialised
  `QueryConfig {enabled, scheme_id}` (JSON, camelCase on IPC). NULL means a
  row saved before the field existed: the pre-config rule is "non-empty
  script = enabled" (`effective_query_config`, mirrored in
  `src/renderer/utils/accountQuery.ts::effectiveQuery`).
- The switch lives beside the script and BOTH survive saves: `enabled=false`
  keeps the script (and scheme) verbatim — disabled-but-remembered — and a
  refresh answers the stale "已关闭" envelope instead of running the text.
- `scheme_id` records selection or `custom`; a scheme id the current build
  cannot resolve is reported as unrecognised UI state. Recognition is
  whole-text equality only (`recognise_account_scheme` /
  `recognise_key_scheme`): any edit, even a comment, keeps the original text
  and reads as custom. Nothing rewrites stored scripts.
- Input semantics are replace-on-present: `Some(query_config)` replaces the
  whole switch+scheme; absent keeps stored. Create derives the column from
  `query_config ?? script presence` so an older creator stays on the same
  semantics. The same column round-trips ExportProvider / ExportApiKey,
  preserving disabled-but-remembered state across export/import.

## Draft query test (`commands/balance.rs::query_test`,
`services/query_test.rs`)

- Same engine as the saved refresh (`resolve` → per-request credential +
  origin guards → `execute`), URL/scheme-wise. The differences are input
  (draft values) and zero persistence: no entity, no cache write, no check
  time; the account scope may borrow the provider's lowest-priority key —
  resolved under ONE short DB lock before any `await`.
- The key scope is its key only: it never reads `providerId` to borrow
  anything from storage, never borrows account credentials, and drops all
  account-shaped fields from the report.
- Result is a domain value: failures land in `error` with legacy-shaped
  credentials replaced by `***` (`redact`); usage is `None` whenever an error
  is present, so a failed test cannot be rendered as a success. Unknown scope
  rejects.

## Cache validity and races

- Invalidation is owned by the DB layer in one transaction with the save
  (`db/providers.rs::provider_update`, `db/api_keys.rs`): provider
  address/proxy/token/userId/script/switch change clears the account caches
  (and, for address/proxy, all of that provider's keys' caches); key
  value/script/switch change clears that key's cache; a save moving the
  account borrow (lowest-priority enabled, active key newly created, deleted,
  rewritten, reordered, exhausted) clears the provider account cache. Clearing
  writes SQL NULL — never `Some(None)`-via-partial-update.
- The borrow comparison reads the OLD table before the update and the NEW one
  after; both probes post-update would compare the update with itself and
  never fire.
- Refresh commands (`balance_refresh`, `key_usage_refresh`) snapshot the
  effective config + credentials before the request and re-read them before
  the write-back: a save between `await`s leaves its newer configuration
  cache-free rather than resurrecting the old answer. Disabled stays
  disabled: the "已关闭" envelope is produced by the config gate, not by
  blanking the script.
