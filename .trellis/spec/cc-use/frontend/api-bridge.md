# API Bridge

> How the renderer talks to Rust, and the four edits every Tauri command change requires.

---

## The Contract

All frontend→backend application calls go through `getApi()`. Direct native imports in current production renderer code are limited to the bridge, native file dialogs in [Settings](../../../../src/renderer/pages/Settings.tsx), and the migration event listener in [App](../../../../src/renderer/App.tsx). The deleted Codex/Claude Desktop takeover pages are **not** active exceptions: [DesktopPage](../../../../src/renderer/pages/DesktopPage.tsx) uses the typed `desktopConnection` namespace, never hand-written `invoke()` or settings-key choreography.

| Piece | File | Symbol |
|---|---|---|
| Interface | `src/renderer/api/types.ts` | `export interface Api` — one namespace per backend domain |
| Implementation | `src/renderer/api/index.ts` | `function buildApi(): Api`, cached by `export function getApi(): Api` |
| Transport | `src/renderer/api/index.ts` | `invoke<T>(cmd, args)` — lazy `await import('@tauri-apps/api/core')` |
| Events | `src/renderer/api/index.ts` | `listen<T>(event, handler)` — lazy `await import('@tauri-apps/api/event')` |
| Shared payload types | `src/shared/types/index.ts` | models mirrored by `src-tauri/src/models/mod.rs` |

`buildApi()` is intentionally not exported. Callers use `getApi()` at the point of use, never at module top level, so the Tauri imports stay lazy and tests can mock the module (`vi.mock('../api', () => ({ getApi: () => mock }))`).

```ts
// src/renderer/api/index.ts — provider namespace
provider: {
  list: () => invoke('provider_list'),
  get: (id) => invoke('provider_get', { id }),
  create: (input) => invoke('provider_create', { input }),
},
```

`Api` namespaces currently cover: `provider`, `userAgent`, `apiKey`, `project`, `terminal`, `proxy`, `console`, `balance`, `keyUsage`, `importExport`, `session`, `gateway`, `settings`, `desktopConnection`, `configTakeover`, `icon`, `usageLog`, `requestLog`, `cliTool`, `app`, `system`, `systemExt`, `sessions`, `managedInstances`, `codexApp`. Retained project/terminal/session compatibility APIs do not authorize adding GUI project launching; the live route owners are listed in [Directory Structure](./directory-structure.md).

---

## Command and Argument Rules

1. **Command names are `<domain>_<verb>` snake_case strings** that must match the Rust `#[tauri::command]` function name exactly — `provider_get`, `terminal_launch`, `console_log_read_recent`, `managed_instance_update_assignment`.
2. **The argument object is camelCase; Rust parameters are snake_case.** Tauri v2 converts them by default. Examples across the bridge:
   - `provider_model_catalog` (`src-tauri/src/commands/providers.rs:118`) takes `provider_id, api_key_id, client_kind`; the frontend sends `{ providerId, apiKeyId, clientKind }` (`api/index.ts:38`).
   - `terminal_get_launch_preview` takes `project_id, provider_id, api_key_id, cli_type`; the frontend forwards its camelCase `params` object unchanged (`api/index.ts:70`).
   - `provider_reorder` takes `provider_ids`; frontend sends `{ providerIds }` (`api/index.ts:29`).
