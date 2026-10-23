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
| [Directory Structure](./directory-structure.md) | Layer split, folder map, where new code goes, naming rules | starting any task |
| [API Bridge](./api-bridge.md) | `Api` interface, `buildApi()`, command/argument pairing, events, contract test | touching Tauri commands, IPC, or backend response types |
| [State Management](./state-management.md) | Zustand store conventions, loading/error shape, what stays local, the console external store | adding shared data or a store |
| [i18n](./i18n.md) | zh/en pairing, key naming, `useTranslation`, known drift and gaps | adding any user-facing string |
| [UI and Styling](./ui-and-styling.md) | antd v6 theming, CSS modules, Tailwind, design tokens, shared component inventory | building or changing UI |
| [Data and UX Patterns](./data-and-ux.md) | loading / empty / error / retry, refresh registry, confirmations, toasts, polling | writing a page or async flow |
| [Testing and Quality](./testing-and-quality.md) | vitest layout, mocking, real coverage, lint/format/typecheck gates | writing tests or preparing a commit |

Shared thinking guides live under `.trellis/spec/guides/`: [Code Reuse](../../guides/code-reuse-thinking-guide.md), [Cross-Layer](../../guides/cross-layer-thinking-guide.md).

---

## Pre-Development Checklist

- [ ] Confirm the change belongs to this layer: UI, renderer state, i18n, styles live in `src/`; command bodies, SQL, proxy behavior follow [Backend Guidelines](../backend/index.md).
- [ ] Search before adding: `grep -r "<Symbol>" src/renderer` — the repo already has overlapping helpers in `components/common/`, `utils/`, and `hooks/`, and several unreferenced components (listed in [Directory Structure](./directory-structure.md)).
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

Formatting is Prettier (`singleQuote`, `jsxSingleQuote`, `semi: false`, `trailingComma: 'all'`, `printWidth: 100`) but is not CI-gated: `pnpm format:check` currently reports 107 unformatted files. Format only the files you touch with `pnpm exec prettier --write <files>`; do not repo-wide reformat in an unrelated change.

Targeted runs while iterating:

```bash
pnpm exec vitest run src/renderer/pages/Statistics.test.tsx
pnpm exec vitest run src/renderer/api src/shared
```

CI (`.github/workflows/ci.yml`, job `frontend`) runs `pnpm typecheck`, `pnpm lint`, and `pnpm test` on every PR.

Observed state when these guidelines were written: `pnpm tsc --noEmit` clean; `pnpm lint` 0 errors with 3 pre-existing `react-hooks/exhaustive-deps` warnings (`src/renderer/components/keys/ModelEditorView.ts:23`, `src/renderer/components/keys/ModelMappingEditor.tsx:285`). Do not add new warnings.

Definition of done for a frontend change:

- typecheck and lint pass, relevant vitest files pass;
- zh and en locales updated together;
- no new hardcoded user-facing strings;
- no new direct `invoke()` / `@tauri-apps/api` import outside `src/renderer/api/` (existing exceptions are documented in [API Bridge](./api-bridge.md));
- data-loading pages register a `usePageRefresh` loader.
