# UI and Styling

> antd v6 + design tokens + CSS modules for page structure + a small, deliberate amount of Tailwind.

---

## Stack

| Concern | Choice | Where configured |
|---|---|---|
| Component library | `antd ^6.2.3`, `@ant-design/icons ^6.1.0` | imports in pages/components |
| CSS-in-JS bridge | `@ant-design/cssinjs` `StyleProvider layer` | `src/renderer/main.tsx` |
| Theme | `createWorkspaceTheme(isDark, reducedMotion)` | `src/renderer/styles/workspaceTheme.ts`, passed to `ConfigProvider` |
| Routing | `react-router-dom ^7` `HashRouter` | `App.tsx` |
| Scroll areas | `simplebar-react` | pages and form modals |
| Charts | `recharts 3.5.1` | `components/usage/*.tsx` |
| Drag & drop | `@dnd-kit/*` | `pages/Keys.tsx` (sortable provider tabs) |
| Dates | `dayjs` | `main.tsx` locale effect, formatters |
| Utility classes | Tailwind v4 through `@tailwindcss/postcss` | `postcss.config.js`, `styles/global.css`, `tailwind.config.js` |

---

## Theming

`main.tsx` renders: `StyleProvider layer` → `ConfigProvider locale={zhCN|enUS} theme={createWorkspaceTheme(resolvedTheme === 'dark', reducedMotion)}` → `AntdApp message={{ maxCount: 3, top: 60 }}` → `<App />`.

- `createWorkspaceTheme` defines all shared antd tokens (`colorPrimary: '#1677ff'`, `borderRadius: 8`, `fontSize: 14`, control/card/table/modal component overrides) and switches `theme.darkAlgorithm` for dark mode. Add component-level overrides there, not as ad-hoc CSS overrides.
- `hooks/useAntdTokenSync.ts` mirrors live antd tokens into `--ant-*` CSS variables and sets `document.documentElement.dataset.theme = resolvedTheme`. CSS modules read those variables for antd-colored surfaces.
- Read colors in JSX with `const { token } = theme.useToken()` and use `token.colorPrimary`, `token.colorSuccess`, `token.colorFillTertiary`, etc. Do not introduce new hex colors for themed surfaces.
- `useReducedMotion()` (`hooks/useReducedMotion.ts`) feeds `motion: !reducedMotion` in the theme token; animations must still be optional.
- Exceptions where raw colors are intentional: `styles/design-tokens.css` (the token source), `styles/workspaceTheme.ts` (theme source), `components/usage/usageChartColors.ts` (chart series palette), and `pages/Console.tsx` `PALETTE` (terminal surface deliberately stays dark in both themes; the comment documents this).

## Dark Mode

- Dark mode is driven by `[data-theme='dark']` on `<html>` (set by `useAntdTokenSync`).
- CSS variables: `styles/design-tokens.css` defines `:root` and `[data-theme='dark']` blocks for surfaces, borders, radii, shadows, syntax colors.
- Tailwind is configured `darkMode: ['selector', '[data-theme="dark"]']` (`tailwind.config.js`); prefer CSS variables over `dark:` variants for new surfaces.
- `styles/global.css` also inverts `img[data-monochrome]` in dark mode.

---

## Styling Layers (in order of preference)