3. **Preserve the adapter's omission contract; do not invent empty values or globally normalize legacy payloads.** `provider.modelList` includes `clientKind` only when present; scoped statistics include `filter` only when supplied. `gateway.update` omits absent `modelPolicy`/`connectionConfig` to retain stored values. Other existing keys, such as optional pagination fields, are forwarded as written. No-argument `proxy_restart` passes no argument object, which the contract test observes as `undefined`.
4. **Only JSON-serializable data crosses the boundary.** `icon.upload` converts an `ArrayBuffer` to a plain number array before invoking because the Rust side takes `Vec<u8>` (`api/index.ts:147-150`; contract test `converts ArrayBuffer payloads for icon upload`).
5. **Errors are strings.** Rust returns `Result<T, String>`; a rejected Tauri promise carries that string. UI code either shows `result.error` / `result.invalidMessage` from a domain result (e.g. `pages/Keys.tsx` balance refresh) or wraps the thrown value (`message.error(String(error))`).
6. **Event names are a second contract.** The bridge subscribes to:
   - `proxy:statusChanged` — payload `{ isRunning, port, lastError?, source? }`, emitted from `src-tauri/src/lib.rs:410`, `src-tauri/src/commands/proxy.rs:185`, `src-tauri/src/tray.rs:554`.
   - `proxy:consoleEvent` — typed by `ConsoleEvent` in `src/shared/types/index.ts`; emitted via `CONSOLE_EVENT_NAME` in `src-tauri/src/services/console_bridge.rs:21` and `app_logger.rs:19`.
   - `app:migrationAvailable` — listened to directly in `App.tsx:109` (not wrapped by `Api`).
   The bridge unwraps `event.payload` before calling the caller's callback (`api/index.ts:15-18`).
7. **Subscriptions return an unsubscribe function; call it on unmount.** `onStatusChanged` / `onEvent` close over an async `listen()` registration (`api/index.ts:80-108`), used by `hooks/useServiceStatus.ts` and `api/consoleStore.ts`. Note the registration resolves asynchronously: disposing synchronously right after subscribing can run before `unlisten` is assigned.

---

## The Four Coordinated Edits (Frontend Side)

`CONTRIBUTING.md` defines the full loop; the frontend half is:

1. Add the signature to `Api` in `src/renderer/api/types.ts` (use a domain namespace; reuse `@shared/types` types when the payload is shared).
2. Implement it in `buildApi()` in `src/renderer/api/index.ts` with the exact command string and camelCase args.
3. Add/extend a case in `src/renderer/api/__tests__/index.contract.test.ts` so the command name and argument shape are pinned.
4. Call it from the store/page through `getApi()`.

Backend half (for pairing, owned by [Backend Guidelines](../backend/index.md)): declare `#[tauri::command]` in `src-tauri/src/commands/<domain>.rs`, register it in the `tauri::generate_handler![...]` list in `src-tauri/src/lib.rs`, and add a capability permission only when it needs a plugin/system permission (`src-tauri/capabilities/default.json`).

Command registration is mandatory: an invoke of an unregistered command fails at runtime. Registration does not prove a renderer call exists: `system_open_external` remains registered while the renderer uses the opener plugin. Older settings/config commands are not a license to bypass the typed Desktop operations; no live Desktop page composes takeover by manually writing `get_setting` / `set_setting` / `delete_setting`.

---

## The Contract Test

`src/renderer/api/__tests__/index.contract.test.ts` mocks `@tauri-apps/api/core` and `@tauri-apps/api/event`, then asserts:

- `getApi()` returns a cached singleton;
- representative methods map to the right command string and argument object (`provider_get`, `provider_create`, `provider_model_list`, `terminal_get_launch_preview`, `proxy_restart`, `settings_get`);
- `icon.upload` converts `Uint8Array.buffer` → `number[]`;
- `session.create` forwards `cliType`;
- managed-instance commands forward the right input object;
- `proxy.onStatusChanged` registers on `proxy:statusChanged`, receives the unwrapped payload, and its dispose calls the unlisten function.

Use `vi.resetModules()` + dynamic `import('../index')` for each test because `_api` is module-level state. When you add an `Api` method that carries non-trivial arguments, add a case here rather than relying on the type checker (types cannot prove the command string exists in Rust).

---

## Known Drift (verify before trusting)

These are current facts in the tree, not endorsements. Fix them when touching the area; do not copy them.

