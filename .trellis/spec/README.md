# Project Spec — CC Use

> Engineering conventions for this repository, written to be read by AI agents and humans
> before changing code. Scaffolded by `trellis init`, then filled from the real codebase on
> 2026-10-23. Treat this directory as code: if a rule stops matching the source, fix the rule
> in the same change.

---

## What lives where

| Path | Covers | Entry point |
|------|--------|-------------|
| `cc-use/backend/` | Rust in `src-tauri/` — Tauri app, commands, SQLite, proxy core, services, shared runtime | [`cc-use/backend/index.md`](./cc-use/backend/index.md) |
| `cc-use/frontend/` | React + TypeScript in `src/` — pages, components, stores, API bridge, i18n, styles | [`cc-use/frontend/index.md`](./cc-use/frontend/index.md) |
| `cc-use-daemon/backend/` | `crates/cc-use-daemon` — data-plane sidecar: axum management API, launchd lifecycle, console stream | [`cc-use-daemon/backend/index.md`](./cc-use-daemon/backend/index.md) |
| `cc-use-cli/backend/` | `crates/cc-use-cli` — the installed `cc-use` CLI: clap command surface, output, exit codes | [`cc-use-cli/backend/index.md`](./cc-use-cli/backend/index.md) |
| `guides/` | Stack-agnostic thinking guides (cross-layer, code reuse). **Always included** in AI context | [`guides/index.md`](./guides/index.md) |

Package and layer names come from `.trellis/config.yaml` → `packages:`. Layer directories are
whatever subdirectories exist under `spec/<package>/` (except `guides`). Verify the loaded
set with:

```bash
python3 ./.trellis/scripts/get_context.py --mode packages
```

The three Rust crates are one product split into three processes, so their specs are meant
to be read together: `cc-use/backend/architecture.md` describes the process topology and
states which logic must live in the Tauri-free `shared_runtime` zone.

---

## How specs reach an AI session

1. A task directory holds `implement.jsonl` / `check.jsonl` manifests with one
   `{"file": ".trellis/spec/...", "reason": "..."}` entry per relevant spec file.
2. The platform hook injects the task's `prd.md` plus those spec files into the
   implement/check sub-agent prompts.
3. `guides/` is treated as shared context and included everywhere.
4. When a task has no manifest yet, the agent is expected to read the matching layer's
   `index.md` first and follow its links.

Adding a spec file is therefore not enough on its own — reference it from the task manifest
with `python3 ./.trellis/scripts/task.py add-context <task> implement <file> <reason>`.

---

## Keeping it current

- New pattern worth remembering → add it to the matching layer file (or a new topic file
  linked from that layer's `index.md`). Project-wide insight → `guides/`.
- Post-bug lessons → the `trellis-break-loop` skill: root cause, why past fixes failed,
  prevention rule.
- Capture during/after implementation → the `trellis-update-spec` skill.
- Keep `index.md` tables in sync with the actual file list. Quick check:

```bash
for f in .trellis/spec/*/*/*.md; do
  d=$(dirname "$f"); b=$(basename "$f")
  [ "$b" = "index.md" ] && continue
  grep -q "$b" "$d/index.md" || echo "unlisted: $f"
done
```

- Do not dump temporary task info here. Specs hold durable rules only.

---

## Reusing this spec tree in other projects

The spec directory is plain Markdown, so it can be sourced from a shared git repository and
refreshed with the native Trellis registry mechanism. The registry source points at a
repository whose **root is the spec tree** (the contents become `.trellis/spec/`).

```text
mipawn/trellis-specs/          # registry repo root
├── README.md
├── guides/                    # always included, portable across project shapes
├── backend/                   # single-repo-style layers, if you want them shared
└── frontend/
```

Wire a project to it by putting this in `.trellis/config.yaml`:

```yaml
registry:
  spec:
    source: gh:mipawn/trellis-specs   # or gitlab:… / https://… / git@…
```

Then `trellis update` refreshes hash-tracked spec files from that source, while files you
added locally (e.g. `spec/cc-use/…` in this monorepo project) are left untouched. Local edits
to registry files surface as the normal "modified by you" conflict prompt instead of being
silently overwritten. New single-repo projects can bootstrap straight from it:
`trellis init --registry gh:mipawn/trellis-specs`.

Practical rules learned the hard way:

- **Monorepo vs single-repo shape.** In a monorepo project, package specs must live under
  `spec/<package>/<layer>/`; root-level layers are only listed for single-repo projects.
  `guides/` is the one directory that is always included in both shapes — that is the safe
  place for conventions you want in every project.
- **Project-specific content stays local.** Package names, module maps, file paths and
  anti-patterns from this repo generalize badly; keep them here and share only the portable
  rules.
- **Changing registry templates does not delete stale files** — `trellis update` adds and
  updates, it never removes spec files that disappeared upstream. Clean those up manually.
- No registry, no problem: the same tree can be a git submodule or symlink (e.g.
  `.trellis/spec/guides` → a shared checkout). Nothing in Trellis touches `.trellis/spec`
  unless `registry.spec` is configured.

---

**Language:** English, with Chinese domain terms quoted as-is where they name product
concepts (they appear throughout the code and UI).
