# Desktop Connection Control Contract

## 1. Scope / Trigger

Read this contract when changing Desktop takeover, route switching, restoration, key-edit
profile synchronization, persisted reopen guidance, or the tray's current-route checkmark.
The GUI configures and observes; it does not launch a Desktop workload. A saved file, a
running process, or a request arriving at the proxy is **not** evidence that Desktop has
reloaded configuration. Never add a `reloaded` claim or clear reopen guidance using those
signals.

Authoritative implementation and mirrors:

- [Desktop command/coordinator](../../../../src-tauri/src/commands/desktop_connection.rs):
  DTOs, settings history, actual-state reads, session/file coordination, Tauri wrappers.
- [Codex manager](../../../../src-tauri/src/commands/codex_config.rs) and
  [Claude Desktop manager](../../../../src-tauri/src/commands/claude_desktop_config.rs):
  owned file formats, complete comparison, apply/restore, Claude profile synchronization.
- [Key-save command](../../../../src-tauri/src/commands/api_keys.rs): save and profile sync
  have distinct outcomes.
- [Shared TypeScript DTOs](../../../../src/shared/types/index.ts),
  [API interface](../../../../src/renderer/api/types.ts), and
  [API wiring](../../../../src/renderer/api/index.ts): hand-maintained IPC mirrors.
- [Tray](../../../../src-tauri/src/tray.rs): uses the same actual-state reader as the GUI.

This is a control-plane contract. It does not change daemon routing protocols, CLI launch
behavior, or the SQLite schema. Client configurations may contain generated `session-*`
tokens, never upstream provider/API-key credentials.

## 2. Signatures (Command / API / DB)

These are the registered Rust command signatures; `db` and `app` are injected by Tauri,
not supplied by JavaScript:

```rust
pub fn desktop_connection_state(
    client_kind: DesktopClientKind,
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<DesktopConnectionState, String>;

pub async fn desktop_connection_apply(
    client_kind: DesktopClientKind,
    provider_id: String,
    api_key_id: String,
    db: State<'_, Arc<Mutex<Database>>>,
    app: tauri::AppHandle,
) -> Result<DesktopOperationResult, String>;

pub fn desktop_connection_restore(
    client_kind: DesktopClientKind,
    db: State<'_, Arc<Mutex<Database>>>,
    app: tauri::AppHandle,
) -> Result<DesktopOperationResult, String>;

// Shared GUI/tray read path; never reads historical last-key selection as current.
pub(crate) fn desktop_connection_state_inner(
    db: &Database,
    client_kind: DesktopClientKind,
) -> Result<DesktopConnectionState, String>;
```

Renderer wire calls:

```ts
invoke('desktop_connection_state', { clientKind })
invoke('desktop_connection_apply', { clientKind, providerId, apiKeyId })
invoke('desktop_connection_restore', { clientKind })
```

`AppHandle` needs no new managed-state registration. Both typed mutation wrappers call
`tray::refresh_tray_menu(&app)` **after** the inner operation releases its database guard,
including error/partial returns. Do not hold the DB mutex while rebuilding the tray.
The old tray handlers also rebuild after their operations.

Compatibility entry points remain available:

- `codex_config_takeover_inner` (async), `claude_desktop_config_takeover_inner`, and both
  `*_restore_inner` functions retain `Result<String, String>` for older callers. They
  delegate to the typed operation and `legacy_message`; callers must not parse the text.
  A typed partial result becomes an error for this legacy interface.
- `refresh_taken_over_profile(&Database) -> Result<bool, String>` uses source `startup`.
- `refresh_taken_over_profile_after_key_edit(&Database) -> Result<bool, String>` uses
  source `key_edit`. `bool` means configuration bytes changed, not client reload.
- `api_key_update` still returns `Result<ApiKey, String>`. A successful key save is not
  converted to a failed save just because the subsequent Desktop sync fails.

Persistence uses existing `settings_get_value`, `settings_set_value`,
`settings_delete_value`, and `proxy_session_*` APIs. `Database::conn.unchecked_transaction()`
coordinates session bindings, token settings, Claude aliases, and operation history with
file writes; no new table or migration is required.

## 3. Contracts (Request / Response / Persistence)

Rust DTOs live in the Desktop command module, not in the general model module. Struct
fields use `#[serde(rename_all = "camelCase")]`; enum values use `snake_case`. All nullable
fields below are present as JSON `null`, not omitted.