| Drift | Evidence |
|---|---|
| `Api.codexApp` still maps to unregistered `codex_app_launch`, `codex_app_stop`, `codex_app_get_active_project`; these are not working GUI launch APIs | [API types](../../../../src/renderer/api/types.ts), [adapter](../../../../src/renderer/api/index.ts), [registered commands](../../../../src-tauri/src/lib.rs); do not copy them into new screens |
| Settings native save/open dialogs remain a plugin exception; App's migration event import is skipped in fixture mode | [Settings](../../../../src/renderer/pages/Settings.tsx), [App](../../../../src/renderer/App.tsx); deleted config-takeover pages contribute no current exception |
| `system.openExternal` uses `@tauri-apps/plugin-opener`, while the registered `system_open_external` command is unused by the renderer | `api/index.ts:221-224`; `src-tauri/src/lib.rs` registration list |
| `app.checkUpdate` / `downloadAndInstall` / `relaunch` use `plugin-updater` and `plugin-process`, not invoke; `system.selectFolder` uses `plugin-dialog` | `api/index.ts:182-224` |
| `Api.provider.modelCatalog` returns `ClientCatalog` from `src/renderer/utils/modelMapping.ts` (renderer-owned type for a backend payload) | `api/types.ts`; `src-tauri/src/services/model_catalog.rs` (`ModelCatalogResult`) |
| `Api.provider.modelList` (`provider_model_list`) has no renderer caller since the model workflow moved to the shared query controller; the command and signature are kept for compatibility | `api/index.ts`; `grep -rn "modelList" src/renderer` |

Console/gateway payloads added for the 3-day log and gateway-outlet work use shared types instead of inline shapes
(`ConsoleLogPage`, `ConsoleLogStatus`, `ConsoleLogClearResult`, `ConsoleLogRetention`,
`GatewayConnectionConfig` in `src/shared/types/index.ts`). `gateway_model_catalog_preview`
was retired with R9: gateway UI never queries models. `console_log_append_renderer` takes
`records: RendererLogRecord[]` and returns `{ accepted, rejected }` — enqueue counts,
not disk acknowledgement.

LAN access (R8) adds `proxy_lan_addresses` (no args) → `ProxyLanInfo
{ port, scope: 'loopback' | 'lan', addresses: [{ ip, url, interface }] }`, used by the
Gateway page and the Settings listen-scope section. It is read-only and must never return
the management token or file paths. The listen-scope setting itself travels through the
normal `settings.update({ proxyListenScope })` path; the backend restarts the daemon when it
changes, so the UI keeps the stored value and lets status polling reflect the restart.

When a backend command changes shape, update `src/renderer/api/types.ts`, `buildApi`, the shared types in `src/shared/types/index.ts`, the Rust model/serializer, and the contract test in the same change. That is the cross-layer contract the backend spec must mirror.

## Scenario: Ordered bootstrap, typed Desktop and scoped observation

### 1. Scope / Trigger

Use this contract for renderer startup/import changes, Desktop connection controls, scoped ledger reads, or precise request Console lookup. [Directory Structure](./directory-structure.md) owns navigation placement; [Resource Routing](./resource-routing.md) owns selection/create/apply continuity; [Observation Contract](./observation-contract.md) owns URL validation, population semantics and retained-log projection.

### 2. Signatures (API / Commands)

```ts
declare function installDevFixtureApi(api: Api): void
declare function getApi(): Api

// Relevant subset of Api; payload types come from @shared/types.
interface DesktopAndObservationApi {
  desktopConnection: {
    state(clientKind: DesktopClientKind): Promise<DesktopConnectionState>
    apply(clientKind: DesktopClientKind, providerId: string,
      apiKeyId: string): Promise<DesktopOperationResult>
    restore(clientKind: DesktopClientKind): Promise<DesktopOperationResult>
  }
  requestLog: {
    getStatistics(timeRange: StatsTimeRange, filter?: RequestLogFilter): Promise<UsageStatistics>
    getRecentPaginated(timeRange: StatsTimeRange, page?: number,
      pageSize?: number, filter?: RequestLogFilter): Promise<PaginatedRecentRequests>
  }
  console: { readRequest(requestId: string, limit?: number): Promise<ConsoleLogPage> }
}
```

