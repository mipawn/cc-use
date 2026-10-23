# Output and Format

## Streams

| Stream | Content | Why |
| --- | --- | --- |
| stdout | Command results the caller consumes: the launch instance line (`实例 <label>  <provider> · <key>`), `install`/`setup-statusline` confirmation lines, and the statusline payload | `statusline` stdout is read by Claude Code; launch stdout is what the user sees after selection; keeping it clean lets future wrappers parse it |
| stderr | Errors (`run()` prints `error.message()`), the interactive route picker (`draw_key_picker`), picker confirmation (`✓ provider key`), and terminal-control sequences | The picker must not pollute stdout, and errors must survive stdout redirection |

Rules:
- Never print progress or diagnostics to stdout in `statusline`; any extra line changes the rendered bar.
- Errors from `cmds` are printed once, by `run()`, not by the command body. Command bodies return `CliError`.
- `println!` for results, `eprintln!` for interactive UI and errors. The only batched terminal redraw is the picker's `eprint!` output on stderr.

## Numeric formatting (`format.rs`)

The CLI never uses locale-dependent units (the desktop app switches 万/亿 by locale; the CLI always uses K/M/B because terminal output is often read next to other tooling — see the module comment).

- `format::tokens(i64)` — `0`–`999` verbatim; then `K`/`M`/`B`; scaled values `< 10` keep one decimal (`9.9K`), larger values drop decimals (`12K`, `850M`); negatives recurse on the absolute value and keep the sign. Pinned by `formats_thousands_millions_billions`, `formats_negative_numbers`.
- `format::ellipsize(&str, max_chars)` — character-count based (safe for Chinese), returns the input unchanged when short, otherwise keeps `max_chars - 1` characters and appends `…`. Pinned by `ellipsize_cuts_long_strings`, `ellipsize_is_char_aware`.

Widths used at call sites are part of the visual contract: provider 24/18, key 28/20, model 20, git branch 22, directory 24. Reuse the helper instead of ad-hoc slicing (byte slicing would panic or split a Chinese character).

Statusline numbers use fixed precision: `{:.0}%` context, `{:.1}%` cache, `{:.1} tok/s`, `{:.2}s` TTFT. Keep these exact formats; tests and `guides/CLI.md` quote them.

## No machine-readable mode

There is no `--json`, `--quiet`, `--verbose`, or output-format flag, and no table rendering. The CLI is an interactive launch entry, and its machine-readable contract is intentionally limited to:

- the statusline text protocol consumed by Claude Code, and
- exit codes.

Adding a JSON mode is a product change, not a refactor: it needs a task, a documented schema, and a decision about which commands it applies to. Do not add one while fixing an unrelated command.

## Colors

- Only two helpers emit ANSI: `cmds::picker_color` (launch picker) and `cmds::ansi` (statusline).
- Both honor `NO_COLOR` by presence (`std::env::var_os("NO_COLOR").is_some()`), returning uncolored text.
- Tests run with `NO_COLOR=1` and assert the absence of `\x1b` in stdout.
- Do not add color to ordinary command output (install messages, errors); those must stay safe in non-TTY pipes.

## Help and version

- `cc-use --help` exits `0`, writes to stdout, and lists only the public commands: `claude` and `grok`. Hidden variants (`statusline`, `setup-statusline`, `install`) are excluded by clap because of `#[command(hide = true)]`.
- `disable_help_subcommand = true` means `cc-use help` is not a command.
- `cc-use --version` exits `0` and prints the `cc-use-cli` crate version (`0.1.0`), not the app version.
- Clap usage errors (unknown subcommand, missing value) print to stderr and exit with clap's default error code `2`, which overlaps numerically with `CliError::NeedsChoice`. Do not document clap's code as a cc-use semantic.

## Exit codes

The crate calls `std::process::exit` only in `lib.rs::run()` (clap may exit on its own for parse/help/version):

| Code | Source | Meaning |
| --- | --- | --- |
| 0 | `Ok(())` from a command; clap `--help`/`--version` | success |
| 1 | `CliError::Failed` | local service down, no compatible route, launch failure, install/config failure |
| 2 | `CliError::NeedsChoice` | ambiguous or non-interactive choice (route list, cancelled picker, third-party statusLine needs `--force`); also clap usage errors |

The table is mirrored in `guides/CLI.md`; update both if the mapping changes. See [Errors and Exit Codes](./errors-and-exit-codes.md) for when to choose each variant.

## Secrets

Output may include provider names, key aliases or ids (`key_label`), instance labels (last 8 chars of the session token), file paths, and app/CLI versions. It must never include:

- API key values (`ApiKey::value`),
- full session tokens (`session-*`),
- the management token (`~/.cc-use/state/management-token`).

`install` and `setup_statusline` print absolute paths, which is fine; `launch` prints only alias/id. Keep it that way when adding output (`SECURITY.md`).
