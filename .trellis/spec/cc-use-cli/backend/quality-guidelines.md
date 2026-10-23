# Quality Guidelines

## Product boundary: launch entry, not a management CLI

`crates/cc-use-cli/src/lib.rs` and `guides/CLI.md` state the scope: the CLI starts Claude Code / Grok Build in the current terminal and configures the status line. Instance switching, usage, and statistics live in the GUI. The help-surface test (`public_help_only_exposes_launch_commands`) pins the absence of `switch`, `usage`, and `ls`.

Before adding a command, ask whether it belongs in the GUI or the daemon's management API. A terminal launch is CLI; anything that lists or mutates existing instances/usage is not.

## Forbidden patterns

| Pattern | Why | Instead |
| --- | --- | --- |
| Renaming `[[bin]] cc-use-cli` to `cc-use` | Collides with the Tauri app binary (`src-tauri` package `cc-use`), breaks `externalBin` staging | Keep the artifact name; users invoke the `/usr/local/bin/cc-use` symlink |
| Exposing a new public subcommand casually | Help is a tested contract; the product scope is two launch commands | `#[command(hide = true)]` + a deliberate docs/help-test change |
| Adding `--json` / `--quiet` / global format flags | No machine-output contract exists; statusline is the only structured output | Define the contract in a task first (see [Output and Format](./output-and-format.md)) |
| SQL or `rusqlite` calls in `cmds.rs` | Schema ownership is `cc_use_lib::db`; app/CLI would diverge | Add a `Database` method in `src-tauri/src/db/` |
| Duplicating launch/session/wrapper logic | The library version is shared with GUI launches and is tested | Call `terminal::prepare_cli_terminal_launch` |
| Starting/stopping the daemon or calling `/_management/*` | The app supervises the daemon; the wrapper performs lifecycle calls | Keep the port probe; use the generated wrapper |
| Raw-mode terminal manipulation outside `RawTerminal` | Leaves the user's terminal broken on early return | Use `RawTerminal` / `stty` restore in `Drop` |
| `unwrap()` / `expect()` on user input or I/O | A panic is worse than an error message; terminal is left in raw mode | Return `CliError`; keep invariants explicit |
| Printing key values, full session tokens, or the management token | Violates `SECURITY.md` | Print provider name + `key_label` alias/id only |
| Inferring the instance from the current directory | Two managed windows can share a project | Read `CC_USE_INSTANCE_ID` |

## Required patterns

- clap definition lives only in `lib.rs`; command bodies live only in `cmds.rs`; `main.rs` stays a one-liner.
- `cmds.rs` is organized by domain with section comments: `// ── launch (cc-use claude / cc-use grok) ──`, `// ── statusline ──`, `// ── install ──`, `// ── setup-statusline ──`. Put new code in the matching section; only command entry points are `pub`, helpers stay private.
- Exit codes go through `CliError` (`Failed` = 1, `NeedsChoice` = 2); `process::exit` only in `run()`.
- User-facing strings are Chinese and actionable; errors carry what failed and what to do next.
- Reuse `format::tokens` / `format::ellipsize` for display widths instead of byte slicing or ad-hoc rounding.
- Statusline output paths must never fail the Claude Code session; degrade to the documented fallbacks.
- Keep the dependency budget thin (`Cargo.toml`: `cc_use_lib`, `clap`, `serde`, `serde_json`, `chrono`, `dirs`). The CLI ships inside the app bundle; add a dependency only if the library cannot provide the behavior.

## Code review checklist

- [ ] Is the change inside the CLI's scope (launch entry + statusline + install), or should it be a GUI/daemon feature?
- [ ] Does the help surface stay unchanged unless intentional? Are hidden commands still hidden?
- [ ] Does data access go through `cc_use_lib`, with no SQL in this crate?
- [ ] Are all failure paths `CliError` messages (Chinese, actionable) with the right exit code?
- [ ] Any new `unwrap`/`expect`/panic on user input or I/O?
- [ ] Does everything printed avoid key values / full tokens?
- [ ] Are display strings built with `format::ellipsize` (char-aware) and the documented precisions?
- [ ] For statusline changes: did you assert the exact lines under `NO_COLOR=1` and keep every error path non-fatal?
- [ ] For install/symlink changes: are `cmds::install` and `src-tauri/src/commands/cli_tool.rs` still consistent, and is the `Cargo.toml` binary name untouched?
- [ ] Did you update `guides/CLI.md` (and `CHANGELOG.md`) for user-visible changes?

## Verification

```bash
cargo test -p cc-use-cli
cargo clippy -p cc-use-cli --all-targets
cargo fmt --all -- --check
```

CI runs `cargo fmt --all -- --check` and `cargo test --workspace` (`.github/workflows/ci.yml`); `CONTRIBUTING.md` additionally expects clippy to be clean.
