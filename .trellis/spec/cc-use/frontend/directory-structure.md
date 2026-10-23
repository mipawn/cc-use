# Directory Structure

> How the CC Use frontend is organized, and where each kind of new code belongs.

---

## Layer Scope

This layer covers `src/` only. It is the frontend half of Trellis package `cc-use` (`.trellis/config.yaml` → `packages.cc-use.path: src-tauri`); the Rust half is documented in [Backend Guidelines](../backend/index.md).

| Path | Ownership | Rule |
|---|---|---|
| `src/renderer/**` | renderer (WebView) | all UI, state, styling, i18n |
| `src/shared/types/index.ts` | Rust ↔ TS contract | no imports; mirrored by `src-tauri/src/models/mod.rs` (`#[serde(rename_all = "camelCase")]`) |
| `index.html` | shell | loads `/src/renderer/main.tsx` |

Boot order (do not reorder casually):

1. `src/renderer/main.tsx` — installs `installRendererConsoleTap()` and `installConsoleStore()` **before** rendering, imports `./locales` and `./styles/global.css` for their side effects, then wraps `<App />` in `StyleProvider layer` → `ConfigProvider` (locale + `createWorkspaceTheme`) → `AntdApp` (`message={{ maxCount: 3, top: 60 }}`).
2. `src/renderer/App.tsx` — `HashRouter` → `AppErrorBoundary` → shell (`Sidebar`, `TitleBar`, `<main>` with `UpdateBanner`, `MigrationModal`, `<Routes>`).
3. Pages own their data loading; nothing is prefetched at boot except settings (`initSettings`) and console history. `App.tsx` additionally schedules an update check 5 s after mount (`UpdateBanner`).

---

## Directory Map

Counts are current as of writing (`find src -type f`).

| Directory | Files | Purpose | Representative file |
|---|---|---|---|
| `src/renderer/pages/` | 12 page components, 5 test files, 7 CSS modules | Route-level screens and embedded tabs | `pages/Statistics.tsx`, `pages/Keys.tsx` |
| `src/renderer/components/<domain>/` | 8 domains, 75 files | UI grouped by feature: `apiKeys/`, `common/`, `dashboard/`, `keys/`, `launchpad/`, `layout/`, `providers/`, `usage/` | `components/providers/ProviderModal.tsx` |
| `src/renderer/stores/` | 4 stores, `reloadStores.ts`, 1 test | Zustand domain stores | `stores/providerStore.ts` |
| `src/renderer/api/` | 5 modules + `__tests__/` | Tauri bridge and process-long external stores | `api/index.ts`, `api/consoleStore.ts` |
| `src/renderer/hooks/` | 5 hooks | Reusable React behavior | `hooks/usePageRefresh.ts` |
| `src/renderer/utils/` | 13 modules + 8 tests | Pure formatters/mappers and a few API-touching helpers | `utils/formatTokens.ts`, `utils/modelMapping.ts` |
| `src/renderer/locales/` | `zh.ts`, `en.ts`, `index.ts`, 1 test | i18next resources | `locales/zh.ts` |
| `src/renderer/styles/` | `global.css`, `design-tokens.css`, `workspaceTheme.ts` | Global CSS, CSS variables, antd theme | `styles/workspaceTheme.ts` |
| `src/renderer/assets/` | SVG icons, license | Icons and provider marks | `assets/provider-icons/*.svg` |
| `src/renderer/types/global.d.ts` | 1 file | Declares `window.api: Api` for type extraction only | see [API Bridge](./api-bridge.md) |
| `src/shared/types/` | `index.ts`, 2 tests | Cross-layer types and helpers | `src/shared/types/index.ts` |

`src/renderer/components/keys/ModelEditorView.ts` is not a component: it exports the `useModelEditorActions` hook. Treat non-`.tsx` files under `components/` as feature logic, not shared primitives.

---

## Where New Code Goes

