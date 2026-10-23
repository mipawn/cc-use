# Data Access

The CLI is a thin client of `cc_use_lib`. It has no SQL of its own: `crates/cc-use-cli/src/cmds.rs` calls `Database` methods and library helpers, never `rusqlite`.

## Database

- Open with `Database::new()` (`Ctx::open`). That resolves the real file for the build profile: `~/Library/Application Support/<app_data_dir_name>/data/cc-use.db`, where `app_data_dir_name()` in `src-tauri/src/db/mod.rs` is `com.mipawn.cc-use.dev` with `debug_assertions` and `com.mipawn.cc-use` otherwise.
- Tests use `Database::open_at(path)` (`Ctx::with_db`) so nothing touches the user's database.
- The CLI does not open a second connection, does not change pragmas, and does not write migrations. `Database::new()`/`open_at` already run migrations; the app and daemon share the same file (WAL).

Reads used today:

| Method | Used by |
| --- | --- |
| `settings_get()` | proxy port for the daemon probe |
| `provider_list()`, `api_key_list(provider_id)` | `compatible_keys` route list |
| `api_key_get(id)`, `provider_get(id)` | project default route, statusline route labels |
| `project_list()` | `resolve_project` cwd match |
| `managed_instance_list_active()` | statusline instance lookup |
| `request_log_session_performance(session_token, provider_id, api_key_id)` | statusline third line |

Writes happen only through library functions, never directly from this crate:

- `cc_use_lib::terminal::prepare_cli_terminal_launch(...)` creates the wrapper script, `ProxySession` (`session_kind = "managed"`), and `ManagedInstance` (`terminal_type = "cli"`, `assignment_source = "cli_launch"`).
- `cc_use_lib::statusline_config::enable(...)` / `restore()` edits `~/.claude/settings.json` (with a backup) for `setup-statusline` / `--restore`.
- `cmds::install` creates the symlink `/usr/local/bin/cc-use`; it is a filesystem write, not a DB write.

## Adding a query

If a command needs data that no method exposes, add the method to the owning module under `src-tauri/src/db/<domain>.rs` (and call it through `Database`). This keeps:
- the DB schema and migrations in `src-tauri/src/db/mod.rs`,
- queries reviewable once for both app and CLI,
- the CLI free of `rusqlite` and connection handling.

Do not inline `SELECT`/`INSERT`/`UPDATE` in `cmds.rs`. The only raw SQL in the CLI repository area is inside `crates/cc-use-cli/tests/commands.rs`, where a test seeds `request_logs`/`proxy_sessions` rows that have no test-facing helper; that is fixture code, not a pattern for product code.

## Daemon access

The CLI never calls the management API and never sends HTTP. It only:

1. TCP-probes `127.0.0.1:<settings.proxy_port>` (`ensure_daemon_available`, 500 ms), and
2. hands the terminal to the wrapper script, which performs the `/_management/instances/heartbeat` and `/_management/instances/stop` calls (`src-tauri/src/terminal/mod.rs`).

Starting/stopping the daemon or reading its status belongs to the app (`src-tauri/src/daemon_client.rs`, `src-tauri/src/commands/proxy.rs`) and to `cc-use-daemon` itself. Do not grow a second management client in the CLI.

## Build-profile coupling

Because `Database::new()` branches on `debug_assertions`, the CLI binary must be built with the same profile as the app it belongs to:

- `scripts/cargo-build.mjs` builds `cc-use`, `cc-use-daemon`, and `cc-use-cli` in one Cargo invocation and stages the sidecars for `tauri.conf.json` `externalBin`.
- A debug `target/debug/cc-use-cli` reads the dev database (`com.mipawn.cc-use.dev`) and, once the dev app has run its first-launch setup, the dev port (`22345`). It never reads production data (`com.mipawn.cc-use`, port `12345`).
- Running `cargo run -p cc-use-cli -- ...` while a production app is running will report "service not running" or show dev data. That is expected, not a bug; use the matching profile.

Never hardcode a database path or port in the CLI; always go through `Database` and `settings_get()`.
