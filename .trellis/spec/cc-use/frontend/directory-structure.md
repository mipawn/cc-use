# Directory Structure

> Where the live CC Use renderer belongs. Do not use deleted project-launch screens or historical file counts as architectural evidence.

## Layer Scope

This frontend layer covers `src/`; the paired Rust package is described by [Backend Guidelines](../backend/index.md).

| Boundary | Ownership / rule |
| --- | --- |
| `src/renderer/**` | WebView UI, state, styling, i18n and the renderer API bridge |
| [Shared types](../../../../src/shared/types/index.ts) | Cross-layer payloads; mirror the owning Rust serializer, usually [models](../../../../src-tauri/src/models/mod.rs), or the domain module such as [Desktop commands](../../../../src-tauri/src/commands/desktop_connection.rs) |
| [HTML shell](../../../../index.html) | Loads the renderer entrypoint; not an API injection mechanism |

## Boot Order: Native and Fixture

The boundary in [main.tsx](../../../../src/renderer/main.tsx) is intentional:

1. Statically import only React, ReactDOM and [fixture mode](../../../../src/renderer/dev/mode.ts). The gate is exactly `import.meta.env.DEV && import.meta.env.VITE_CC_USE_FIXTURE === '1'`.
2. **Fixture only:** dynamically import [fixture bootstrap](../../../../src/renderer/dev/bootstrap.ts); install transport/native guards and inject the complete fixture API before evaluating App, stores or Console modules. A fixture call before injection throws; there is no real-API fallback.
3. Install the renderer Console tap. **Native/ordinary mode only:** install the persistence bridge. Install the process-long Console store in both modes; fixture history and events still go through the injected API.
4. Dynamically import App, settings, locales, styles and UI providers. Render `StyleProvider layer` → `ConfigProvider` (locale/theme) → `AntdApp` → App inside React StrictMode. The root initializes settings; page owners load their own data.
5. [App](../../../../src/renderer/App.tsx) installs `HashRouter` → error boundary → shell, update banner, migration modal and routes. The migration listener is skipped in fixture mode. Update checks use `getApi()` after the existing delay, so fixtures receive synthetic results.

Ordinary native mode does **not** install a `window.api` implementation: [getApi](../../../../src/renderer/api/index.ts) lazily builds/caches the Tauri adapter. The ambient [global declaration](../../../../src/renderer/types/global.d.ts) is not runtime injection. See [API Bridge](./api-bridge.md).

Use only the dedicated development fixture server documented in the [fixture README](../../../../src/renderer/dev/README.md). A full page reload resets synthetic backend state; a fixture preview does not prove native file persistence or that an external client restarted.

## Live Navigation and Screen Ownership

[Sidebar](../../../../src/renderer/components/layout/Sidebar.tsx) is capability-based, not four client-specific workspaces:

| Route | Live owner / responsibility |
| --- | --- |
| `/` | [Dashboard](../../../../src/renderer/pages/Dashboard.tsx): observation overview, retained activity heatmap/daily statistics and scoped drill-downs |
| `/instances` | [InstancesPage](../../../../src/renderer/pages/InstancesPage.tsx): CLI-managed Claude Code/Grok instances, route switching, active/history views; clients are launched by CLI, not by GUI project management |
| `/desktop` | [DesktopPage](../../../../src/renderer/pages/DesktopPage.tsx): Codex/Claude Desktop typed connection facts and explicit apply/restore operations |
| `/keys` | [Keys](../../../../src/renderer/pages/Keys.tsx): shared provider/key resources and their configuration |
| `/gateway` | [GatewayPage](../../../../src/renderer/pages/GatewayPage.tsx): gateway access points; a standalone navigation row, not nested under observation |
| `/stats`, `/console` | [Statistics](../../../../src/renderer/pages/Statistics.tsx) and [Console](../../../../src/renderer/pages/Console.tsx), under [ActivityPage](../../../../src/renderer/pages/ActivityPage.tsx); scope-preserving ledger/detail/Console journeys |
| `/settings` | [Settings](../../../../src/renderer/pages/Settings.tsx): application and native integration settings |

[workspaceNavigation](../../../../src/renderer/components/layout/workspaceNavigation.tsx) retains client metadata and `legacyWorkspaceTarget`, not top-level sidebar entries. Old `/claude-code` and `/grok-build` URLs redirect to `/instances?client=...`; `/codex` and `/claude-desktop` redirect to `/desktop?client=...`. Only the helper's allowlisted public observation fields survive; credentials and obsolete launch parameters do not. Supported legacy sessions/history views are preserved by that helper. Unknown routes return to `/`.