1. **antd components + theme tokens.** Most UI is `Card`, `Table`, `Modal`, `Segmented`, `Tabs`, `Tag`, `Spin`, `Empty`, `Result`, `Alert`, `Popconfirm`, `Dropdown`. Prefer props (`variant`, `size`, `type`, `danger`) over custom CSS.
2. **CSS modules.** 30 `*.module.css` files, one per page/component (`pages/Keys.module.css`, `components/providers/ProviderModal.module.css`). Import as `styles`, use camelCase class names. This is the default for layout that antd does not express.
3. **Global utility classes in `styles/global.css`.** `.page-container`, `.page-container-sm`, `.page-header`, `.page-content` are used by the config-takeover pages (`pages/CodexPage.tsx`, `pages/ClaudeDesktopPage.tsx`); other pages use container classes from their own CSS module. Also: `.icon-box`, `.empty-state`, `.rounded-ant`, focus-visible outlines, SimpleBar skinning, native scrollbar hidden, `[data-tauri-drag-region]` rules and antd baseline tweaks (`h2.ant-typography`, `.ant-btn-icon`). Reuse these before writing page-level CSS.
4. **Tailwind utilities, sparingly.** `styles/global.css` bootstraps v4 with `@import 'tailwindcss' source(none); @source '../';` and layer order `reset, theme, base, antd, components, utilities`; `preflight: false` because antd provides the reset; `tailwind.config.js` scans `./src/renderer/**/*.{ts,tsx}` and extends `maxWidth.page = 1200px`, `maxWidth['page-sm'] = 800px`, `borderRadius.ant / ant-lg`. Current usage is small: flex/width/spacing/text plus `!`-important overrides when antd's styles win — `components/providers/ProviderCard.tsx` (`w-full`, `flex items-center gap-1`, `text-xs truncate`, `line-clamp-2`), `pages/Settings.tsx` (`m-0! mb-1!`), `pages/Projects.tsx` (`!m-0 !mb-1`, `text-5xl mb-4`), `pages/Console.tsx` (`justify-between w-full`). Use Tailwind for one-off layout/typography; do not rebuild component surfaces with it.

Do not add a new styling mechanism (styled-components, emotion, SCSS). Do not put raw user-facing colors in JSX; use tokens or CSS variables.

---

## Scrolling and Layout

- The app shell is a CSS-module grid: `components/layout/WorkspaceLayout.module.css` (`shell`, `collapsed`, `main`, `content`), consumed by `App.tsx`.
- Scrollable regions use `<SimpleBar>` with a `className`/`style` from the page module, e.g. `pages/Settings.tsx`, `pages/Projects.tsx`, `pages/Keys.tsx`, `pages/Dashboard.tsx`, `pages/Statistics.tsx`, `components/providers/ProviderModal.tsx`, `components/keys/KeyEditModal.tsx`. Native scrollbars are globally hidden (`global.css`).
- Pages that need a sticky header + scrolling body use `.page-container` → `.page-header` + `.page-content` (see `pages/CodexPage.tsx`); pages with their own module containers follow the same header/content split (e.g. `pages/Dashboard.module.css`).
- Section headings use `aria-labelledby` for accessibility: `pages/Dashboard.tsx` (`id='today-overview-title'`).

---

## Live Shared Components

Reuse these instead of writing a new modal/table/selector. Verify with a grep for the import before extending one.

