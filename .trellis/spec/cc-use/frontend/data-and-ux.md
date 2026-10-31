# Data and UX Patterns

> How screens load data, refresh it, and report loading / empty / error / success states.

---

## Page Data Loading

There is no data-fetching library (no React Query/SWR). Two mechanisms:

1. **Shared domain data** comes from Zustand stores ([State Management](./state-management.md)).
2. **Page-scoped data** is fetched in the page with `useState` + `useEffect`, guarded against stale responses.

The canonical page-scoped fetch has this shape (`pages/Dashboard.tsx:34-52`):

```ts
const fetchOverview = useCallback(async (isCancelled?: () => boolean) => {
  try {
    const data = await getApi().requestLog.getOverview()
    if (!isCancelled?.()) setOverview(data)
  } catch (error) {
    if (!isCancelled?.()) {
      console.error('Failed to fetch usage overview:', error)
      setOverviewFailed(true)
    }
  }
}, [])
```

Rules learned from the existing pages:

- Cancel stale work on unmount/filter change with a `cancelled` flag (`Dashboard.tsx`, `Statistics.tsx`) or a monotonically increasing token (`Statistics.tsx` `refreshToken` drops a manual refresh whose filters changed meanwhile).
- Clear the old data when the query identity changes so the screen does not show another range's numbers (`Statistics.tsx` sets `stats` to `null` before fetching a new `timeRange`).
- Reset dependent pagination when the filter changes (`Statistics.tsx` resets `recentPage` to 1 on `timeRange` change).
- Polling is allowed but must be cleaned up: `Instances.tsx` refreshes every 5 s with `load(true)` (silent), storing the interval in `timerRef` and clearing it on unmount; `Keys.tsx` polls provider gateway metrics every 30 s with `window.setInterval` + cleanup. `load(silent)` keeps the spinner from flashing on heartbeat ticks while a manual refresh (`usePageRefresh`) still shows progress.
- Long-lived status belongs in a hook when several components need it: `hooks/useServiceStatus.ts` returns `{ status, loading, restart, fetchStatus }`, subscribes to `proxy.onStatusChanged`, and is used by `components/layout/ServiceStatusPill.tsx` and `pages/Settings.tsx`.

---

## Refresh: `usePageRefresh`, not `window.location.reload()`

`App.tsx` binds ⌘R to `refreshCurrentPage()` and ⌘⇧R to `hardReloadWebview()` (the latter explicitly labelled "fault recovery and development only"). `⌘R` re-reads only what is mounted, so filters, pagination, scroll position, drafts, and console history survive.

The registry lives in `src/renderer/api/pageRefresh.ts`:

- `registerPageRefresh(handler)` returns an unregister function; handlers are a `Set`;
- `refreshCurrentPage()` runs all handlers with `Promise.allSettled` (one failure does not block others) and resolves `false` when nothing is registered — `App.tsx` then shows `t('common.nothingToRefresh')`;
- `hooks/usePageRefresh(handler)` registers the latest handler via a ref, so a refresh uses the filters currently on screen.

Every page that owns data registers its loader. Current registrations: `pages/Settings.tsx`, `Projects.tsx`, `Keys.tsx`, `Sessions.tsx`, `Dashboard.tsx`, `Instances.tsx`, `Statistics.tsx`, `Console.tsx`, `ClaudeCodePage.tsx`, `CodexPage.tsx`, `ClaudeDesktopPage.tsx`. Embedded tabs register too — refreshing `/claude-code` runs the shell loader and the embedded Projects/Instances/Sessions loaders independently (comments in `ClaudeCodePage.tsx:44-46` and `Projects.tsx:141-142`).

Dialogs can register conditionally: `components/usage/ResourceUsageModal.tsx` mounts a tiny `PageRefreshBridge` (a component whose only job is `usePageRefresh(load)`) **only while the dialog is open on a valid scope**, so ⌘R re-queries the open dialog and closing it unregisters immediately. When an async dialog does this, guard the response with identity + revision + still-open; a late reply for a previous scope must not overwrite the current one.

A refresh handler must be **read-only relative to the user's draft and side effects**:

- `Settings.tsx:202-203` — refreshing never saves and never restarts anything, so unsaved edits stay.
- `CodexPage.tsx:51-54`, `ClaudeDesktopPage.tsx:64-67` — refreshing re-reads takeover state, never re-takes-over or restores.
- `Keys.tsx:223-226` — refreshing local provider/key/metrics data must not fire a balance query at every upstream.

Tests: `api/pageRefresh.test.ts` covers the registry contract (all handlers run, async awaited, failures isolated, unregister stops future runs).

---

## Loading

| Situation | Pattern | Example |
|---|---|---|
| First page load | local `loading` state + `<Spin size='large' />` in a dedicated state div | `pages/Statistics.tsx:372-373` (`styles.loadingState`) |
| Table refresh | antd `Table loading` prop, keeping rows visible | `pages/Statistics.tsx` recent-request table |
| Button-triggered work | `loading` prop on the button | `pages/Settings.tsx` export/import buttons |
| Modal confirmation | `confirmLoading` / `okButtonProps` | `App.tsx` migration modal; `KeyEditModal` save |
| Background heartbeat | `silent` flag suppresses spinner | `pages/Instances.tsx` `load(silent)` |
| Long download | antd `Progress` with downloaded/total | `pages/Settings.tsx` update download |

