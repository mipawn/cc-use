# Testing

## Integration tests: `crates/cc-use-cli/tests/commands.rs`

Two styles live side by side.

### Binary-level (real process)

```rust
let mut child = Command::new(env!("CARGO_BIN_EXE_cc-use-cli"))
    .arg("statusline")
    .env("HOME", task_home.path())
    .env("NO_COLOR", "1")
    .env_remove("CC_USE_INSTANCE_ID")
    .current_dir(task_home.path())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .expect("run statusline");
```

Use this style when the behavior depends on the real process: stdin parsing, stdout layout, ANSI/`NO_COLOR`, environment variables, and the database the process opens from `HOME`.

- `CARGO_BIN_EXE_cc-use-cli` is the only supported way to locate the binary (the artifact is `cc-use-cli`, not `cc-use`). It is available only in integration tests.
- Set `HOME` to a `tempfile::tempdir()` so `Database::new()` resolves inside the test. The statusline child finds the DB at `$HOME/Library/Application Support/<com.mipawn.cc-use[.dev]>/data/cc-use.db`; `statusline_shows_only_the_current_instances_last_request` builds that path with the same `cfg!(debug_assertions)` branch the library uses.
- Set `NO_COLOR=1` and assert `!text.contains('\x1b')` whenever you assert on rendered text.
- Always assert `output.status.success()`, `output.stderr.is_empty()` (statusline must be silent), line counts, and exact substrings — not just "contains something".

### Library-level (`Ctx::with_db`)

```rust
let mut temp = TempDb::new();
let _fixture = seed(temp.db.as_ref().unwrap(), "claude_code");
let ctx = Ctx::with_db(temp.take(), Some(std::env::temp_dir().join("...")));
let error = cmds::launch(&ctx, "claude_code").expect_err("must require an interactive choice");
assert_eq!(error.code(), 2);
```

`Ctx::with_db` sets `interactive = false` and `verify_daemon = false`, which is exactly what makes `cmds::launch` testable without a TTY or a running daemon. This is the preferred style for command-flow logic:

- `TempDb` creates `Database::open_at` in a temp path and removes the DB plus `-wal`/`-shm` sidecars in `Drop`.
- `seed(db, cli_type)` creates a provider, two API keys (`alpha`, `bravo`), and a project through `cc_use_lib` DB methods.
- Assert the error variant via `error.code()` and `error.message()`, and assert side effects (`managed_instance_list_active()` stays empty).

Tests may seed tables with raw SQL when there is no convenient DB helper (the statusline fixture inserts `proxy_sessions`, `managed_instances`, and `request_logs` directly to control timings). That is test-only; product code must go through `cc_use_lib` (see [Data Access](./data-access.md)).

## Current coverage map

| Test | Pins |
| --- | --- |
| `statusline_refreshes_cache_rate_from_each_payload` | cache formula per payload, `Cache —` vs `0.0%`, two-line unmanaged layout, `NO_COLOR` |
| `statusline_shows_only_the_current_instances_last_request` | `CC_USE_INSTANCE_ID` identity (no cwd inference), third line speed/TTFT, `—` fallbacks |
| `public_help_only_exposes_launch_commands` | help output exposes only `claude`/`grok`; listed internal commands stay hidden |
| `launch_without_tty_lists_routes_and_exits_two` | non-TTY selection → exit 2 with the route list, no instance created |
| `launch_with_no_compatible_keys_fails_with_guidance` | empty compatible list → exit 1 with client name in the message |

Unit tests in `cmds.rs` cover the pure pieces: `parse_statusline_input`, `cache_hit_percentage` (all three counts required, zero vs unavailable), `context_meter` thresholds, the non-bold palette, `instance_short_code`, `prefer_logical_dir`, `RawTerminal` reading `/dev/tty`, project context/prelaunch resolution, and the statusline directory precedence/heading rules. `format.rs` tests pin `tokens` and `ellipsize`.

## What a change must cover

- New/changed subcommand: help-surface test (visibility) + at least one behavior/exit-code test. If the command is interactive, add a `Ctx::with_db` test for the non-interactive path.
- Launch changes: extend `Ctx::with_db` tests; never invoke `cc-use claude` in a test (it `exec`s the real client).
- Statusline changes: parser unit test + child-process render test with an exact line/segment assertion and a `NO_COLOR` run.
- Formatting changes: `format.rs` unit tests.
- Filesystem-installing changes (`install`, `setup-statusline`): do not write to `/usr/local/bin` or the real `~/.claude` from tests. Extract a helper that takes the target path and test it against a temp dir; the existing code hardcodes `INSTALL_PATH = "/usr/local/bin/cc-use"`, so `install` currently has no direct test — if you touch it, introduce the seam first.

## Commands

```bash
cargo test -p cc-use-cli
cargo test -p cc-use-cli --test commands
cargo test -p cc-use-cli statusline           # filter by name
```

The integration tests build and spawn the real binary, so a test run fails if `[[bin]]` or clap wiring is broken. For manual checks:

```bash
./target/debug/cc-use-cli --help
echo '{}' | NO_COLOR=1 ./target/debug/cc-use-cli statusline
```

Running `cc-use claude` manually requires the dev daemon and a real terminal; it starts a client, so treat it as a manual smoke test, not CI.