| Namespace method | Exact command / arguments |
| --- | --- |
| `desktopConnection.state` | `desktop_connection_state({ clientKind })` |
| `desktopConnection.apply` | `desktop_connection_apply({ clientKind, providerId, apiKeyId })` |
| `desktopConnection.restore` | `desktop_connection_restore({ clientKind })` |
| `requestLog.getStatistics` | `request_log_get_statistics({ timeRange, ...(filter ? { filter } : {}) })` |
| `requestLog.getRecentPaginated` | `request_log_get_recent_paginated({ timeRange, page, pageSize, ...(filter ? { filter } : {}) })` |
| `console.readRequest` | `console_log_read_request({ requestId, limit })` |

Use [shared payloads](../../../../src/shared/types/index.ts) and the owning [Desktop Rust serializers](../../../../src-tauri/src/commands/desktop_connection.rs), not page-local guessed result shapes. The remaining `configTakeover.readCodex/readClaudeDesktop` methods are config-preview reads, not mutation entrypoints.

### 3. Contracts (Environment / State / Response)

- Fixture mode requires **both** `DEV` and `VITE_CC_USE_FIXTURE === '1'`. [main](../../../../src/renderer/main.tsx) injects the fixture before dynamically importing Console, stores and App. Ordinary mode skips injection and lazily builds the native API; neither mode depends on a runtime `window.api` assignment.
- Fixture installation rejects after native API use and rejects outside fixture mode. `getApi()` before fixture injection throws. The [strict fixture namespaces](../../../../src/renderer/dev/fixtureSupport.ts) reject unknown methods; no namespace merge, real-API fallback, renderer persistence or native migration listener is allowed in fixture mode.
- The dedicated fixture config is serve-only with the explicit environment flag. Isolation permits only preview static assets and the dedicated same-origin HMR endpoint: `vite-hmr`, or empty-query `vite-ping` for Vite restart probes. Native/daemon/provider application calls remain blocked. See [fixture README](../../../../src/renderer/dev/README.md) for the exact command and limitations.
- `DesktopClientKind` is `'codex' | 'claude_desktop'`. State contains typed `status`, public resource-ID `route`, `lastConfigChange`, `syncFailure` and `warning`; it does not expose session credentials. Status is `'official' | 'taken_over' | 'not_found' | 'error' | 'unknown'`.
- `lastConfigChange` is `{ action: 'takeover' | 'restore' | 'sync', source: 'user' | 'key_edit' | 'startup', changedAt, version } | null`. Successful route-only changes must not erase the previous configuration-change fact. `syncFailure` is a distinct persisted failure fact with source/time/message.
- Operation results contain `action: 'takeover' | 'switch_route' | 'restore'`, `completion: 'complete' | 'partial'`, independent `routeChanged`/`configChanged`, nullable `modelCount`, `nextAction: 'reopen_client' | 'none'`, timestamp, warning and authoritative `state`. Report saved configuration versus changed route separately. No field proves the external client has restarted or reloaded.
- `RequestLogFilter` carries optional provider/key/instance IDs, outcome and population. SQL applies the same validated scope before aggregation, count and pagination. Do not catch a scope failure and retry without it. Exact Console lookup reads retained logs by `requestId`; a bounded global buffer is not evidence of absence/expiry. Keep request projection local and respect clear revision/generation metadata.

### 4. Validation & Error Matrix

| Input / result | Required behavior |
| --- | --- |
| Production build with fixture flag, or a URL-only scenario switch | Must not activate fixture mode |
| Fixture API requested before injection / unknown method / native transport attempt | Fail closed and visibly; never invoke real services |
| Route-only complete Desktop result | Show route result; retain known configuration-change/reopen guidance |
| `configChanged=true`, `nextAction='reopen_client'` | Say configuration saved and client must be reopened; never claim restart detection |
| `completion='partial'` or persistent `syncFailure` | Preserve returned state and warning; do not display blanket success or silently dismiss the picker |
| Rejected Desktop mutation or stale prior-client response | Keep the current client's authoritative state; preserve retry context, invalidate stale responses |
| Invalid/mismatched/deleted observation scope | Scope unavailable/error, not empty global statistics or an unscoped retry |
| Exact Console miss, expired known request, read error | Distinct truthful states; only known retention/date evidence supports “expired” |

