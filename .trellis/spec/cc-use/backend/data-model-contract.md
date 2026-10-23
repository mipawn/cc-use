# Data Model Contract (Rust ↔ TypeScript)

> `src-tauri/src/models/mod.rs` and `src/shared/types/index.ts` are two hand-written copies
> of the same IPC contract. Nothing generates one from the other, and nothing checks them
> at build time. This file states the rules that keep them aligned and what breaks when
> they drift.

---

## The Two Definitions

| Side | File | Notes |
|------|------|-------|
| Rust | `src-tauri/src/models/mod.rs` | IPC-facing structs derive `Serialize`/`Deserialize` and are annotated `#[serde(rename_all = "camelCase")]`; `GatewayRequestEvent` is internal (no serde) and never crosses IPC |
| TypeScript | `src/shared/types/index.ts` | Interfaces consumed by `src/renderer/`; camelCase field names |
| TypeScript API surface | `src/renderer/api/types.ts` | `Api` interface: command argument and return types |
| TypeScript wiring | `src/renderer/api/index.ts` | `buildApi()` — `invoke()` command names and argument keys |

Models that are embedded in other payloads come from `shared_runtime` and are re-used in
`models/mod.rs`: `crate::shared_runtime::DefaultKeyConfig` inside `Provider` /
`CreateProviderInput` / `UpdateProviderInput` / `ExportProvider`. Changing that struct
changes the IPC contract too.

`CONTRIBUTING.md` calls this out: `src/shared/types/index.ts` — “改类型时前后端都要改”.

## The camelCase Rule

`#[serde(rename_all = "camelCase")]` converts every field name on the wire:
`base_url` → `baseUrl`, `cached_wallet_balance` → `cachedWalletBalance`,
`is_streaming` → `isStreaming`. The TypeScript interface must use the converted name.

The classic mistake: Rust has `request_headers`, TypeScript declares `requestHeaders`, but
the Rust struct lacks the attribute (or the TS field is `request_headers`). Compilation
succeeds on both sides and the value is `undefined` in the UI. Every new struct in
`models/mod.rs` needs the attribute; every new field in `shared/types/index.ts` must be the
camelCase spelling of the Rust field.

## Null vs Absent

- `Option<T>` serializes as `null` unless `skip_serializing_if` is present. TypeScript
  mirrors this as `field: T | null`. Most models follow that shape (see `Provider` in
  `shared/types/index.ts`).
- Rare payloads use explicit omission: `CatalogSnapshot` in
  `services/model_catalog.rs` has `#[serde(skip_serializing_if = "Option::is_none")] error`,
  so `error` can be absent. In TypeScript it is declared optional/`null` accordingly.
- The distinction is semantic, not cosmetic: `None` means “this build/endpoint did not
  report it”, never “zero”. `UsageWindow.used_percent` is `Option<f64>` precisely so an
  unreported percentage is not rendered as 0 %; `RequestLog.last_token_ms` is `None` for
  historical rows instead of a guessed value.

When adding a field, choose `Option<T>` (serialized as `null`) unless the value is
guaranteed to exist for every old row and every caller.

## What Breaks When Only One Side Changes

| Change | Rust-only effect | TypeScript-only effect |
|--------|------------------|------------------------|
| Add field to `models/mod.rs` | TS interface lacks it, so typed renderer code cannot use it (the feature is silently missing); the value is on the wire, no build error anywhere. | — |
| Add field to `shared/types/index.ts` only | Serde **ignores unknown fields** (no `deny_unknown_fields` in models) → the renderer sends/saves a field that silently disappears. | `pnpm typecheck` passes. |
| Rename a field on one side | The old name arrives as `undefined`/is ignored in that direction; Tauri may also reject the argument if it is a command parameter (`invalid args`). | `typecheck` may still pass because each side is internally consistent. |
| Change a type (`i32` → `i64`, `T` → `Option<T>`) | Large `i64`/`u64` values become JS numbers and lose precision above 2^53 (`ClaudeSession` sizes); `null` vs `0` handling breaks at runtime. | Type checker cannot see the Rust type. |
| Add a required non-`Option` field to a `Create*Input` | Every existing caller and every test fixture must be updated — compile errors in `src-tauri/tests/support/mod.rs` are the good case; the renderer's old call shape fails deserialization at runtime. | `typecheck` flags local code, but not callers built earlier. |