```ts
type DesktopClientKind = 'codex' | 'claude_desktop'
type DesktopChangeSource = 'user' | 'key_edit' | 'startup'

interface DesktopConnectionState {
  clientKind: DesktopClientKind
  status: 'official' | 'taken_over' | 'not_found' | 'error' | 'unknown'
  route: { providerId: string; apiKeyId: string } | null
  lastConfigChange: {
    action: 'takeover' | 'restore' | 'sync'
    source: DesktopChangeSource
    changedAt: string
    version: number
  } | null
  syncFailure: {
    source: DesktopChangeSource
    occurredAt: string
    message: string
  } | null
  warning: string | null
}

interface DesktopOperationResult {
  clientKind: DesktopClientKind
  action: 'takeover' | 'switch_route' | 'restore'
  completion: 'complete' | 'partial'
  routeChanged: boolean
  configChanged: boolean
  modelCount: number | null
  nextAction: 'reopen_client' | 'none'
  updatedAt: string
  warning: string | null
  state: DesktopConnectionState
}
```

**Configuration facts, not availability or reload:** `route` is resolved from the token
actually installed in the client's selected configuration, then its persisted session.
The session must be active, unrevoked, `session_kind = "desktop"`, and have the matching
`cli_type`; its provider and key must exist and agree on ownership. This does not assert
that the provider is reachable, the key has quota, or the external client has reloaded.
The state reader does not replace a missing route with a renderer cache or token setting.

| Client kind | Desktop session `cli_type` | Token setting | History setting |
|---|---|---|---|
| `codex` | `codex-app` | `codex_session_token` | `desktop.connection.codex.v1` |
| `claude_desktop` | `claude_desktop` | `claudeDesktopGatewayToken` | `desktop.connection.claude_desktop.v1` |

Each history value is JSON `{lastConfigChange, syncFailure}`. No token or credential is
stored in this history/DTO. Missing history means both fields are null; malformed history
is an error, not silently a new successful record. No new environment variable is part of
this contract; production paths come from the existing managers, while tests inject paths.

**Version and guidance rules:**

1. Compare owned-file byte snapshots before/after the operation. Only changed bytes create
   a new `lastConfigChange`: version starts at 1 and uses the existing saturating `u64`
   increment; `changedAt` is UTC RFC 3339.
2. User apply with changed files records `takeover`; restore records `restore`; non-user
   profile writes record `sync` with `startup` or `key_edit`.
3. A route-only apply returns `switch_route`, `configChanged: false`, and
   `nextAction: 'none'`, while preserving the previous `lastConfigChange` exactly.
   `routeChanged` compares the old/read-back route, so reapplying the same route can be
   false. Reopening the GUI or tray does not clear the persistent notice.
4. A successful no-op startup/key-edit sync does not advance version/time. A successful
   coordinated operation clears `syncFailure`; an official/not-found startup sync skips
   without changing history. A failed sync records its own time/source without inventing
   a successful config-change timestamp.
5. `updatedAt` is the operation-result time, **not** reload acknowledgement and not a
   replacement for `lastConfigChange.changedAt`. `modelCount` describes the configured
   menu/catalog when supplied; restore returns null.
6. Successful file changes request `reopen_client`. Partial operations carry repair/retry
   warnings; their `nextAction` alone is not a claim that the configuration is usable.

**Actual-token and same-client protections:** explicit apply tries the installed token
first, then the token setting. A reusable candidate must have the `session-` prefix and
have either no session row or a row owned by the same Desktop client. Otherwise generate a
new token; never overwrite a CLI/other-client session. Restore gathers the installed and
settings tokens, deduplicates them, and revokes only rows with `session_kind = "desktop"`
and the matching `cli_type`, all within the same transaction. It clears this client's token
setting, not another client's session.

**Idempotence requires the complete owned configuration:**

- Codex must select top-level `model_provider = "cc-use"`; a leftover provider table is
  insufficient. Also compare `wire_api = "responses"`, provider name, token, loopback URL,
  `requires_openai_auth`, `disable_response_storage`, selected model/reasoning effort,
  managed catalog path, and catalog bytes. Switching top-level provider to `openai` or
  changing `wire_api` must force a real rewrite on the next apply.
- Claude must compare the owned gateway profile, both deployment-mode files, removal of
  the legacy hardware-acceleration override, and the selected/meta profile entry. Matching
  only profile models is insufficient to claim no config change.

Tray checkmarks are projections of the shared state: only `taken_over` with a verified
route can mark a key. `*_last_api_key_id` settings may remain as historical data but are
neither read nor written by the current tray selection path. Rebuild from actual state
following UI mutations and when opening the tray; do not optimistically mark the requested
key before read-back.

## 4. Validation & Error Matrix