| You are adding… | Put it in | Follow this existing example |
|---|---|---|
| A new screen | `src/renderer/pages/<Name>.tsx` + a `<Route>` in `App.tsx` | `pages/Settings.tsx` + `<Route path='/settings' ...>`; `pages/Sessions.tsx` shows the embedded-tab variant |
| A client workspace entry | `components/layout/workspaceNavigation.tsx` (`clientWorkspaces`) + a route | `/claude-code`, `/grok-build` entries |
| A component used by one feature | `components/<domain>/` matching the page/feature name | `components/keys/KeyEditModal.tsx` |
| A primitive used by several pages | `components/common/` | `components/common/RoutePickerModal.tsx` used by `pages/Projects.tsx` and `components/launchpad/TakeoverConfigTab.tsx` |
| Shared server data or mutations | `stores/<entity>Store.ts` exporting `use<Entity>Store` | `stores/providerStore.ts` |
| A new Tauri call | `api/types.ts` (`Api`) **and** `api/index.ts` (`buildApi`) and a case in `api/__tests__/index.contract.test.ts` | see [API Bridge](./api-bridge.md) |
| A process-long external store (not Zustand) | `src/renderer/api/` | `api/consoleStore.ts`, `api/consoleBus.ts` |
| Reusable React behavior | `src/renderer/hooks/use<Name>.ts` | `hooks/usePageRefresh.ts`, `hooks/useServiceStatus.ts` |
| A pure formatter/mapper | `src/renderer/utils/<name>.ts` + colocated `<name>.test.ts` | `utils/formatTokens.ts` + `utils/formatTokens.test.ts` |
| A type that Rust also returns | `src/shared/types/index.ts` + the matching `src-tauri/src/models/mod.rs` struct | `Provider`, `ApiKey`, `Project` |
| A renderer-only type | the owning module next to the code that uses it | `ClientCatalog` in `utils/modelMapping.ts`, consumed by `api/types.ts` |
| User-facing text | `locales/zh.ts` **and** `locales/en.ts` | see [i18n](./i18n.md) |
| Page/component styling | `<Name>.module.css` next to the component | 30 modules, e.g. `pages/Keys.module.css` |
| Global utility class or theme variable | `styles/global.css` / `styles/design-tokens.css` | `.page-container`, `--surface-elevated` |

---

## Naming and Import Conventions

- **Pages/components:** PascalCase file, `export default function Name(...)`. Extra named exports are allowed when a helper needs testing or reuse — `pages/Keys.tsx` exports `computeProviderReorder`, `components/common/RoutePickerModal.tsx` exports `getRouteModelLabel`.
- **Modules:** camelCase (`pageRefresh.ts`, `workspaceTheme.ts`, `utils/accountQuery.ts`). Hooks are `useX.ts`; stores are `<entity>Store.ts` exporting `use<Entity>Store`.
- **CSS modules:** `<Component>.module.css`, imported as `import styles from './X.module.css'`, class names camelCase (`styles.pageHeader`, `styles.statCard`).
- **Tests:** `X.test.ts` (logic/contract), `X.component.test.tsx` (DOM component), `X.query.test.tsx` (page interaction), `__tests__/` for modules with several test files. Details in [Testing and Quality](./testing-and-quality.md).
- **Imports:** use the `@shared/types` alias for cross-layer types (67 imports, e.g. `stores/providerStore.ts`); inside `src/renderer` use relative paths. `tsconfig.json` and `vite.config.ts` define `@renderer`, but no file uses it — do not introduce a second style.
- **Code style:** prettier (`singleQuote`, `jsxSingleQuote`, `semi: false`, `trailingComma: 'all'`, `printWidth: 100`) and eslint (`quotes: single`, `semi: never`, `react-hooks` recommended rules). Type-only imports use `import type`.

---

## Anti-Patterns and Traps

1. **Do not import `@tauri-apps/*` or call `invoke()` outside `src/renderer/api/`.** A few files break this today (config-takeover pages, native dialogs in `pages/Settings.tsx`, the migration event in `App.tsx`) and are listed in [API Bridge](./api-bridge.md#known-drift-verify-before-trusting); new code must go through `getApi()`.
2. **Do not assume every file under `components/` is live.** These are currently imported by nothing (verified with `grep -rn "from '.*<Name>'" src`): `components/providers/ProviderCard.tsx`, `components/keys/KeyDetailModal.tsx`, `components/apiKeys/ApiKeyList.tsx`, `components/dashboard/DropZone.tsx`, `components/dashboard/NewProjectModal.tsx`, `components/dashboard/RecentProjects.tsx`, `components/launchpad/ProviderKeyCard.tsx`. `components/dashboard/MonthCalendar.module.css` has no matching component. Read them for reference, but check with a search before reusing and prefer the live files listed in [UI and Styling](./ui-and-styling.md#live-shared-components).
3. **Do not add page-local state to stores.** Filters, pagination, dialog visibility, and drafts stay in the page (see [State Management](./state-management.md)).
4. **Do not edit only one locale file.** A missing key renders the raw key in the UI (i18next default) and falls back to Chinese when `en` lacks it, because `fallbackLng` is `'zh'` in `locales/index.ts`.
5. **Do not duplicate backend response shapes inline.** Prefer a shared type; when that is not possible, keep the shape in `api/types.ts` and mirror it in Rust in the same change.
6. **Do not remove the boot-time console installs** in `main.tsx` — `installRendererConsoleTap()` / `installConsoleStore()` must run before React so startup logs are captured.