### 5. Good / Base / Bad Cases

- **Good:** apply a Codex route, render returned state, refresh it, and keep prior config-change guidance. A later key synchronization failure remains separately visible.
- **Base:** unfiltered statistics omit `filter`; ordinary native startup installs Console tap, persistence and store before React. Existing API argument shapes remain unchanged.
- **Bad:** hand-write Desktop settings/session calls in the page; treat route mutation as proof of client reload; obtain a precise request by filtering only the newest 500 global events; fall back to native APIs because a fixture method is missing.

### 6. Tests Required (Assertion Points)

- [API contract tests](../../../../src/renderer/api/__tests__/index.contract.test.ts): exact Desktop/scoped-statistics/readRequest command names, camelCase fields and absent-filter omission; existing mappings remain intact.
- [Fixture API tests](../../../../src/renderer/dev/fixtureApi.test.ts), [isolation tests](../../../../src/renderer/dev/isolation.test.ts), [Vite-config tests](../../../../src/renderer/dev/vite.config.test.ts): dual gate, pre-injection failure, no real fallback, actual Tauri invoke rejection, dedicated HMR/ping boundary, in-memory independence and partial/route-only outcomes.
- [DesktopPage tests](../../../../src/renderer/pages/DesktopPage.test.tsx): typed partial failure keeps the picker, state refresh retains guidance, stale-client responses/confirmations cannot change the current client.
- Scope/count/pagination, precise history and clear-generation assertions are specified in [Observation Contract](./observation-contract.md). Native temporary-file tests, not browser fixtures, prove durable Desktop file/state behavior.

### 7. Wrong vs Correct

| Wrong | Correct |
| --- | --- |
| Static App/store imports run before fixture installation | Keep the entrypoint's dynamic boundary and inject first |
| `return fixture.method ?? real.method` | Reject every unimplemented fixture method |
| Rebuild takeover from direct `invoke('set_setting', ...)` calls | One typed `desktopConnection.apply/restore` operation owned by Rust |
| Toast “client restarted” after saving config | Report `configChanged` and `nextAction`; show persistent config facts only |
| Filter an unscoped page / search the live Console ring for an old request | Server-scoped pagination plus exact retained `console.readRequest` projection |

## Scenario: Query scheme catalogue, the draft test and the persisted switch (v3.18)

### 1. Scope / Trigger

The amount-query UX: every renderer change to a query's scheme, switch,
script or test must keep the four coordinated edits plus the Rust contract
(`query_schemes.rs`, `services/query_test.rs`, `commands/balance.rs`) in one
change.

### 2. Signatures

- `balance.schemes(scope?)` → `query_schemes({scope})`; the scope argument is
  omitted when unset (both scopes).
- `balance.testDraft(input: QueryTestInput)` → `query_test({input})`.
- `balance.checkScript(script, baseUrl)` → a single request report or a
  `requests` map (the multi-request form reports one entry per name with its
  `optional` flag).
- `Provider.queryConfig` / `ApiKey.queryConfig` (`QueryConfig | null`) ride
  the standard provider/key create/update inputs; omitted on update keeps the
  stored switch.

### 3. Contracts

The section component owns the switch, scheme list, custom entry and test;
the modals own the credentials and the address. A key-scope test input never
carries `accessToken`/`userId`/`providerId`; an account test may borrow via
`providerId` only when the draft names no key. Any value-identity change
(state object identity, or the memoised `onDraftTest` identity rebuilding the
input) bumps a revision; a late `testDraft` response whose revision is stale
is dropped, and a displayed result is cleared (`QuerySettingsSection` A6
guard). A draft test result is never persisted by the renderer: no cache key,
no store write, no last-checked timestamp.

### 4. Wrong vs Correct