Missing scalar values render `—` (em dash), not an empty string or 0: `Dashboard.tsx` (`overview?.todayRequests ?? '—'`), `formatPerformance.ts` returns `'—'` for absent metrics.

---

## Empty States

- Tables: `locale={{ emptyText: t('...') }}` (`Statistics.tsx:512,540,578`).
- Lists/cards: `<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('...')} />` (`TakeoverConfigTab.tsx`), or a compact secondary `<Text>` when the area is small (`KeyCascader.tsx`).
- Whole-page empty card with a title and explanation: `Statistics.tsx:546-556` (`statistics.noData` + `statistics.noDataHint`).
- Do not show meaningful zeros for missing data: `ProviderUsageWindows.tsx` prints an explicit unknown label when `usedPercent === null` instead of `0%`.

---

## Error Handling

1. **Toasts for actionable failures.** `const message = useAppMessage()` (`hooks/useAppMessage.ts`) returns the context-scoped antd `MessageInstance`; the provider is configured in `main.tsx` (`maxCount: 3`, `top: 60`). The hook docstring says: use this instead of importing `message` from `antd` directly.
   - Existing exceptions that still import static `message`: `pages/Settings.tsx`, `pages/Instances.tsx`, `pages/CodexPage.tsx`, `pages/ClaudeDesktopPage.tsx`, and `stores/settingsStore.ts` (non-hook context). Do not add more; use `useAppMessage()` in components/pages.
2. **Always pair a user message with `console.error`** for unexpected failures. The renderer console tap (`api/consoleBus.ts`, installed in `main.tsx`) forwards `console.*` to the Console page, so the diagnostic survives without devtools: `Dashboard.tsx`, `Statistics.tsx`, `Instances.tsx`, `Keys.tsx` all log then toast.
3. **Inline errors for persistent state.** `Dashboard.tsx` renders an inline `styles.loadError` row with a `common.retry` button when `overviewFailed`; `Settings.tsx:852` uses `Alert type='warning'` to warn that exports include plaintext credentials; `Sessions.tsx` shows a persistent info `Alert`; `App.tsx` shows the update `Alert` banner.
4. **Blocking errors use `Modal.error`** when the flow cannot continue — `Settings.tsx:410` lists per-item errors when an import is partially rejected.
5. **Domain results carry their own error fields.** Balance/quota refresh returns `{ isValid, invalidMessage, error }`; pages prefer those messages and only fall back to a translated generic (`Keys.tsx:332-335`, `:355-358`).
6. **Render crashes** are caught by `components/common/AppErrorBoundary.tsx` wrapped around `AppContent` inside `HashRouter` (`App.tsx`). Event-handler errors are not caught there — wrap async handlers in `try/catch` and report.

---

## Confirmations for Destructive Actions

| Mechanism | Use for | Examples |
|---|---|---|
| `Popconfirm` (inline, `danger` ok button) | single-row/card delete from a list | `pages/Keys.tsx:1042-1057`, `pages/Projects.tsx:498-509`, `pages/Sessions.tsx:250-256` |
| `Modal.confirm` | bulk or irreversible operations explained in prose | `pages/Sessions.tsx:99,107,123` (delete/clean/keep sessions), `pages/Settings.tsx:181` (uninstall CLI tool), `components/providers/TerminalToolsPanel.tsx:41` |
| `Modal.useModal()` + context holder | confirmations triggered from inside another async flow | `pages/Keys.tsx:146` (`confirmModal`, `confirmContextHolder`) |

Rules:

- Confirmations must state the scope ("only removes `/usr/local/bin/cc-use`", "deletes selected sessions") — copy lives in `locales/*.ts` (`settings.cliToolUninstallConfirm`, `sessions.confirmDeleteSingleDesc`).
- The confirm's async handler sets a busy flag/`confirmLoading` and toasts the result.
- Optimistic UI that follows a confirmation must revert on failure and show the failure — `Settings.tsx` launch-at-login toggle reverts `setLaunchAtLogin(!checked)` in the catch block; `Console.tsx` `handleDetailMode` reverts the switch if `proxy.setDetailMode` rejects.

---

## Feedback and Notices

- Success toasts after the server acknowledges the change (`message.success(t('...'))`), not before.
- The ⌘R path reports "nothing to refresh" via `message.info(t('common.nothingToRefresh'))` instead of silently doing nothing.
- Window-level notices (`UpdateBanner`, `MigrationModal`) live in `App.tsx` and are driven by `app.checkUpdate()` (polled 5 s after mount, then at most once per 24 h on visibility change) and the `app:migrationAvailable` event.
- After import or migration, refresh stores through `reloadMigratedStores()` instead of reloading the WebView (`App.tsx` `MigrationModal`, `pages/Settings.tsx` import flow) — reloading would discard console history and page state.
- Do not use `window.alert` / `window.confirm`; the codebase uses antd `message`, `Modal`, and `Popconfirm` exclusively.

---

## Checklist for a New Page

- [ ] Shared data comes from stores; page-scoped data uses local state with a stale-response guard.
- [ ] Loading, empty, and error states each have a visible treatment (`Spin`, `Empty`, toast + `console.error` / inline retry).
- [ ] Loader registered with `usePageRefresh`; it does not save drafts or repeat destructive actions.
- [ ] Polling intervals are cleared on unmount and do not flash the full-page spinner.
- [ ] Destructive actions confirm with translated copy and revert optimistic UI on failure.
- [ ] Strings added to both locales; colors from `theme.useToken()`.
