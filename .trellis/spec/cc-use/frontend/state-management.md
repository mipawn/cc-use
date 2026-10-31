# State Management

> Zustand for shared domain state, local React state for page UI state, and one deliberate module-level external store for the console stream.

---

## Store Inventory (`src/renderer/stores/`)

| Store | State | Actions | Notes |
|---|---|---|---|
| `useProviderStore` (`providerStore.ts`) | `providers: Provider[]`, `loading: boolean`, `error: string \| null` | `fetchProviders`, `upsertProvider`, `createProvider`, `updateProvider`, `deleteProvider`, `reorderProviders`, `refreshBalance` | canonical provider list; `refreshBalance` re-reads the provider after a successful, valid balance query |
| `useApiKeyStore` (`apiKeyStore.ts`) | `apiKeys: Record<providerId, ApiKey[]>`, `loading: Record<providerId, boolean>` | `fetchApiKeys`, `fetchAllApiKeys`, `getAllApiKeys`, `createApiKey`, `updateApiKey`, `deleteApiKey`, `reorderApiKeys` | no `error` field; failures are rethrown to the caller |
| `useProjectStore` (`projectStore.ts`) | `projects: Project[]`, `loading`, `error` | `fetchProjects`, `createProject`, `updateProject`, `updateProjectBinding`, `deleteProject`, `getProjectByPath` | |
| `useSettingsStore` (`settingsStore.ts`) | `language`, `themeMode`, `resolvedTheme`, `globalSettings: GlobalSettings` | `setLanguage`, `setThemeMode`, `initSettings`, `fetchGlobalSettings`, `updateGlobalSettings` | persists `language` / `themeMode` in `localStorage`; bootstrapped once from `main.tsx` via `initSettings()` |
| `useProviderModelCatalogStore` (`providerModelCatalogStore.ts`) | per-provider saved `catalogs`, `loading`, `errors`, request revisions | `fetchCatalog`, `saveCatalog` | saved snapshots only; query candidates and uncommitted selections never enter this store |
| `reloadStores.ts` | — | `reloadMigratedStores` | programmatic re-read after import / Electron migration instead of reloading the WebView |

All stores are created with Zustand v5's `create<State>((set, get) => ({ ... }))` (`zustand ^5.0.2` in `package.json`). State fields are declared first, actions below; action names are `fetchX` / `createX` / `updateX` / `deleteX` / `reorderX`.

---

## Async Read Convention

The read pattern in `providerStore.ts:34-46` and `projectStore.ts:31-43`:

1. `set({ loading: true, error: null })`
2. `await getApi().<domain>.list()`
3. `set({ data, loading: false })`
4. On failure: `set({ error: error instanceof Error ? error.message : 'Failed to fetch <thing>', loading: false })`

`apiKeyStore.ts` deliberately diverges: it keeps per-provider loading flags and **rethrows** instead of storing an error (`fetchApiKeys` / `fetchAllApiKeys`), because keys are fetched in bulk by several pages that each report failures themselves.

Important: the `error` fields are written but **no page currently destructures them** (search `useProviderStore()` / `useProjectStore()` call sites). Only `loading` is consumed (`pages/Keys.tsx` destructures `providersLoading` and shows a spinner). Surface failures where the call happens with `message.error(...)` plus `console.error(...)`; do not assume a store error renders itself.

---

## Mutation Convention

- **Server first, then local state.** `createX` awaits the API and appends the returned entity; `updateX` maps by `id`; `deleteX` filters by `id`. The returned entity is passed back to the caller (`providerStore.ts` `createProvider` / `updateProvider`).
- **Optimistic updates are the exception, not the default.** `reorderProviders` (`providerStore.ts:76-90`) applies the new order immediately, persists, and reverts to the previous array on failure. UI-level toggles follow the same revert-on-failure rule: `pages/Settings.tsx` launch-at-login switch, `pages/Console.tsx` `handleDetailMode`. If you add an optimistic update, implement the revert path and comment it.
- **Bulk refresh happens through the stores**, not by remounting pages: `reloadMigratedStores()` calls `useProviderStore.getState().fetchProviders()`, then `fetchAllApiKeys` and `fetchProjects` in parallel (`stores/reloadStores.ts`). Add new domain stores to this function when an import/migration can change them.
- **Never call `getApi()` at module scope** — call it inside actions/handlers. `getApi()` lazily builds the bridge; module-scope calls break test mocking and load Tauri code too early.

---

## What Stays Out of Stores

Keep in component state (or `useMemo`):

- filters, search text, selected tab/view — `Statistics.tsx` (`timeRange`, `recentPage`, `recentPageSize`), `Console.tsx` (`view`, `query`, `selectedKey`), `Keys.tsx` (`activeFilter`);
- dialog/drawer visibility and the entity being edited — `Keys.tsx` (`providerModalOpen`, `editingProvider`, `keyEditOpen`, `editingKey`, `keyEditMode`), `Projects.tsx` (`modalOpen`, `editingProject`, `routePickerProject`);
- drafts and transient per-row busy sets — `Keys.tsx` (`refreshingIds`, `refreshingKeyUsageIds`, `modelList*`);
- derived views — group/filter with `useMemo` (`Keys.tsx` `groupedKeys`) or expose a getter on the store (`useApiKeyStore.getAllApiKeys()`), instead of storing a second copy.

Note the exceptions: `Instances.tsx` keeps polled instance/key/provider data in local state because the page owns the 5 s heartbeat; `Statistics.tsx` keeps fetched statistics locally because they are scoped to the current time range. Rule of thumb: **shared across pages → store; owned by one page's lifecycle → local state.**

