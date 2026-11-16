# Isolated fixture preview / 隔离预览

This is a development-only renderer with synthetic data. It is **not** a Tauri or daemon integration test. Nothing here proves that a real desktop client restarted, accepted a configuration, or reached a provider.

## Start

From the repository root, use the dedicated configuration:

```bash
VITE_CC_USE_FIXTURE=1 pnpm exec vite --config src/renderer/dev/vite.config.ts --host 127.0.0.1 --port 15173 --strictPort
```

Open `http://127.0.0.1:15173/`. Do not use the daemon ports, `tauri dev`, or `dev:daemon` for this preview. Stop the owned preview process with Ctrl+C when finished.

Both `import.meta.env.DEV` and `VITE_CC_USE_FIXTURE === '1'` are required. A URL parameter alone cannot activate fixtures; production builds cannot enable them. The dedicated config rejects build mode and missing flags. Do not bypass it with the ordinary Vite config.

## Select a scenario

Put `scenario` in the document query **before the hash route**, then reload:

```text
http://127.0.0.1:15173/?scenario=empty#/keys
http://127.0.0.1:15173/?scenario=error#/stats
http://127.0.0.1:15173/?scenario=partial#/desktop?client=codex
http://127.0.0.1:15173/?scenario=stale#/keys
```

| Scenario                          | Operation / expected observation                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` (omitted)               | Overview: today plus more than two years of ledger dates; 70 requests today split across resources and pages. Instances: mixed Claude/Grok, legacy `claude`, same-directory instances, active/stale/stopped/failed history. Keys: USD, CNY account windows, tokens, unknown, exhausted, disabled and long names. |
| `empty`                           | No providers, keys, instances, gateway, ledger or Console history. Create a provider/key locally and return to route selection. Desktop begins official.                                                                                                                                                         |
| `error`                           | Main resource, ledger, instance, desktop and Console reads fail with explicit synthetic errors; mutations fail. Settings/status stay available so navigation remains usable. Retry remains failed until another scenario is selected and reloaded.                                                               |
| `partial`                         | Switch a desktop route: route updated but configuration write fails, with typed `partial` and recovery text. Edit a currently bound key: save succeeds but desktop state reports `key_edit` synchronization failure. Console clear succeeds for app logs but retains daemon logs.                                |
| `stale`                           | Quota timestamps are five days old, and the first active instance is stale. Refresh uses the fixture snapshot, not a network query.                                                                                                                                                                              |
| `routeOnly`                       | Switch a desktop route: `configChanged=false`, `nextAction=none`; previous configuration-change guidance remains in the subsequent state read.                                                                                                                                                                   |
| `configChanged`                   | Apply a desktop route: `configChanged=true`, `nextAction=reopen_client`; no claim of an actual restart. Restore also requests reopening.                                                                                                                                                                         |
| `failed`                          | Local mutations reject without changing the seeded state; reads remain usable.                                                                                                                                                                                                                                   |
| `official`, `notFound`, `unknown` | Separate typed desktop starting states.                                                                                                                                                                                                                                                                          |
| `quotaError`                      | Refresh quota after a successful save: synthetic query failure, previous cache retained. Account quota cannot be queried as an independent key quota.                                                                                                                                                            |
| `consoleError`, `consoleEmpty`    | Precise retained-request/history reads fail, or return no records, respectively.                                                                                                                                                                                                                                 |

Unknown scenario names throw rather than silently showing the default data. Each full reload creates a new fixture: providers, keys, desktop facts, gateways, settings, Console clear generation, and other API mutations live **only in memory**. Route navigation and repeated state reads retain mutations within that page session; cross-reload backend durability is not simulated. Browser-only language/theme preferences may remain in localStorage on this isolated preview origin.

## Useful checks

- Today has both usage-bearing successes and zero-token failures. Overview request/failed links must preserve their different populations. Scope a provider or instance, paginate, and confirm totals/rows never fall back to all resources.
- `request-1` is retained in Console history but lies outside the global newest 500 records. Open `http://127.0.0.1:15173/#/console?requestId=request-1` or follow its ledger detail link. Exact lookup finds it; after clear it disappears and the generation changes.
- Change gateway route without changing model policy. The selected catalog retains `legacy-missing-model` rather than broadening to all models.
- All model queries, quota queries and settings changes are synthetic. Native file dialogs, real export/import, CLI installation/launch, daemon restart, external opening, and other unimplemented operations intentionally fail closed. Their buttons are **not** integration-tested by this preview.