| Condition | Required result / side-effect boundary |
|---|---|
| Client kind outside the two literal values | Serde rejects the request; do not normalize arbitrary clients into a Desktop client. |
| Missing provider/key, ownership mismatch, disabled provider/key, exhausted key, unsupported key client type | Reject before session/config mutation with a safe actionable error. |
| Codex catalog fetch/selection fails | Reject without creating a new session binding; do not hold the DB guard across await. Revalidate route/config inputs after reacquiring the guard. |
| No relevant client configuration files | State `not_found`, route null; never fabricate a selected route from history. |
| Readable official configuration | State `official`, route null. |
| Malformed/unreadable JSON/TOML | Read command returns state `error` with a sanitized warning; operation preflight rejects. Never treat it as official. |
| Malformed/unreadable history | State read reports `error`; coordinated mutation cannot save its success record and must roll back rather than reset history. |
| DB mutex unavailable or manager cannot locate its configuration directory | Command returns a sanitized `Err`; this is distinct from a successful read returning an `error` state. |
| Takeover marker exists but session/route cannot be verified; Claude deployment/profile selection is incomplete | State `unknown`, route null with repair guidance; no tray checkmark. |
| File/DB/metadata write fails and both rollback paths succeed | Return `Err` explaining restoration/retry; old route and owned bytes are restored. Attempt to persist `syncFailure`; preserve the successful notice. |
| Rollback is incomplete | Return `Ok` with `completion: 'partial'` and current read-back state, not a fabricated complete result or the pre-operation route. |
| Read-back fails after a write or partial rollback | Return partial with state `unknown`, route null, and warning. If DB rollback cannot be verified, force unknown even if file inspection succeeds. |
| Partial failure prevents byte re-read | `configChanged` conservatively stays true; the warning/unknown state must not be hidden by this boolean. |
| Saving a failure notice also fails | Include that fact in the returned safe error/warning; do not claim persistence succeeded. |
| Key saved, Claude profile sync fails | Return the saved key; persist `syncFailure.source = 'key_edit'` independently. Keep the last successful config notice unchanged. |

`execute_change` snapshots every owned mutable file before mutation: Codex config/catalog/
catalog-state files (not the untouched auth file); Claude normal config, 3p config, gateway
profile, and meta. On failure it attempts restoration of **all** snapshots, not just until
the first error. Session/token/alias/history writes roll back in the SQLite transaction.
Backup artifacts may remain. This is synchronous failure coordination, not a promised
cross-filesystem/SQLite power-loss transaction; the tests below do not certify crash recovery.

Never expose raw parser, SQL, provider, or file-content errors through Desktop warnings or
history: they can contain secrets. Errors must identify the failed stage and a recovery
step without interpolating credentials or session tokens. Preflight/validation rejection
does not fabricate a successful timestamp; do not assume every preflight failure creates
a durable failure record.

## 5. Good / Base / Bad Cases

| Class | Scenario | Expected facts |
|---|---|---|
| Base | Take over an unconfigured client with a compatible key | Complete takeover, actual route, changed files, version 1, reopen guidance. |
| Good | Switch A to B with identical Codex catalog/Claude profile inputs | Complete route switch; no file changes; previous config notice survives unchanged. |
| Good | Reopen GUI/tray after switching to B while a historical last-key setting still contains A | Actual-state read returns B; tray marks B, not A. |
| Good | Restore while settings points to another client's session | Actual owned Desktop session is revoked; foreign session is unchanged; official state has no tray checkmark. |
| Good | Startup sync sees identical files | No config change and no notice-version/time bump. |
| Bad input handled | User changes only Codex top-level provider to official, leaving the cc-use table/catalog | Next apply rewrites configuration and returns takeover, not a false route-only success. |
| Bad I/O handled | Catalog writes, then Codex atomic config write fails | Roll back catalog/config/session together; never leave new route presented as complete. |
| Bad partial handled | A snapshot path becomes a directory during a failing operation | Rollback failure is partial; failed read-back is unknown, not the old route. |
| Bad sync handled | Key alias save succeeds but Claude meta is unreadable | Saved key remains saved; key-edit sync failure is separately visible after reopening state. |

## 6. Tests Required (Assertions and Recorded Evidence)

Use `TempDir`, manager `for_test` constructors, and `Database::new_in_memory()`; never
redirect global home directories or touch real client files, daemon state, or Keychain.
Codex coordinator tests provide a synthetic catalog directly, and the no-probe Claude
fixture uses a non-listening local provider URL without contacting it.

The [Desktop regression suite](../../../../src-tauri/src/commands/desktop_connection_tests.rs)
contains these exact tests and assertions:

| Test function | Assertion points |
|---|---|
| `desktop_contract_uses_frozen_names_and_never_serializes_token` | Enum literals, camelCase fields, explicit nulls, credential/token absence, invalid client rejection. |
| `codex_write_switch_reopen_and_restore_keep_real_configuration_notice` | Route-only preserves notice; GUI-style reread preserves it; restore notice persists; actual token revoked while a foreign client's token is protected. |
| `claude_compares_profile_deployment_and_meta_and_sync_is_idempotent` | Both deployment/meta drift trigger sync; startup no-op preserves version/time; source/action are correct. |
| `file_failure_rolls_back_session_and_files_and_does_not_claim_success` | Original route/bytes/notice restored; separate failure record exists. |
| `rollback_failure_returns_partial_and_reads_actual_state_not_the_old_route` | Partial result, unknown read-back, no fabricated route, DB binding restored. |
| `successful_write_with_failed_readback_is_partial_unknown` | Successful bytes/history do not imply complete read-back; later read resolves actual route. |
| `metadata_write_failure_rolls_back_and_redacts_database_errors` | Notice failure rolls route/files back; synthetic private SQL error is absent from output. |
| `malformed_configuration_is_error_not_official_and_does_not_leak_contents` | JSON/TOML failures are error, not official; file content is absent from the DTO. |
| `wrong_client_disabled_and_exhausted_routes_fail_before_mutation` | Incompatible, disabled, exhausted keys reject before files/token settings change. |
| `saved_key_survives_profile_sync_failure_with_persistent_key_edit_notice` | Saved key returned/persisted despite sync failure; original successful notice retained. |
| `restore_failure_rolls_back_files_and_keeps_the_live_route` | Failed restore retains owned bytes, route, notice, and unrevoked session. |
| `state_follows_token_in_configuration_not_the_last_selected_setting` | Actual token wins over stale setting; reapply does not rewrite identical config; missing session becomes unknown. |
| `codex_real_atomic_write_failure_restores_catalog_and_session_together` | Real temporary-write-path failure restores all owned bytes and session route. |
| `codex_reapplies_drifted_provider_protocol_and_other_owned_fields` | Provider/protocol/name/response-storage drift forces takeover + new config notice; subsequent apply is idempotent. |

The [tray tests](../../../../src-tauri/src/tray.rs) include
`desktop_menu_uses_actual_route_after_ui_switch_restore_and_restart`: for **both** clients,
assert historical A does not override current B, restore removes the checkmark, and
not-found/unknown/error/read-failure states never mark history as current.

Recorded implementation evidence from 2026-11-15 (separate targeted runs, all exit 0):

| Command | Result / latest relevant run |
|---|---|
| `cargo test -p cc-use --lib commands::desktop_connection` | 14 passed after the tray/shared-state change. |
| `cargo test -p cc-use --lib commands::codex_config` | 19 passed after the complete owned-field comparison fix. |
| `cargo test -p cc-use --lib commands::claude_desktop_config` | 8 passed after the coordinator/token-protection implementation. |
| `cargo test -p cc-use --lib tray::tests` | 8 passed after the shared-state/checkmark change. |

Scoped formatting and `git diff --check` also passed for the implementation changes.
These are backend fixture/compile results, **not** native tray visual-refresh, live daemon,
or external Desktop reload verification. This documentation-only follow-up did not rerun
Cargo; future implementation changes must rerun the affected suites.

## 7. Wrong vs Correct

| Wrong | Correct |
|---|---|
| Treat `codex_last_api_key_id` / `claude_desktop_last_api_key_id` as current. | Read the installed token and session through shared `DesktopConnectionState`; tray only projects verified `taken_over` routes. |
| Compare only token/catalog and ignore selected provider or protocol. | Compare the complete owned config, including top-level provider and `wire_api`, before reporting `configChanged: false`. |
| Write token/session settings first, then leave them committed if a file write fails. | Coordinate DB transaction + owned-file snapshots; roll back or return truthful partial/read-back state. |
| Restore only the token from settings, or revoke every token without checking ownership. | Deduplicate installed/settings tokens and revoke only same-client desktop sessions in the transaction. |
| Replace reopen guidance with “client reloaded” after observing a process/request. | Persist the last config-change notice; external reload remains unconfirmed. |
| Mark key save failed because profile sync failed. | Return the saved key and expose the independently persisted key-edit sync failure. |
| Emit a success string and optimistically mark the tray's requested key. | Return structured completion/state and rebuild the tray after DB guards are released, including partial/error outcomes. |