| Component | Purpose | Live consumers |
|---|---|---|
| `components/common/AppErrorBoundary.tsx` | route-level render-error fallback | `App.tsx` |
| `components/common/ClientIcon.tsx` | per-client glyph | `layout/workspaceNavigation.tsx`, `pages/Keys.tsx`, `pages/Projects.tsx`, `pages/ClaudeCodePage.tsx` |
| `components/common/KeyCascader.tsx` | provider → key tree select | `pages/Projects.tsx` |
| `components/common/RoutePickerModal.tsx` | pick provider + key route, with reorder and model labels (`getRouteModelLabel`) | `pages/Projects.tsx`, `components/launchpad/TakeoverConfigTab.tsx` |
| `components/providers/ProviderIcon.tsx` | provider mark / uploaded icon | `ProviderModal`, `TakeoverConfigTab`, `RoutePickerModal`, `pages/Projects.tsx`, `pages/Keys.tsx` |
| `components/providers/ProviderUsageWindows.tsx` | metering windows/groups, no invented totals | `pages/Keys.tsx` |
| `components/providers/ProviderModal.tsx` | create/edit provider form | `pages/Keys.tsx` |
| `components/providers/GlobalConfigModal.tsx`, `TerminalToolsPanel.tsx` | client settings drawer | `pages/ClaudeCodePage.tsx` |
| `components/keys/KeyEditModal.tsx` | create/edit/duplicate key (`mode` prop) | `pages/Keys.tsx` |
| `components/keys/ModelMappingEditor.tsx` (+ `ModelCatalogManager`, `ModelHelp`, `CodeModelField`, `CodeStartupEditor`, `ModelViewHeader`, `ModelEditorView.ts` hook) | model mapping/catalog UI | `KeyEditModal` |
| `components/usage/ResourceUsageModal.tsx`, `UsageTimeRangePicker.tsx`, `RecentRequestDetailDrawer.tsx` | usage detail, time-range picker, request drawer | `pages/Keys.tsx`, `pages/Statistics.tsx`, each other |
| `components/usage/DailyModelUsageChart.tsx`, `MultiMetricLineChart.tsx`, `usageChartColors.ts` | charts and shared palette (`formatTrendTick` shared export) | `pages/Statistics.tsx`, `ResourceUsageModal` |
| `components/dashboard/UsageHeatmap.tsx` | annual activity heatmap | `pages/Dashboard.tsx` |
| `components/launchpad/TakeoverConfigTab.tsx`, `ConfigPreviewButton.tsx`, `reorder.ts` | config-takeover UI and visible-order helpers | `pages/CodexPage.tsx`, `pages/ClaudeDesktopPage.tsx`, `RoutePickerModal` |
| `components/layout/Sidebar.tsx`, `TitleBar.tsx`, `ServiceStatusPill.tsx`, `workspaceNavigation.tsx` | shell/nav | `App.tsx` (Sidebar, TitleBar); `Sidebar` and `TitleBar` share `clientWorkspaces`; `pages/ClaudeCodePage.tsx` too |
| `components/UserAgentField.tsx` | save/delete custom User-Agent values | `KeyEditModal`, `ModelCatalogManager`, `pages/Keys.tsx` |

Dormant (imported by nothing): `ProviderCard.tsx`, `KeyDetailModal.tsx`, `ApiKeyList.tsx`, `DropZone.tsx`, `NewProjectModal.tsx`, `RecentProjects.tsx`, `ProviderKeyCard.tsx`; `ConfigPreview.tsx` is only imported by the dormant `KeyDetailModal`; `MonthCalendar.module.css` has no component. Read them for patterns but verify before reuse.

---

## Component and Modal Conventions

- **Modals:** controlled by `open: boolean`; callbacks named `onClose` (dismiss) and `onSave` / `onOk` / `onSelect` (commit). Examples: `ProviderModalProps` (`open`, `provider`, `onClose`, `onSave`), `KeyEditModalProps` (`open`, `mode`, `apiKey`, `providers`, `onClose`, `onSave`), `RoutePickerModalProps` (`open`, `onCancel`, `onSelect`).
- **Reset form state on close:** form modals set `destroyOnHidden` — `ProviderModal.tsx:226`, `KeyEditModal.tsx:396`, `RoutePickerModal.tsx:196`, `ResourceUsageModal.tsx:192`, `GlobalConfigModal.tsx:142`, `ConfigPreviewButton.tsx:61`, `Settings.tsx:810`, `RecentRequestDetailDrawer.tsx:37`.
- **Async confirm buttons:** use `confirmLoading` / `okButtonProps` — `App.tsx` migration modal (`confirmLoading={migrating}`), `KeyEditModal.tsx:383-384`, `ProviderModal.tsx:224`, `Settings.tsx:186` (`danger` ok button). Long operations show progress (`Settings.tsx` update `Progress`).
- **Context-aware confirm:** inside nested async flows use `Modal.useModal()` and render the context holder (`Keys.tsx:146` `confirmModal` + `confirmContextHolder`) instead of the static `Modal.confirm`.
- **Icon-only buttons get a `Tooltip`** with a translated label (`pages/Keys.tsx` action bar). Destructive actions use `danger` + `Popconfirm`.
- **Empty states** use `Empty` with `PRESENTED_IMAGE_SIMPLE` or a table `locale={{ emptyText: t('...') }}`, not custom markup (`TakeoverConfigTab.tsx`, `Statistics.tsx`, `ResourceUsageModal.tsx`).