The old `ClaudeCodePage`, `CodexPage`, `ClaudeDesktopPage`, `Projects`, and dashboard `DropZone`/`NewProjectModal`/`RecentProjects` implementations were removed. Do not describe them as live code, restore GUI project launch flows, or copy their former direct native calls.

## Where New Code Goes

Avoid fixed file counts; routing/imports are the authority for liveness.

| Directory / boundary | New code belongs here | Live example |
| --- | --- | --- |
| `src/renderer/pages/` | Route-level screens and embedded observation/session views | [DesktopPage](../../../../src/renderer/pages/DesktopPage.tsx) |
| `src/renderer/components/<domain>/` | Feature UI and its local logic; common primitives only when actually shared | [RoutePickerModal](../../../../src/renderer/components/common/RoutePickerModal.tsx), [KeyEditModal](../../../../src/renderer/components/keys/KeyEditModal.tsx) |
| `src/renderer/stores/` | Shared authoritative resource data/mutations, not modal drafts | [providerStore](../../../../src/renderer/stores/providerStore.ts), [providerModelCatalogStore](../../../../src/renderer/stores/providerModelCatalogStore.ts) |
| `src/renderer/api/` | Typed Tauri bridge, Console bus/store/persistence, page-refresh registry | [API implementation](../../../../src/renderer/api/index.ts), [consoleStore](../../../../src/renderer/api/consoleStore.ts) |
| `src/renderer/hooks/` | Reusable React lifecycle and request projection behavior | [usePageRefresh](../../../../src/renderer/hooks/usePageRefresh.ts), [useConsoleRequestProjection](../../../../src/renderer/hooks/useConsoleRequestProjection.ts) |
| `src/renderer/utils/` | Pure parsers, formatters and mappings with colocated tests | [observationContext](../../../../src/renderer/utils/observationContext.ts), [clientSupport](../../../../src/renderer/utils/clientSupport.ts) |
| `src/renderer/dev/` | Dev-only fixtures, fail-closed isolation, dedicated Vite config and tests | [fixture API](../../../../src/renderer/dev/fixtureApi.ts), [isolation](../../../../src/renderer/dev/isolation.ts) |
| `src/renderer/locales/` | Both languages for every visible message | [Chinese](../../../../src/renderer/locales/zh.ts), [English](../../../../src/renderer/locales/en.ts) |
| `src/renderer/styles/` | Global CSS/tokens and antd theme; local styling stays beside its owner | [workspaceTheme](../../../../src/renderer/styles/workspaceTheme.ts) |
| `src/renderer/assets/` | Bundled icons and provider marks | [app icon](../../../../src/renderer/assets/icon.svg) |
| `src/shared/types/` | Shared contracts, not renderer-owned transport guesses | [types](../../../../src/shared/types/index.ts) |

A new API requires the interface, bridge implementation, contract test and owning Rust command/serializer to agree. A new resource-binding consumer must use [Resource Routing](./resource-routing.md), not its own nested select or creation flow. A new observation link must use [Observation Contract](./observation-contract.md).

## Naming and Import Conventions

- PascalCase pages/components; hooks `useX.ts`; camelCase helpers; domain stores export `use<Entity>Store`.
- CSS modules live beside their component and use camelCase classes. Non-TSX feature logic may remain under components, e.g. [ModelEditorView](../../../../src/renderer/components/keys/ModelEditorView.ts).
- Use `import type` and `@shared/types` for shared contracts; renderer-to-renderer imports stay relative.
- Colocate logic/contract and DOM interaction tests; see [Testing and Quality](./testing-and-quality.md).
- Follow the repository Prettier/ESLint configuration, not a new per-feature style.

## Anti-Patterns and Traps

1. Do not add direct `invoke()` to pages. The only current non-bridge production plugin imports are native dialogs in Settings and App's migration event listener; see the explicit exceptions in [API Bridge](./api-bridge.md#known-drift-verify-before-trusting).
2. Do not initialize stores/App through a static import ahead of fixture injection, install native persistence in fixture mode, or merge fixture and real API namespaces.
3. Do not infer liveness from an old spec inventory. Trace current imports/routes before reusing a component; deleted screens are not examples.
4. Keep filters, pagination, modal visibility and drafts local. Ordinary page refresh preserves these; hard WebView reload is explicit fault recovery and discards them.
5. Do not recreate per-client navigation silos or GUI project management. Secondary client selection belongs inside Instances/Desktop; history metadata is not a launch affordance.
6. Preserve Console installation before React, both locale updates, and the shared payload/serializer contract.
