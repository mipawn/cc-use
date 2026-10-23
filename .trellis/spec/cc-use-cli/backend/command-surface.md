# Command Surface

## Dispatch path

```text
crates/cc-use-cli/src/main.rs      main() -> cc_use_cli::run()
crates/cc-use-cli/src/lib.rs       clap parse -> match Command -> cmds::* -> process::exit
crates/cc-use-cli/src/cmds.rs      command bodies; no argv parsing
```

`lib.rs` owns the clap definition and the only `std::process::exit` (`run() -> !`). `cmds.rs` functions receive typed arguments and return `Result<(), CliError>`. Do not parse `std::env::args()` anywhere else.

## The real commands

`Command` in `lib.rs` derives `clap::Subcommand`; variant names become kebab-case subcommands.

| Subcommand | Variant | Visibility | Handler |
| --- | --- | --- | --- |
| `cc-use claude` | `Command::Claude` | public | `Ctx::open()` then `cmds::launch(&ctx, "claude_code")` |
| `cc-use grok` | `Command::Grok` | public | `Ctx::open()` then `cmds::launch(&ctx, "grok")` |
| `cc-use statusline` | `Command::Statusline` | hidden (`#[command(hide = true)]`) | `cmds::statusline()` |
| `cc-use setup-statusline` | `Command::SetupStatusline` | hidden | `cmds::setup_statusline(force)` or `cmds::restore_statusline()` |
| `cc-use install` | `Command::Install` | hidden | `cmds::install()` |

There is no default subcommand and no global flags: `cc-use` without a subcommand is a clap usage error. `disable_help_subcommand = true` removes `help` as a subcommand; `--help`/`--version` still work through clap.

`setup-statusline` has two boolean flags: `--force` (overwrite a third-party `statusLine`, after backing up `~/.claude/settings.json`) and `--restore` (remove cc-use's `statusLine`). `--restore` wins when both are passed (`lib.rs` dispatch order). There are no positional arguments in any command today.

`--version` prints the CLI crate's version (`cc-use-cli` 0.1.0 from `Cargo.toml`), not the desktop app's version (`src-tauri/tauri.conf.json`). Do not use it to detect the app version.

## Hidden vs public is a tested contract

`crates/cc-use-cli/tests/commands.rs::public_help_only_exposes_launch_commands` runs `--help` and asserts that `statusline`, `setup-statusline`, `install`, `switch`, `usage`, and `ls` do **not** appear. Adding a new visible command is therefore a deliberate product decision: update `guides/CLI.md`, the help test, and `CHANGELOG.md` in the same change. Hidden commands exist for integrations: `statusline` is invoked by Claude Code itself; `setup-statusline` and `install` are the terminal equivalents of the app's status-line and command-line-tool settings.

Rule: when adding a command that is not part of the public launch entry, put `#[command(hide = true)]` on the variant and extend the help test's hidden-name list.

## Binary naming gotcha (do not rename)

`crates/cc-use-cli/Cargo.toml` declares:

```toml
[lib]
name = "cc_use_cli"

# The installed command is `cc-use`, but the build artifact must not collide
# with the Tauri app binary, which is also named `cc-use`. `cc-use install`
# symlinks /usr/local/bin/cc-use to this artifact inside the app bundle.
[[bin]]
name = "cc-use-cli"
```

Consequences:

- The build artifact is `target/<profile>/cc-use-cli`, while the user-facing command is `cc-use`. `tauri.conf.json` lists `binaries/cc-use-cli` in `externalBin`, and `scripts/cargo-build.mjs` stages it as `src-tauri/binaries/cc-use-cli-<target-triple>`; Tauri then bundles it as `Contents/MacOS/cc-use-cli`.
- Never rename the `[[bin]]` to `cc-use`: it would collide with the desktop app binary produced by `src-tauri/src/main.rs` (package `cc-use`) and break the bundle layout.
- The clap display name is intentionally `cc-use` (`#[command(name = "cc-use", ...)]`), so help text and usage read `cc-use ...` even though the artifact is `cc-use-cli`.
- The global command is a symlink `/usr/local/bin/cc-use` → the bundled `Contents/MacOS/cc-use-cli` (or `target/debug/cc-use-cli` in dev). Two writers create it: `cmds::install()` in this crate (`std::os::unix::fs::symlink`, `INSTALL_PATH`) and the app's `src-tauri/src/commands/cli_tool.rs` (`cli_tool_install`, via `osascript ... with administrator privileges`). Both use the same path constant; a change must touch both.
- Integration tests must spawn `env!("CARGO_BIN_EXE_cc-use-cli")`, never a hardcoded `cc-use` path.

## Adding a subcommand

1. Add the variant to `enum Command` in `lib.rs` with a doc comment (it becomes the help description) and `#[command(hide = true)]` if it is not public.
2. Add flags with `#[arg(long)]` / `#[arg(short, long)]`; prefer flags over positional arguments for anything optional.
3. Dispatch in `run()` to a `pub fn` in `cmds.rs` returning `CmdResult` (`Result<(), CliError>`).
4. Put the implementation in the matching `// ── <domain> ──` section of `cmds.rs` (see [Quality Guidelines](./quality-guidelines.md)); keep helpers private.
5. Decide the exit code contract: `CliError::Failed` (1) vs `CliError::NeedsChoice` (2) — see [Errors and Exit Codes](./errors-and-exit-codes.md).
6. Update `tests/commands.rs`: a help-surface assertion for visibility, and behavior tests for the new path.

Do not add `--json` or an output-mode flag. The CLI has no machine-readable command output today; the only machine-consumed output is the status line, which Claude Code parses as text (see [Output and Format](./output-and-format.md)).

## Relationship to the v4 design doc

`docs/v4.0.0/design/cli.md` describes a not-yet-implemented redesign, marked "未开发" in the document itself: a default `cc-use` entry, `--outlet <id>` selection, `--` passthrough, removal of Grok/statusline/install commands. The current code is the v3.14.x launch entry documented here. Do not implement from that design doc without an explicit task; if the redesign starts, this spec must be rewritten in the same change.