The only place the compiler helps is Rust: integration-test fixtures in
`src-tauri/tests/support/mod.rs` construct `CreateProviderInput` / `CreateApiKeyInput` with
every field, so a new required field breaks them. `tests` are therefore a useful checklist —
do not silence that error with `..Default::default()` if the struct has no `Default`.

To keep old callers and old exported files working, new fields are usually declared
`Option<T>` with `#[serde(default)]` (many examples in `models/mod.rs`: `preset_id`,
`wallet_balance_script`, `request_headers`, `request_id`, `last_token_ms`). `ExportProvider`
and `ExportApiKey` add `#[serde(default)]` to almost every field so a file from any app
generation still parses.

## Stringly-Typed Contracts

Several “enums” are stored/transmitted as strings; treat the literals as a contract:

- Client kinds: `claude_code` | `grok` | `codex` | `claude_desktop`
  (`src/shared/types/index.ts::ClientKind`); legacy `claude` and `codex-app` are normalized
  in `shared_runtime/model_mapping.rs::client_key`, `db/projects.rs::normalize_project_cli_type`
  and `commands/managed_instances.rs::normalize_cli_type`. New code must normalize, not
  invent a fifth spelling.
- Session kinds: `managed` | `manual` | `desktop` (`ProxySession.session_kind`, backfilled
  in `db/mod.rs::run_alter_migrations`).
- Request outcomes: `success` | `client_error` | `upstream_error` | `transport_error`
  (`RequestOutcome` in `proxy/handler.rs`, documented on `RequestLog.outcome`).
- Instance status: `launching` | `running` | `stale` (+ stopped reasons) in
  `db/managed_instances.rs`.
- `settings` table keys are strings; the frontend uses camelCase keys (`proxyPort`,
  `closeToTray`, `daemonEnabled`, `launchAtLogin`, `showWindowShortcut`) while internal
  keys are dotted (`lastDaemonVersion`, `codex_last_api_key_id`,
  `migration.go-model-defaults-removed`, `model-catalog-cache.*`). New typed settings also
  need a field in `GlobalSettings` + an arm in `db/settings.rs::settings_get`; arbitrary keys
  still round-trip through `get_setting`/`set_setting`.

`ConsoleEvent` is the one payload defined in Rust with its own TypeScript union mirror:
`#[serde(tag = "category", rename_all = "snake_case")]` in `proxy/console.rs` and
`ConsoleRequestEvent | ConsoleLogEvent` in `src/shared/types/index.ts`. When adding a field
to a variant, update both, and use `#[serde(default)]` so replayed on-disk records written
by older builds still parse (`ConsoleEvent::Log.id` does exactly this).

## Strictness: Where Unknown Fields Are Rejected

`models/mod.rs` does not use `deny_unknown_fields` — unknown input fields are ignored. The
query-script protocol does the opposite: `services/query_script.rs` applies
`#[serde(rename_all = "camelCase", deny_unknown_fields)]` to the extractor’s expected output
shape, so a script returning a misspelled key fails loudly instead of producing an empty
balance. Choose strictness at the boundary:

- IPC DTOs: lenient (ignore unknown) for forward compatibility.
- Data authored by users/scripts that must produce a known result: strict
  (`deny_unknown_fields`) with a clear error.

## Verification

- Add a field: `rg "<newField>" src-tauri/src src/shared/types/index.ts src/renderer/api`
  should show the Rust struct, the TS interface, and any API signature.
- `pnpm typecheck` only proves the TS side is internally consistent — it cannot prove the
  Rust side matches.
- Round-trip test for persisted/exported types: `src-tauri/tests/import_export_security.rs`
  and `db_providers.rs` / `db_api_keys.rs` exercise serialized shapes.
- For a new IPC payload, the fastest proof is an integration test that builds the Rust value
  and serializes it with `serde_json`, then asserts the camelCase keys the UI reads.

## Anti-Patterns

- Changing `models/mod.rs` without updating `src/shared/types/index.ts` (or vice versa) and
  calling it done because both sides compile.
- Adding a field to the Rust struct but not to `db/<table>.rs` SELECT/mapper/INSERT — it
  always reads back as the default.
- Adding a field to TypeScript and expecting Rust to persist it; serde silently drops it.
- Introducing a new client-kind/outcome/status spelling instead of normalizing the legacy
  one in the shared helper.
- Passing a whole `serde_json::Value` through IPC when a struct exists (or is warranted);
  each consumer then re-implements the field casts.
- Making a new field required when the renderer and old export files cannot supply it.
