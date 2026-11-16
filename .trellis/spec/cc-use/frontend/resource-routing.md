# Resource Routing Contract

## 1. Scope / Trigger

Apply when changing provider/key resources, the shared route picker, nested creation, quota presentation, or bindings in Instances, Desktop and Gateway. A route is a **provider plus one of that provider's keys**, not a provider-only default. GUI selection is not GUI project launching.

Authoritative owners: [RoutePickerModal](../../../../src/renderer/components/common/RoutePickerModal.tsx), [KeyEditModal](../../../../src/renderer/components/keys/KeyEditModal.tsx), [clientSupport](../../../../src/renderer/utils/clientSupport.ts), [QuotaSnapshot](../../../../src/renderer/components/common/QuotaSnapshot.tsx), [accountQuery](../../../../src/renderer/utils/accountQuery.ts), [InstancesPage](../../../../src/renderer/pages/InstancesPage.tsx), [DesktopPage](../../../../src/renderer/pages/DesktopPage.tsx), and [GatewayPage](../../../../src/renderer/pages/GatewayPage.tsx). See [API Bridge](./api-bridge.md) for transport and saved model-catalog contracts.

## 2. Signatures (Component / API / Payload)

```ts
interface RouteSelection { provider: Provider; apiKey: ApiKey }
interface RoutePickerContract {
  open: boolean
  clientKind?: ClientKind                   // default: claude_code
  context?: 'client' | 'gateway'             // default: client
  providers: Provider[]
  apiKeys: ApiKey[]
  currentKeyId?: string
  title?: string
  actionText?: string
  onCancel(): void
  onSelect(selection: RouteSelection): Promise<void> | void
}

declare function supportsKeyClient(provider: Provider, key: ApiKey, clientKind: ClientKind): boolean
declare function getRouteModelLabel(key: Pick<ApiKey, 'config' | 'modelMapping'>,
  clientKind: ClientKind, providerLabel: string): string

// owner is mandatory; cached quantities are not interchangeable.
declare function QuotaSnapshot(props: {
  usage: UsageData | null | undefined
  checkedAt?: string | null
  owner: 'account' | 'key'
  balance?: number | null
  currency?: string | null
}): React.JSX.Element
```

The picker consumes existing resource/usage APIs through `getApi()` and the shared stores; it introduces no command or database table. Mutation ownership stays with the consumer:

| Consumer / action | Boundary |
| --- | --- |
| Create provider/key | `useProviderStore.createProvider(input)` / `useApiKeyStore.createApiKey(toCreateApiKeyInput(input))` → typed provider/key create APIs |
| Refresh account/key query | `balance.refresh(providerId)` / `keyUsage.refresh(apiKeyId)`, followed by authoritative provider/key rereads |
| Assign a CLI-managed instance | `managedInstances.updateAssignment({ id, providerId, apiKeyId, assignmentSource? })` |
| Apply Desktop route | `desktopConnection.apply(clientKind, providerId, apiKeyId)` → typed operation result |
| Choose Gateway route | Picker updates only local `providerId`/`apiKeyId`; the outer editor's Save owns `gateway.create/update` |

The deprecated optional `onReorderApiKeys` prop is ignored. Ordering belongs to resource management, never a route-selection side effect.

## 3. Contracts (Eligibility / Draft / Quota / Policy)

### Eligibility and selection

- In `context='client'`, include a key only when `supportsKeyClient(provider, key, clientKind)` is true. Client compatibility belongs to **key types**, not provider branding or the caller's default client.
- Normalize legacy client aliases and deduplicate types. Missing/empty key types retain the compatibility default `['claude_code']`; official DeepSeek excludes Grok even if a historical key claims it. Use the helper rather than duplicating these rules.
- In `context='gateway'`, key client types do **not** filter selection. Gateway is an independent access point. Do not force Claude Code compatibility because the optional `clientKind` defaults to it.
- Both contexts require an active provider, active key, matching provider/key association and `!key.isExhausted` before Apply. Inactive/exhausted compatible resources remain explainably disabled; missing/incompatible selections cannot submit. Unknown quota alone does not mean exhausted.
- Opening seeds `currentKeyId` once for that open session. Search, provider browsing and official/all scope changes do not erase the selected route. Search can match provider name, key alias/ID and client model label; never expose raw credentials as search/display context.
- Client model labels distinguish the client model from upstream forwarding/family/fixed/catalog semantics. Gateway selection must not display a key's client mapping as the gateway policy.

### Create → return → explicit apply