---

## Reading Stores

Two patterns coexist:

- whole-store destructuring — `const { providers, fetchProviders } = useProviderStore()`. Common in pages; re-renders on any store change.
- narrow selector — `useSettingsStore((s) => s.resolvedTheme)` in `hooks/useAntdTokenSync.ts`. Prefer this for a single primitive or when a component only needs one field.

Never mutate store objects in place (`providers.push(...)`); always produce new arrays/objects through `set`, because Zustand compares references.

---

## The Console External Store (non-Zustand)

`src/renderer/api/consoleStore.ts` is intentionally not a Zustand store: it is a process-long event buffer with an `EventTarget` and `useSyncExternalStore`.

- Installed once at boot: `installConsoleStore()` in `main.tsx` before render. It subscribes to `proxy:consoleEvent` (`getApi().console.onEvent`) and to the renderer console bus, then hydrates from disk (`hydrateConsoleHistory` → `getApi().console.readRecent(['daemon', 'app'], 500)`).
- Bounded: `BUFFER_LIMIT = 500` rows and `BUFFER_BYTE_LIMIT = 8 * 1024 * 1024`; `trim()` keeps the newest records.
- Identity-based merge: `mergeConsoleEventList` folds replay/live events by `requestId` for requests and `id` for logs. A replayed `pending` never overwrites a terminal row (`isPending` guard).
- Read path: `useSyncExternalStore(subscribeConsoleStore, getConsoleEvents)` in `pages/Console.tsx`; every commit creates a new array so the snapshot comparison triggers a render.
- Retention meta: the hydrated page's `generation` / `truncated` / `retention` (`retentionStartDate`, `capacityEvicted`, `trimmed`, `corrupted`, `limited`) is exposed through `getConsoleHistoryMeta()`; `retentionStartDate`/`consoleEventLocalDay` convert the UTC record timestamps to *local* days using the same rule as the Rust store.
- TTL prune: `pruneExpiredConsoleEvents()` drops rows outside the current local day + previous two, and the page re-checks it on mount, every 25 s, and on visibility/focus. A long-open page therefore never claims to show a complete three-day archive.
- Clear path: `clearConsoleHistory()` first pauses the persistence bridge (bump generation, drop unsent batches, wait for the in-flight one), then calls the backend and returns the per-owner `{ ok, app, daemon }` result; partial failure is shown, not swallowed. Navigating away does not clear anything.
- `src/renderer/api/consoleBus.ts` patches global `console.*` into the same stream (`installRendererConsoleTap`, installed first in `main.tsx`) with a re-entry guard so a subscriber calling `console.log` cannot recurse. It stamps ids as `renderer-<startup epoch>-<seq>` so a replayed row and a new live row can never collide.
- `src/renderer/api/consoleLogBridge.ts` (`installRendererLogBridge`, installed after the tap) is the only writer of renderer lines to disk: batching/flush/buffer limits live there, and it subscribes to the raw renderer bus only so replayed app/daemon events never loop back. `getRendererLogBridgeStatus()` exposes local queue/ipc failure counters for the Console page.

If you need another process-long stream, follow this shape (module buffer + `EventTarget` + `useSyncExternalStore`) rather than adding a Zustand store with subscriptions inside actions.

---

## Cross-Layer Notes

- Stores never decide business rules that belong to Rust: validation, dedupe, ordering persistence, and session creation are backend responsibilities; stores call commands and keep the renderer's copy in sync.
- `refreshBalance` is a good reference for a compound action: call `getApi().balance.refresh(id)`, and only when `!result.error && result.isValid` re-read the provider so the UI shows the refreshed cached usage (`providerStore.ts:92-101`; covered by `stores/providerStore.test.ts`).
- Race-prone reads and writes get an explicit identity + revision guard instead of relying on React state timing. `hooks/useModelCatalogQuery.ts` is used only by the outer provider model manager: provider/Key/credential-version/effective URL/auth/UA/header/proxy identity, bounded transient cache and stale response guards. Query connection drafts never read or write per-client preferences. `components/usage/ResourceUsageModal.tsx` independently uses scope+range revision and still-open guards.


## Saved Model Catalog and Observation State (R9)

`useProviderModelCatalogStore` publishes only backend-confirmed catalog snapshots. Compare
server revisions before replacing a saved snapshot, in addition to local request sequence:
a read started after a pending save can still return the older server revision. A failed
read/save preserves the last saved snapshot and exposes a per-provider error. A successful
save publishes to Key mapping and gateway consumers immediately, while their drafts remain
local. Catalog revision conflicts require reload instead of silent overwrite.

`pages/observationState.tsx` uses a React context owned by ActivityPage, with separate
request and log filters. It survives transitions between `/console`, `/logs`, `/stats`,
and ends when the observation shell unmounts. Only the visible page registers refresh.
Do not duplicate console collection or persist filters in localStorage.

Console replay must preserve log-envelope identity: missing request/log IDs receive a
source/epoch/sequence fallback before merging. Live anonymous objects have stable keys
independent of their array position. History loads use a revision invalidated before and
after clear so a delayed read cannot resurrect removed records.


Provider-mode Key selections use optional `catalog.draftModels` in modelMapping for
editor persistence. Append/custom still serialize `catalog.models`. Do not put dormant
provider selections in `catalog.models`: the Rust catalog code uses that legacy field
for alias bypass and 1M metadata even when provider membership is retained. Draft models
never seed Claude Desktop roles. TS roundtrip and Rust runtime-equivalence tests protect
this boundary. Empty default editors still serialize no mapping.
