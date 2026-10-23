# CC Use — Backend (Rust / Tauri) Guidelines

> Coding guidance for package `cc-use`: the Rust backend under `src-tauri/` (Tauri main
> process, proxy core, SQLite layer, terminal launching, tray). The sidecar crates have
> their own spec layers: `.trellis/spec/cc-use-daemon` and `.trellis/spec/cc-use-cli`.
> Read this layer before touching any `.rs` file in `src-tauri/` or the shared library the
> sidecars link against.

Every file here is grounded in the current source; each rule cites the file and usually
the symbol it came from. When the code disagrees with a rule, fix the rule (or the code) in
the same change — do not let the spec drift.

---

## Guides

| Guide | Purpose (one line) | When to read |
|-------|--------------------|--------------|
| [architecture.md](./architecture.md) | Three-process topology, module map, boot sequence, state/management-token/console contracts, `shared_runtime` ownership, Tauri-free zone | Before any change; always when adding a module or moving logic between app/daemon/CLI |
| [tauri-commands.md](./tauri-commands.md) | Adding/changing an IPC command: file, `invoke_handler!`, capabilities, managed state, typed inputs, `*_inner` pattern, events, frontend `Api` pairing | Any `src-tauri/src/commands/*.rs`, `lib.rs` handler list, or `src/renderer/api/*` change |
| [database.md](./database.md) | rusqlite conventions, table modules, the ALTER-only migration rule, keychain lift, transactions, retention, query rules | Any `db/` change, schema field, migration, or data cleanup |
| [data-model-contract.md](./data-model-contract.md) | `models/mod.rs` ↔ `src/shared/types/index.ts` camelCase contract, null-vs-absent, stringly-typed enums, what breaks when one side changes | Any DTO/field/payload change that crosses IPC or export files |
| [proxy-core.md](./proxy-core.md) | `proxy/handler.rs` request pipeline, route selection, model/header shaping, SSE/WS, usage accounting, concurrency, side-effect boundaries | Any request-path work, provider routing, usage/statistics attribution, or daemon behavior |
| [errors-and-logging.md](./errors-and-logging.md) | Error type/`Result` conventions per layer, typed errors, message rules, `app_logger`/daemon logger, log levels, secret redaction, console history | Adding error paths, log lines, Console events, or debugging production issues |
| [quality-and-testing.md](./quality-and-testing.md) | Test layout and fixtures, how to run tests, what is intentionally untested, quality gate, forbidden patterns, review checklist | Before writing tests, before committing, and during code review |
| [index.md](./index.md) | This navigation file: guide map, pre-development checklist, quality-check commands | Start here, then open the guide for your change |

Related generic thinking guides (project-wide, not layer-specific):
[`.trellis/spec/guides/`](../../guides/index.md) — read
`cross-layer-thinking-guide.md` when a change spans Rust/TS, and
`code-reuse-thinking-guide.md` before adding a helper.

---

## Pre-Development Checklist

Run through this before writing backend code:

- [ ] **Which process owns this?** Control plane (Tauri app), data plane (daemon proxy), or
      launch entry (CLI). If more than one needs it, it belongs in `shared_runtime/` and must
      not import `tauri` ([architecture.md](./architecture.md)).
- [ ] **Which layer?** command / `*_inner` / `db` / `service` / `proxy` / `shared_runtime`.
      Business logic does not live in `#[tauri::command]` wrappers
      ([tauri-commands.md](./tauri-commands.md)).
- [ ] **Is it an IPC change?** The five places (command, registration, `Api` type,
      `buildApi`, UI) form one atomic change, plus a capability entry only when a plugin API
      is newly used, together with the TS model mirror.
- [ ] **Is it schema/data?** New column → ALTER + CREATE + SELECT/mapper/INSERT + Rust model
      + TS type + fixtures. Data rewrite → marker-guarded transaction
      ([database.md](./database.md)).
- [ ] **Is it request-path?** Check the handler order, console/metrics side effects, and the
      “no DB lock across `.await`” rule ([proxy-core.md](./proxy-core.md)).
- [ ] **Can it leak a secret?** Any log line, error string, console event, export, or client
      config write: apply the `SECURITY.md` red lines before writing the code
      ([errors-and-logging.md](./errors-and-logging.md)).
- [ ] **How will it be tested?** Pick the layer: inline `#[cfg(test)]` for pure logic,
      `src-tauri/tests/` with `TempDb` for DB/proxy behavior, `tempfile` for user-file
      operations ([quality-and-testing.md](./quality-and-testing.md)).
- [ ] **Does it need a CHANGELOG entry?** Yes for user-visible behavior (`CONTRIBUTING.md`).
- [ ] **Scope check:** no changes outside the area you were asked to touch; new dependencies
      are a design decision, not an implementation detail.

---

## Quality Check

From the repo root, before committing (CI runs a subset — see
[quality-and-testing.md](./quality-and-testing.md)):

```bash
# Rust formatting (CI enforces this exact command)
cargo fmt --all -- --check

# Rust compile / lint / tests
cd src-tauri && cargo build && cargo clippy && cargo test --workspace
# or, from the repo root:
cargo test --workspace        # same as: pnpm test:rust

# Frontend, when IPC types or UI changed
pnpm typecheck                # tsc --noEmit
pnpm lint
pnpm test

# Spec integrity: every guide exists and is linked from this index
ls .trellis/spec/cc-use/backend
for f in .trellis/spec/cc-use/backend/*.md; do
  grep -q "$(basename "$f")" .trellis/spec/cc-use/backend/index.md || echo "unlisted: $f"
done
```

Rules of thumb for a green review:

- Every new Rust symbol on the IPC path is mirrored in TypeScript and reachable from the
  renderer’s `Api`.
- Every schema change is idempotent on an already-upgraded database.
- Every failure is a returned error with a human-readable message; no `unwrap()` on user data.
- No secret appears in a log, error, console event, export file, or client config.
- Daemon behavior and Tauri behavior still come from the same `shared_runtime` / `proxy`
  code, not two copies.

---

**Language**: All documentation in this directory is written in **English**. Chinese domain
terms and existing code comments are quoted as-is where they name product concepts.