- One visible modal at a time: selection → provider creation → key creation, or selection → key creation. Keep the selection host and caller's target alive while the nested editor is shown.
- Saving a new provider persists it, adds a local overlay and seeds the key editor with its ID. Saving a key persists it, adds its local overlay, selects its ID, then returns through the editor close callback to selection. Creation is **not** route application.
- Client creation seeds the target client alongside applicable provider defaults. Gateway creation does not force a target client. Provider/key forms remain the same resource editors used by resource management, not reduced duplicate forms.
- Canceling a nested editor returns to selection without losing search/selection or applying a route. Already-saved resources are not silently rolled back because a later step is canceled.
- Only the explicit picker action calls `onSelect`. Await that callback and close only on success. Rejection retains selection, search and retry feedback; a submission guard blocks duplicate calls and cancellation during the pending mutation.
- A saved key's optional first quota query is follow-up work. Its failure shows quota feedback; it must not turn a completed resource save into a failed save, invite duplicate creation, or automatically apply the key.
- Gateway has two deliberate boundaries: picker confirmation updates the binding **draft** and returns to the editor; outer Save persists the gateway. Neither nested resource creation nor picking a key invokes `gateway.update` automatically.

### Stable drafts under refresh

- Parent resource polling is authoritative for data, **not** an instruction to reinitialize local search, selected ID, creation step or unsaved form fields.
- Merge locally created resources until the parent list contains their IDs, then retire the overlays. A parent update invalidates an older local quota snapshot and increments the revision so late snapshot reads cannot resurrect stale data.
- Recompute eligibility against refreshed resources. If the selected key becomes disabled/deleted/incompatible, retain the user's context but disable Apply; do not silently select another key.
- The key editor seeds a draft by edited identity (`mode`, key ID, provider ID), not object identity. Same-resource refreshes must not reset credential fields, mapping, query script/switch or pending edits. Changing the actual edited identity or explicitly reopening is a separate initialization boundary.
- Gateway name, binding, selected-model policy, model IDs and connection overrides are initialized on explicit create/edit, not on polling. Resource/catalog refreshes can update choices and validity without replacing the draft. Unsaved selected model IDs remain visible even if absent from the refreshed catalog.
- Ordinary page refresh is not a component remount or `location.reload()`. A hard WebView reload is explicit recovery, not a draft-preserving operation.

### Quota owner, units, windows and time

The [shared quota types](../../../../src/shared/types/index.ts) preserve these independent facts:

```ts
interface UsageData {
  total?: number; used?: number; remaining?: number; unit?: string
  isUnlimited?: boolean; expireAt?: string
  windows?: UsageWindow[]; groups?: UsageGroup[]
}
interface UsageWindow {
  id: string; label: string; usedPercent: number | null
  resetsAt: string | null; status: string | null
}
interface UsageGroup { id: string; label: string; windows: UsageWindow[] }
```

- Label account quota at provider level once; key quota belongs to that key. For `provider.queryScope === 'key'`, suppress the provider account quota and provider account refresh. An independently configured key query remains key-owned.
- `effectiveQuery` respects a saved disabled switch even if script text is non-empty. Only records without saved query config retain the legacy non-empty-script enabled behavior. Do not launch a disabled query merely because a script exists.
- Render actual remaining/used/total values only when present; zero is valid, missing is unknown, unlimited is explicit. Keep currency/unit meaning (`USD`, `CNY`, tokens, or provider-supplied units); no conversion or invented total.
- [ProviderUsageWindows](../../../../src/renderer/components/providers/ProviderUsageWindows.tsx) displays rolling, weekly and monthly windows in stable order, then unknown windows in provider order. Keep groups separate, including their names and own windows. Never sum percentages, average groups or combine account balance with key quota.
- A null `usedPercent` gets unknown text, not `0%`; any zero used solely for a decorative Progress prop is not reported usage. Keep up to two decimal places so small nonzero use does not become zero.
- Preserve owner-specific checked timestamps, expiry, window reset times and statuses. Missing timestamps stay missing; refresh start is not a successful observation. Reset countdowns are distinct from cache freshness. A retained value is a cached fact, not proof that a new query succeeded.
- Manual quota refresh queries only configured owners (the active provider account and selected key), then rereads resources. Query failure and list-read failure have visible feedback while preserving usable selection/draft context. Revision guards reject obsolete snapshots.

### Gateway policy remains independent

- Changing provider/key changes binding only. Never copy the key's `modelMapping` into a gateway, reset `mode:'selected'` to `'all'`, clear selected IDs or discard connection overrides as a side effect.
- Gateway policy is `{ mode: 'all' } | { mode: 'selected', modelIds: string[] }`. Selected mode requires at least one nonblank ID; typed/manual IDs remain valid even if not present in the saved provider catalog. Opening the editor does not query the network for model candidates.
- Send the user's current policy and whole connection draft on Save. `connectionConfig` is `{ baseUrl: string | null, authScheme, userAgent: string | null }`: omitted update field retains stored configuration; an object replaces it; all defaults clear overrides. Do not send `null` as the entire object or use partial-object patch semantics.
- A non-empty address must be absolute HTTP(S), without credentials/query/fragment; user-agent text cannot contain CR/LF. Empty address/UA become `null` and inherit provider/default behavior; displaying a provider UA does not silently save it as an override.

