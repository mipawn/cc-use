# Frontend Development Guidelines

> Conventions for the React 18 + TypeScript renderer of CC Use (`src/`). Every rule below is taken from the current codebase; citations name the file and symbol that demonstrate it.

---

## Layer Positioning

`cc-use` is one Trellis package (`.trellis/config.yaml` → `packages.cc-use.path: src-tauri`) with two spec layers:

| Layer | Source root | Spec entry |
|---|---|---|
| backend | `src-tauri/` — Tauri commands, SQLite, proxy | [Backend Guidelines](../backend/index.md) |
| frontend | `src/` — this layer | this directory |

Inside `src/`:

- `src/renderer/**` — everything the WebView runs: pages, components, hooks, stores, the API bridge, locales, styles. Entry: `index.html` → `src/renderer/main.tsx` → `src/renderer/App.tsx`.
- `src/shared/types/index.ts` — the TypeScript half of the Rust↔TS data contract. It has no imports (verified: only types, constants, and pure helpers) and is mirrored by `src-tauri/src/models/mod.rs` structs carrying `#[serde(rename_all = "camelCase")]`.
- The frontend reaches the backend through `src/renderer/api/index.ts` (`getApi()`), which wraps Tauri `invoke()`; the few direct `@tauri-apps/*` exceptions are listed in [API Bridge](./api-bridge.md#known-drift-verify-before-trusting). When a backend command or response shape changes, the frontend `Api` layer changes in the same commit — see [API Bridge](./api-bridge.md).

---

## Guides

| Guide | Covers | Read when |
|---|---|---|
| [Directory Structure](./directory-structure.md) | Layer split, dual-mode bootstrap, unified navigation, placement and naming | starting any task |
| [API Bridge](./api-bridge.md) | Typed IPC, fixture injection, Desktop operations, scoped statistics and precise Console reads | touching startup, Tauri commands or shared payloads |
| [State Management](./state-management.md) | Zustand store conventions, loading/error shape, what stays local, the console external store | adding shared data or a store |
| [i18n](./i18n.md) | zh/en pairing, key naming, `useTranslation`, known drift and gaps | adding any user-facing string |
| [UI and Styling](./ui-and-styling.md) | antd v6 theming, CSS modules, Tailwind, design tokens, shared component inventory | building or changing UI |
| [Data and UX Patterns](./data-and-ux.md) | loading / empty / error / retry, refresh registry, confirmations, toasts, polling | writing a page or async flow |
| [Observation Contract](./observation-contract.md) | URL ledger scopes, SQL-before-pagination, precise Console projection and clear generation | changing statistics filters, request handoff, retained request lookup |
| [Resource Routing](./resource-routing.md) | client/gateway eligibility, contextual creation, explicit apply, stable drafts, quota ownership and independent model policy | changing route selection, resource creation or quota presentation |
| [Testing and Quality](./testing-and-quality.md) | vitest layout, mocking, real coverage, lint/format/typecheck gates | writing tests or preparing a commit |

Shared thinking guides live under `.trellis/spec/guides/`: [Code Reuse](../../guides/code-reuse-thinking-guide.md), [Cross-Layer](../../guides/cross-layer-thinking-guide.md).

---

## Pre-Development Checklist

- [ ] Confirm the change belongs to this layer: UI, renderer state, i18n, styles live in `src/`; command bodies, SQL, proxy behavior follow [Backend Guidelines](../backend/index.md).
- [ ] Search before adding: use content/import searches to check existing helpers in `components/common/`, `utils/`, and `hooks/`; confirm current consumers before deleting a component (see [Directory Structure](./directory-structure.md)).
- [ ] Pick the destination with the decision table in [Directory Structure](./directory-structure.md#where-new-code-goes).
- [ ] If the change needs backend data, check the live command signature in `src-tauri/src/commands/*.rs` and the matching member of `Api` in `src/renderer/api/types.ts` before writing UI.
- [ ] If the change adds user-visible text, plan edits to both `src/renderer/locales/zh.ts` and `src/renderer/locales/en.ts` (they are not currently in full sync — see [i18n](./i18n.md)).
- [ ] If the page loads data, register its loader with `usePageRefresh` (see [Data and UX Patterns](./data-and-ux.md)).
- [ ] If the change adds a test, follow the naming and jsdom conventions in [Testing and Quality](./testing-and-quality.md).
- [ ] For contracts that cross Rust ↔ TS, read [Cross-Layer Thinking Guide](../../guides/cross-layer-thinking-guide.md) first.

---

## Quality Check

From the repo root:

```bash
pnpm tsc --noEmit      # same as pnpm typecheck; strict, must be 0 errors
pnpm lint              # eslint src; must stay at 0 errors
pnpm test              # vitest run + node --test scripts/*.test.mjs
```

Formatting is Prettier (`singleQuote`, `jsxSingleQuote`, `semi: false`, `trailingComma: 'all'`, `printWidth: 100`). Format and check touched files; do not reformat unrelated legacy files just to eliminate repository-wide drift.

Targeted runs while iterating:

```bash
pnpm exec vitest run src/renderer/pages/Statistics.test.tsx
pnpm exec vitest run src/renderer/api src/shared
```

CI (`.github/workflows/ci.yml`, job `frontend`) runs `pnpm typecheck`, `pnpm lint`, and `pnpm test` on every PR.

The integrated redesign gate on 2026-11-15 passed typecheck and lint without warnings. Do not add warnings; rerun the commands rather than relying on historical test or formatting counts.

Definition of done for a frontend change:

- typecheck and lint pass, relevant vitest files pass;
- zh and en locales updated together;
- no new hardcoded user-facing strings;
- no new direct `invoke()` / `@tauri-apps/api` import outside `src/renderer/api/` (existing exceptions are documented in [API Bridge](./api-bridge.md));
- data-loading pages register a `usePageRefresh` loader.
