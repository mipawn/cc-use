# Testing and Quality

> What is actually tested, how tests are written here, and which commands gate a change.

---

## Tooling

| Tool | Config | Notes |
|---|---|---|
| Vitest `^4.0.18` | `vitest.config.ts` | `globals: true`, default environment `node`, `include: ['src/**/*.test.ts', 'src/**/*.test.tsx']` |
| jsdom `^29` | per-file pragma | `// @vitest-environment jsdom` on line 1 (13 files use it) |
| React DOM test rendering | no DOM testing library | `react-dom/client` `createRoot` + `act` |
| Coverage | `@vitest/coverage-v8` | `pnpm test:coverage` |
| eslint `^9` | `eslint.config.js` | flat config, `eslint src` |
| TypeScript `^5.7` | `tsconfig.json` | `tsc --noEmit` |
| Prettier `^3.4` | `.prettierrc.json` | formatting is not CI-gated (see below) |

There is **no E2E/Playwright harness**. `.playwright-mcp/` is a git-ignored local directory of manual MCP browser-session artifacts (screenshots, console logs, page snapshots), and `screenshots/` holds committed product images; neither is a test suite. `package.json` has no Playwright dependency or config.

`pnpm test` = `vitest run` **plus** `node --test` suites for build/release scripts (`scripts/extract-release-notes.test.mjs`, `scripts/cargo-build.test.mjs`). `pnpm test:web` is an alias for `pnpm test`.

---

## Test Layout and Naming

| Pattern | Meaning | Example |
|---|---|---|
| `X.test.ts` / `X.test.tsx` | logic, contract, or page behavior test colocated with source | `utils/formatTokens.test.ts`, `pages/Statistics.test.tsx` |
| `X.component.test.tsx` | renders a component into jsdom | `components/providers/ProviderModal.component.test.tsx` |
| `X.query.test.tsx` | page-level interaction/query behavior | `pages/Keys.query.test.tsx` |
| `__tests__/` | module with several test files | `api/__tests__/index.contract.test.ts`, `shared/types/__tests__/` |

Current inventory: **32 test files, ~105 `it` cases**.

Covered:

- API bridge contract (`api/__tests__/index.contract.test.ts`), console buffer/merge/hydration (`api/consoleStore.test.ts`), page-refresh registry (`api/pageRefresh.test.ts`);
- shared types/helpers: `getClientKindLabel`, `normalizeClientKind`, provider-type config, terminal command generation (`shared/types/__tests__/*`);
- pure utils: `accountQuery`, `apiKeyEditor`, `clientConfig`, `clientSupport`, `formatTokens`, `modelMapping`, `providerIcon`, `providerQueryDefaults`;
- 12 component/logic tests: `ProviderModal`, `KeyEditModal`, `UserAgentField`, `ProviderIcon`, `ProviderUsageWindows`, `AppErrorBoundary`, `DailyModelUsageChart`, `MultiMetricLineChart`, `ResourceUsageModal`, `RoutePickerModal` (model-label logic), `TakeoverConfigTab` reorder helpers, `usageChartColors`;
- locale spot-check (`locales/usageChartLocales.test.ts`);
- pages: `Instances`, `Projects`, `Statistics`, `Keys` (query), `consoleFilters` (helpers exported from `pages/Console.tsx`);
- one store: `providerStore` (`refreshBalance` behavior).

Not covered: `Dashboard`, `Settings`, `Console` rendering, `Sessions`, `ActivityPage`, `ClaudeCodePage`, `CodexPage`, `ClaudeDesktopPage`, layout components (`Sidebar`, `TitleBar`), `apiKeyStore` / `projectStore` / `settingsStore`, most hooks, `claudeConfig` / `formatPerformance` / `modelQueryUserAgent` / `officialProviders` / `userAgentOptions` utils, and full zh/en key parity. Treat typecheck + code review as the safety net there; add tests when changing behavior in those files.

Coverage config includes only `src/renderer/api/**/*.ts`, `src/renderer/pages/**/*.ts`, `src/shared/types/**/*.ts` — the `pages` glob does **not** match `.tsx`, so page components are not instrumented. Widen `coverage.include` if you need measured component coverage.

---

## Writing Tests

**Environment.** DOM tests start with the pragma and stub what antd needs:

```ts
// @vitest-environment jsdom
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
})
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
```

There is no `setupFiles`; each jsdom file declares its own stubs (`ProviderModal.component.test.tsx`, `Statistics.test.tsx`, `Instances.test.tsx` all repeat them). Keep that convention rather than introducing a global setup only for one file.