Wrong: derive scheme capabilities from `presetId` labels or from looking for
`{{apiKey}}` in the script. Correct: read `QuerySchemeInfo`
(credentialRequirements / supportsWindows / script) from the catalogue;
recognition against stored text is whole-text equality, display-only, and an
unrecognised script keeps its text and reads as the custom tier.


## Scenario: Saved provider catalogs, gateway restrictions and uploaded icon deletion (R9)

### 1. Scope / Trigger

These commands cross renderer, IPC, SQLite and the shared app/daemon runtime. Keep the
command, registration, shared DTO, bridge and consumer changes together.

### 2. Signatures

- `provider.getModelCatalog(providerId)` → `provider_model_catalog_get({ providerId })`.
- `provider.saveModelCatalog(providerId, models, revision)` → `provider_model_catalog_save({ providerId, models, revision })`.
- `provider.queryModels(input)` → `provider_model_catalog_query({ input })`; input is
  `{ providerId, apiKeyId, connectionConfig: GatewayConnectionConfig }`.
- `gateway.create(name, providerId, apiKeyId, connectionConfig?, modelPolicy?)`;
  `gateway.update(token, { ..., connectionConfig?, modelPolicy? })`.
- `icon.delete(filename)` → `icon_delete({ filename })`.

### 3. Contracts

`ProviderModelCatalog = { models: ClientModel[], revision: number, updatedAt: string | null }`;
`ClientModel = { id, displayName, supports1m? }` lives in shared types. Empty initial
catalog has revision 0. Only explicit save changes it. Query reads a saved Key's credentials,
with explicit URL/auth/UA drafts, independent of clientKind and clientConfigs.

`GatewayModelPolicy = { mode: 'all' } | { mode: 'selected', modelIds: string[] }`.
Missing create/old SQL NULL means all; omitted update preserves; explicit object replaces.
Gateway responses normalize the policy. `ProxySession.modelPolicy` is optional/null for
ordinary sessions. Selected mode applies to actual requests and discovery, including
subsequent application frames on an established WS connection.

`IconDeleteResult = { deleted: boolean, usedBy: { id, name }[] }`. In-use is a successful
domain response with `deleted: false`; validation/I/O errors reject. API input is a filename.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Stale catalog revision | Reject without overwriting saved models |
| Query Key belongs to another provider / inactive / exhausted | Reject before network |
| Invalid connection URL/UA | Reject without exposing secrets |
| Empty selected set / invalid ID / corrupt policy JSON | Reject; never default to all |
| Unselected model / unsupported endpoint or WS under selected | Local policy rejection; zero upstream delivery |
| Missing / duplicate / invalid top-level model, compressed/non-JSON body | Local validation error |
| Icon referenced by filename, legacy path or file URL | Return current referencing providers; no deletion |
| Icon traversal / built-in mark / directory / symlink | Reject; no filesystem mutation |

### 5. Good/Base/Bad Cases

- Good: explicitly save a provider catalog, select its IDs in a gateway, save the gateway,
  then discover only those IDs and forward an authorized JSON body unchanged.
- Base: legacy gateway missing policy stays all; opening or fetching a model window does
  not persist models or change any Key connection.
- Bad: hiding model IDs in the UI while leaving proxy routes or old WS frames unrestricted.

### 6. Tests Required

API contract tests pin all command names and camelCase arguments, omitted policy and
explicit all. TempDb tests cover catalog revision conflicts/reopen/cascade and policy
migration. Gateway/mock WS tests assert raw approved body and zero rejected upstream
hits. Icon tests use temporary directories and cover in-use references, path rejection
and delayed read/list invalidation. Provider catalog store tests prove revisions never
regress under overlapping fetch/save.

### 7. Wrong vs Correct

Wrong: call `provider.modelCatalogPreview` from Key mapping or gateway forms and keep
models only in a five-minute cache. Correct: the outer model manager alone calls
`queryModels`; downstream consumers subscribe to `useProviderModelCatalogStore` saved
snapshots plus their own current drafts. Query candidates never become saved data implicitly.