In browser DevTools, diagnostics are available without printing credentials:

```js
window.__CC_USE_FIXTURE__.scenario
window.__CC_USE_FIXTURE__.violations // expected [] for supported journeys
window.__CC_USE_FIXTURE__.calls // namespace.method names only
```

The green `FIXTURE` badge changes to a red alert for isolation violations. Synthetic scenario errors are ordinary expected API errors, not isolation violations. A violation from an unknown method means the journey is not implemented; do not add a real-API fallback to make it pass.

Live Console events can be injected explicitly into the in-memory event source:

```js
window.__CC_USE_FIXTURE__.emit({
  category: 'log',
  id: 'manual-fixture-event',
  timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
  level: 'info',
  source: 'app',
  target: 'fixture',
  message: 'Synthetic live event',
})
```

## Isolation design and tests

- The entrypoint installs the fixture and transport guards before dynamically importing console modules, stores or App. Renderer log persistence and the real migration listener are skipped in fixture mode.
- `getApi()` refuses requests before fixture installation and never merges/falls back to the real implementation. Unknown namespaces, methods and inherited-property lookups throw and are recorded.
- Fetch permits only GET/HEAD of allowlisted preview-origin static assets, without credentials or redirects. Dedicated-server CSP prohibits external scripts, images, frames, workers and connections; server proxies are empty.
- WebSocket permits only the matching preview-origin `/__fixture_hmr` path with the `vite-hmr` protocol, plus the `vite-ping` restart probe on that identical endpoint **with an empty query**. Vite 6 still tries its socket with `hmr:false`, so the dedicated HMR channel is explicitly configured rather than producing false isolation violations. Its client opens a new `vite-ping` socket after clearing the URL query when the dev server restarts; both the installed source and browser diagnostics confirmed this behavior. Other sockets, XHR, EventSource, workers, beacon, external navigation and native form submission methods are blocked. Local React form controls and href-less pagination remain usable; submit events cannot perform native navigation.
- An existing native bridge prevents installation. Native Tauri global getters/setters throw, including when the **actual** Tauri core `invoke()` is called. This is a regression tripwire for trusted renderer code, not a general-purpose sandbox for hostile JavaScript.

```bash
pnpm exec vitest run src/renderer/dev
pnpm typecheck
pnpm exec eslint src/renderer/dev src/renderer/main.tsx src/renderer/api/index.ts
```

The tests cover gate combinations, early store loading, native invoke rejection, browser transport boundaries, unknown API rejection, per-fixture state independence, scenario outcomes, scoped pagination/populations, gateway policy preservation, and retained Console lookup/clear behavior. Browser-level journey validation and native temporary-directory integration tests remain separate responsibilities.

### Form and visual fidelity

- Create boundaries own the generated identity. Real form payloads can contain `id: undefined` or a stale ID despite TypeScript input declarations; neither may replace a generated Provider/Key ID.
- Editing a saved Key mounts a read-only `terminal.getLaunchPreview` consumer. Its fixture DTO contains only fixed `.invalid` URLs, fake tokens and a comment-only command; never echo a stored key, user environment, executable command or real path. Launch/file/process mutations remain unsupported and fail closed.
- Enabled query configurations and scheme DTOs must satisfy the same saved-form validation as production. Validate changing only an alias and saving; an attractive quota snapshot alone does not establish a valid editable fixture.
- After changing fixture-origin `language`/`themeMode` localStorage, use `page.reload()` or a distinct document query, not same-document hash navigation. Verify rendered text and `html[data-theme]` before taking evidence. Wait for the next paint after changing viewport metrics.
- Inspect the actual screenshot, not only horizontal overflow. At 900×700, confirm the route picker's action footer is inside the viewport while dense resource lists scroll locally. Await the visible incoming modal after transitions; attached outgoing/hidden dialog nodes are not evidence of the active editor.