**Rendering.** `createRoot(container)` + `await act(async () => root.render(...))`, unmount in `afterEach`, then `document.body.innerHTML = ''`. No `@testing-library/react` is installed; assertions query the real DOM (`document.body.querySelector<HTMLInputElement>('input#name')`, `document.body.querySelectorAll('[class*="presetChip"]')`, button lookup by text).

**Mocking the bridge.** Always mock the API module, never Tauri:

```ts
vi.mock('../api', () => ({ getApi: () => apiMock }))
```

Use `vi.hoisted()` for mocks referenced inside the factory, and reset modules when the module under test has singleton state: `vi.resetModules()` then `await import('../index')` (`api/__tests__/index.contract.test.ts`; `api/consoleStore.test.ts` re-imports per hydration test because the buffer is module-level).

Also mock:

- `react-i18next` → `{ useTranslation: () => ({ t: (key: string) => key }) }` so tests assert on keys, not translations;
- `../hooks/useAppMessage` → object of `vi.fn()` toasts;
- stores/components that pull in heavy children (`Keys.query.test.tsx` mocks `ProviderModal` and `useSettingsStore`).

**Assert behavior, not internals.** The API contract test intentionally pins command strings and argument objects (that is the contract). Other tests assert user-visible outcomes: rendered values, toast calls, reorder results, store state transitions (`stores/providerStore.test.ts` asserts the cached usage updates after a valid balance query and is preserved on an invalid one).

No snapshot tests exist; keep it that way unless there is a strong reason.

---

## Commands

```bash
pnpm tsc --noEmit                     # must be 0 errors
pnpm lint                             # must be 0 errors
pnpm test                             # vitest run + script tests
pnpm test:watch                       # interactive vitest
pnpm test:coverage                    # v8 coverage (see include caveat above)
pnpm exec vitest run <path>           # focused run
```

Observed status at spec-writing time:

- `pnpm tsc --noEmit`: clean.
- `pnpm lint`: 0 errors, 3 pre-existing `react-hooks/exhaustive-deps` warnings in `components/keys/ModelEditorView.ts:23` and `components/keys/ModelMappingEditor.tsx:285`. Do not add warnings; fix touched ones when practical.
- `pnpm format:check`: **fails today** (107 files differ; the repo is not Prettier-clean). Prettier is not part of CI or the `CONTRIBUTING.md` gate. Format only the files you touched (`pnpm exec prettier --write <files>`), never a repo-wide rewrite in an unrelated change.

CI (`.github/workflows/ci.yml`, job `frontend`) runs exactly `pnpm typecheck`, `pnpm lint`, `pnpm test`. `CONTRIBUTING.md` asks for `pnpm tsc --noEmit && pnpm lint` plus a CHANGELOG entry for user-visible features.

---

## Quality Rules Specific to This Codebase

- **`tsc` is the first-line contract check.** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are on (`tsconfig.json`). Unused imports/params fail the build — delete them.
- **`Api` and locale edits are type-checked**, not tested: a method missing from `buildApi()` or a locale object missing a group fails `tsc`. That is why the contract test focuses on command strings/args instead.
- **Do not weaken types to make a test pass** (e.g. `as any` in production code) unless unavoidable; test files already use `as never` / `as any` cast helpers where fixtures are partial.
- **No test may call real Tauri IPC.** Mock `@tauri-apps/api/*` (bridge tests) or `../api` (everything else).
- **Clean up DOM state between tests** (`root.unmount()`, `document.body.innerHTML = ''`, `vi.resetAllMocks()`); antd modals portal into `document.body`.
- **Keep helper logic pure so it can be imported under the default `node` environment.** Helpers are exported from page/component modules and exercised without rendering: `computeProviderReorder` (`pages/Keys.tsx`), `eventRowKey`/`isProblemEvent`/`matchesQuery` (`pages/Console.tsx`, imported by `consoleFilters.test.ts`), `getRouteModelLabel` (`RoutePickerModal.tsx`), `reorder.ts`. Do not read `window`/`document` at module scope in modules whose helpers are tested this way.
- **When fixing a bug, add a regression at the lowest level that can express it** (pure helper or contract test) rather than a browser-only check; there is no E2E layer to catch it later.

---

## Manual Verification

For runtime behavior the unit tests cannot cover (Tauri IPC, daemon, native dialogs):

1. `pnpm tauri dev` from the repo root (compiles the daemon sidecar, runs Vite, starts the app) — see `CONTRIBUTING.md`.
2. Open the Console page: renderer `console.*` calls are captured through `api/consoleBus.ts`, so `console.error` from a failed flow is visible in-app without devtools.
3. Re-run `⌘R` on the page to confirm the `usePageRefresh` loader re-reads data without losing filters or drafts.
