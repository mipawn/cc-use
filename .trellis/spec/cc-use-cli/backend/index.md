# cc-use-cli — Backend Development Guidelines

> The terminal launch entry. Read this before touching `crates/cc-use-cli/`.

## What lives here

`crates/cc-use-cli/` builds the `cc-use-cli` artifact, installed as the `cc-use` command. It launches Claude Code or Grok Build in the terminal it was invoked from, configures the Claude Code status line, and installs the `/usr/local/bin/cc-use` symlink. It is deliberately **not** a management CLI: instance switching, usage, and statistics live in the GUI (`crates/cc-use-cli/src/lib.rs` module docs, `guides/CLI.md`).

## Source map

| Source | Responsibility |
| --- | --- |
| `crates/cc-use-cli/src/main.rs` | three-line entry: `cc_use_cli::run()` |
| `crates/cc-use-cli/src/lib.rs` | clap `Cli` / `Command`, dispatch, process exit |
| `crates/cc-use-cli/src/cmds.rs` | `Ctx`, `CliError`, all command bodies and helpers |
| `crates/cc-use-cli/src/format.rs` | `tokens` (K/M/B) and `ellipsize` display helpers |
| `crates/cc-use-cli/tests/commands.rs` | binary-level and `Ctx::with_db` integration tests |
| `crates/cc-use-cli/Cargo.toml` | `[lib] cc_use_cli`, `[[bin]] cc-use-cli`, dependency budget |

## Guidelines index

| Guideline | Use it when |
| --- | --- |
| [Command Surface](./command-surface.md) | adding/changing a subcommand, flag, or help output; the `cc-use` vs `cc-use-cli` naming rule |
| [Launch Flow](./launch-flow.md) | changing `cc-use claude` / `cc-use grok`, route selection, the picker, or project resolution |
| [Statusline](./statusline.md) | changing the Claude Code status line payload, layout, colors, or degradation |
| [Output and Format](./output-and-format.md) | deciding stdout vs stderr, human formatting, `NO_COLOR`, help/version, exit codes |
| [Data Access](./data-access.md) | reading settings/projects/keys or writing launch state |
| [Errors and Exit Codes](./errors-and-exit-codes.md) | user-facing failures, message language, exit code mapping |
| [Testing](./testing.md) | writing or extending CLI tests |
| [Quality Guidelines](./quality-guidelines.md) | review checklist, forbidden patterns, required patterns |

Shared library conventions: [cc-use backend guidelines](../../cc-use/backend/index.md). The process the CLI talks to indirectly (via port probe and the generated wrapper) is described in [cc-use-daemon backend guidelines](../../cc-use-daemon/backend/index.md). Cross-package reasoning: [thinking guides](../../guides/index.md).

## Pre-Development Checklist

1. Read [Command Surface](./command-surface.md). Decide whether the change is a new command (needs clap wiring + help test), a flag on an existing one, or internal behavior.
2. Check `guides/CLI.md` — it is the user-facing contract (commands, statusline behavior, exit-code table); behavior changes must update it and `CHANGELOG.md`.
3. Confirm data access goes through `cc_use_lib` (`Database`, `terminal::prepare_cli_terminal_launch`, `statusline_config`) — the CLI has no SQL of its own (see [Data Access](./data-access.md)).
4. If the change affects the status line, re-read [Statusline](./statusline.md); its output is consumed by Claude Code, and failures must degrade silently.
5. Keep user-facing messages in Chinese, matching the existing command bodies, and never print key values or tokens.
6. Add tests following [Testing](./testing.md); the help-surface test pins which internal commands must stay hidden, so adjust it only for a deliberate visibility change.

## Quality Check

Run from the repository root:

```bash
cargo test -p cc-use-cli
cargo clippy -p cc-use-cli --all-targets
cargo fmt --all -- --check
```

Smoke-check the public surface (only `claude` and `grok` may appear):

```bash
cargo build -p cc-use-cli
./target/debug/cc-use-cli --help
./target/debug/cc-use-cli --version
```

If the change touches the launch/wrapper contract, also run the app-side tests that own it:

```bash
cargo test -p cc-use --test terminal_launch_preview
```

If it touches how the CLI binary is staged into the bundle, verify the sidecar build path instead of guessing: `scripts/cargo-build.mjs` stages `src-tauri/binaries/cc-use-cli-<target-triple>` for `tauri.conf.json`'s `externalBin`.
