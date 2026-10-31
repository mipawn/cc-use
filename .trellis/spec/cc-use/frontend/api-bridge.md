# API Bridge

> How the renderer talks to Rust, and the four edits every Tauri command change requires.

---

## The Contract

All frontend→backend traffic goes through one object. Direct `@tauri-apps/*` imports are limited to the bridge itself plus the exceptions documented under [Known Drift](#known-drift-verify-before-trusting): native file dialogs in `pages/Settings.tsx`, the migration event listener in `App.tsx`, and the config-takeover pages that call `invoke()` by hand.

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

`Api` namespaces currently cover: `provider`, `userAgent`, `apiKey`, `project`, `terminal`, `proxy`, `console`, `balance`, `keyUsage`, `importExport`, `session`, `settings`, `configTakeover`, `icon`, `usageLog`, `requestLog`, `cliTool`, `app`, `system`, `systemExt`, `sessions`, `managedInstances`, `codexApp`.

---

## Command and Argument Rules

1. **Command names are `<domain>_<verb>` snake_case strings** that must match the Rust `#[tauri::command]` function name exactly — `provider_get`, `terminal_launch`, `console_log_read_recent`, `managed_instance_update_assignment`.
2. **The argument object is camelCase; Rust parameters are snake_case.** Tauri v2 converts them by default. Examples across the bridge:
   - `provider_model_catalog` (`src-tauri/src/commands/providers.rs:118`) takes `provider_id, api_key_id, client_kind`; the frontend sends `{ providerId, apiKeyId, clientKind }` (`api/index.ts:38`).
   - `terminal_get_launch_preview` takes `project_id, provider_id, api_key_id, cli_type`; the frontend forwards its camelCase `params` object unchanged (`api/index.ts:70`).
   - `provider_reorder` takes `provider_ids`; frontend sends `{ providerIds }` (`api/index.ts:29`).
3. **Omit absent optionals rather than sending `undefined` or fake values.** `provider.modelList` only adds `clientKind` when it exists (`...(clientKind ? { clientKind } : {})`, `api/index.ts:30-36`). No-argument commands pass `undefined` explicitly and the contract test asserts it (`proxy_restart`).
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

Command registration is mandatory: an invoke of an unregistered command fails at runtime. Registration does not prove the renderer uses it through `Api`: `system_open_external` is registered but the renderer calls the opener plugin instead, and `get_setting` / `set_setting` / `delete_setting` are registered but called directly from the config-takeover pages.

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
| `Api.codexApp` maps to `codex_app_launch`, `codex_app_stop`, `codex_app_get_active_project`, but no `codex_app_*` command exists in `src-tauri/src` (only unrelated proxy tests mention Codex app sessions) | `api/types.ts:305-309`, `api/index.ts:244-248`; `grep -rn "codex_app" src-tauri` |
| Config-takeover pages call `invoke()` directly for registered commands that are missing from `Api`: `codex_config_is_taken_over`, `codex_config_takeover`, `codex_config_restore`, `claude_desktop_schema_detect`, `claude_desktop_config_takeover`, `claude_desktop_config_restore`, `get_setting`, `set_setting`, `delete_setting` | `pages/CodexPage.tsx:31-87`, `pages/ClaudeDesktopPage.tsx:31-100` |
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