## 4. Validation & Error Matrix

| Input / event | Expected result |
| --- | --- |
| Codex-only key in Claude Code picker | Excluded, not relabeled as compatible |
| Codex-only key in Gateway picker | Eligible if provider/key active and key not exhausted |
| Official DeepSeek historical Grok type | Excluded for Grok client use by the compatibility helper |
| Selected key disabled during polling | Search/selection retained; Apply disabled; no substitute route |
| Provider/key created successfully | Persisted resource shown in selection context; `onSelect` still untouched |
| Initial quota query fails after key save | Resource remains saved; quota error only; no duplicate save prompt |
| Mutation callback rejects / Desktop returns partial | Picker remains open with feedback and retry context; consumer preserves authoritative state |
| Older quota result finishes after parent resource update | Discard obsolete snapshot; do not re-enable stale resource |
| Quota missing / zero / unlimited | Three distinct states; never coerce missing to zero |
| Multiple windows, currencies or groups | Show separate owner/unit/window/group facts, never a synthetic combined total |
| Gateway route changes with selected model draft | Only binding changes; same selected mode, IDs and overrides survive |
| Selected Gateway policy empty / invalid address or UA | Block Save, keep the draft and show targeted validation |

## 5. Good / Base / Bad Cases

- **Good:** create a provider and a client-seeded key, return with it selected, inspect the quota, then explicitly Apply. A quota failure after save does not lose the resource.
- **Base:** open a picker on the current route, search another provider, refresh data and cancel; no route mutation occurs and the consumer remains unchanged.
- **Good:** a Gateway uses a Codex-only key while keeping its manually selected gateway model IDs. Switching its key preserves both policy and saved connection overrides until explicit Save.
- **Bad:** provider-wide client compatibility, automatic application on resource save, draft reset on every new array identity, unknown quota rendered as zero, or account/window/group percentages collapsed into one total.

## 6. Tests Required (Assertion Points)

| Existing test owner | Assertions to preserve / extend when touching this boundary |
| --- | --- |
| [RoutePicker interaction tests](../../../../src/renderer/components/common/RoutePickerModal.interaction.test.tsx) | Nested cancel preserves query/selection; provider→key flow seeds client and never implicitly applies; parent refresh preserves draft but honors disabled resources; Gateway bypasses key client types; unknown quota text; failed Apply retains context; obsolete snapshot discarded |
| [Client-support tests](../../../../src/renderer/utils/clientSupport.test.ts) | Alias/default normalization, key-owned compatibility, official DeepSeek/Grok exclusion |
| [Key editor tests](../../../../src/renderer/components/keys/KeyEditModal.component.test.tsx) | Explicit client seed/defaults, same-identity draft continuity, query switch ownership, full duplicate semantics and saved model choices |
| [Account-query tests](../../../../src/renderer/utils/accountQuery.test.ts), [window component tests](../../../../src/renderer/components/providers/ProviderUsageWindows.component.test.tsx) | Window ordering/precision, unknown versus zero, separate group rendering, pending versus cached facts, reset status and labels |
| [Gateway tests](../../../../src/renderer/pages/GatewayPage.test.tsx) | Binding draft changes do not reset selected IDs/policy or overrides; refresh does not reset unsaved editor fields; picker confirm does not persist until Save; save replacement/omission semantics and validation |
| [Desktop tests](../../../../src/renderer/pages/DesktopPage.test.tsx), [Instances tests](../../../../src/renderer/pages/Instances.test.tsx) | Newly created resource is immediately usable, rejected/partial assignment stays retryable, typed/authoritative state is reread, previous-client responses cannot overwrite the new client |

Required assertion points are regression obligations, not a claim that documentation editing reran the suites. Browser fixture journeys can verify create→return→apply and draft continuity, but not real provider credentials, native persistence or external-client reload.

## 7. Wrong vs Correct

| Wrong | Correct |
| --- | --- |
| Filter Gateway keys using the default Claude Code client | `context === 'gateway' \|\| supportsKeyClient(provider, key, clientKind)` |
| Call `onSelect` from resource `onSave` | Persist and return to picker; invoke only after explicit Apply |
| Effect resets drafts whenever `providers`/`apiKeys` changes | Initialize on open/edited identity; refresh data and recompute eligibility separately |
| Retry key creation when its first quota query fails | Preserve successful creation and surface only the quota failure |
| `remaining ?? 0` or average every window/group | Unknown is unknown; preserve each reported owner/unit/window/group/time |
| Reset gateway model policy when selecting a new key | Update provider/key IDs only; keep the independent policy and connection draft |
