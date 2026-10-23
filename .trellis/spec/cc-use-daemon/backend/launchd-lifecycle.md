# Launchd Lifecycle

The daemon is a per-user LaunchAgent. `crates/cc-use-daemon/src/launchd.rs` owns the plist and every `launchctl` call; `src/main.rs` exposes it as subcommands.

## Command surface (`main.rs`)

| Invocation | Implementation | Effect |
| --- | --- | --- |
| `cc-use-daemon start` | `launchd::start` | clean legacy labels, best-effort `stop()`, write plist, `launchctl bootstrap gui/<uid>`; also installs the agent when missing |
| `cc-use-daemon start --foreground` | `runtime::run_foreground` | runs the server in this process; used by the plist and by manual debugging |
| `cc-use-daemon stop` | `launchd::stop` | `launchctl bootout gui/<uid>/<LABEL>`; no-op when the plist is absent |
| `cc-use-daemon restart` | `launchd::restart` | `stop()` then `start()` |
| `cc-use-daemon status` | `launchd::status` + `management::read_existing_management_token` | prints the status line; never creates the token |
| `cc-use-daemon install` | `launchd::install` | same sequence as `start` today; kept for explicit setup/scripts |
| `cc-use-daemon uninstall` | `launchd::uninstall` | `stop()` then remove the plist |

Argument parsing is manual — two positional `std::env::args()` reads; there is no clap in this crate. Anything else returns `Err("Usage: ...")`, which `main` prints to stderr and exits `1`. Successful commands exit `0`.

The Tauri app never calls the `install`/`uninstall` wrappers: `src-tauri/src/daemon_client.rs` exposes them, but `proxy.rs` only uses `start_daemon`, `stop_daemon`, and `restart_daemon`. Because `start` installs on demand, that is sufficient. `uninstall` is the manual cleanup for the LaunchAgent; removing the `.app` alone does not remove the agent.

## Files and paths

| Artifact | Path |
| --- | --- |
| LaunchAgent plist | `~/Library/LaunchAgents/<LABEL>.plist` |
| Staged daemon binary | `~/Library/Application Support/<APP_SUPPORT_DIR>/daemon/cc-use-daemon` |
| Management token | `~/.cc-use/state/management-token` (mode `0600`) |
| Console history | `~/.cc-use/logs/console/daemon-*.jsonl` |
| Wrapper scripts for launched instances | `~/.cc-use/runtime/<instance-id>.sh` |
| SQLite database | `~/Library/Application Support/<APP_SUPPORT_DIR>/data/cc-use.db` |

There is no pid file: launchd owns the pid. Do not add one; `status` and the app's port probe are the only liveness signals.

`launchd_binary_path` copies the current executable into the staged location with `fs::copy` to `<target>.tmp` followed by `fs::rename`, preserving source permissions when `fs::metadata` succeeds. The plist always points at the staged copy, never at the `.app` bundle or `target/debug`, so replacing the app bundle does not invalidate the agent. The copy is skipped when `current_exe()` already equals the staged path.

## Plist shape

`render_plist` emits only `Label`, `ProgramArguments`, `RunAtLoad`, and `KeepAlive`. There is no `StandardOutPath`/`StandardErrorPath`: daemon stderr goes wherever launchd sends it (unified log), or to the terminal for `start --foreground`. The on-disk console history is written by `console_logger.rs`, not by launchd. Keep it that way unless you also update [Console and Logging](./console-and-logging.md).

Debug and release builds render different `ProgramArguments`:

- Release: `<staged-binary> start --foreground`.
- Debug: `/bin/sh -c 'exec "$1" start --foreground' cc-use-daemon-launcher <staged-binary>`.

The debug form is pinned by `render_plist_contains_label_and_binary`. Both forms end with the same daemon process running `start --foreground`; do not "simplify" the debug wrapper without checking how the dev agent behaves and updating that test.

All interpolated values pass through `xml_escape`; `render_plist_escapes_xml_special_characters` pins it. Any new plist value must be escaped the same way.

## Idempotency and error classification

`start`/`install` are safe to repeat:

- The plist is overwritten on every call (`ensure_launch_agent`).
- A stale registration is removed first with a best-effort `stop()`; comment in `install()` explains that `launchctl` otherwise reports "already bootstrapped" and silently ignores the freshly written plist.
- `classify_bootstrap_result` treats `already bootstrapped` as success and propagates everything else.
- `classify_uninstall_result` treats `No such process`, `could not find service`, and `not loaded` as success.
- `stop()` returns `Ok(())` immediately when the plist file does not exist.

Rule: classify expected `launchctl` failure strings explicitly, as these helpers do. Never blanket-ignore every `bootout`/`bootstrap` error — a permission or path error must reach the user. Unexpected errors include the command and the captured stderr/stdout (`run_launchctl`).

## Labels and legacy cleanup

`LABEL` and `APP_SUPPORT_DIR` are compile-time constants chosen by `cfg!(debug_assertions)`. Dev and prod are legitimate siblings that must coexist on one machine.

- `LEGACY_LABELS` is the only input to `cleanup_foreign_launch_agents`; it is empty today.
- Never add the sibling (other-profile) label to `LEGACY_LABELS`. `current_label_is_not_in_legacy_list` is the regression guard; the comment above the constant records that the first version of this helper shipped exactly that bug.
- When renaming the current label, move the old string into `LEGACY_LABELS` so existing users' LaunchAgents directories are swept on the next start.

## Status wire contract

`main.rs` prints exactly:

```text
cc-use-daemon status; management_token_present=<true|false>; launch_agent=<value>
```

`launch_agent` comes from `classify_status_output` and is one of:

| Value | Meaning |
| --- | --- |
| `not_installed` | plist file does not exist |
| `installed:<plist path>` | plist exists; `launchctl print` says the service is not loaded |
| `loaded:<first line of launchctl print>` | service is loaded (usually `gui/<uid>/<LABEL> = {`; empty stdout yields `loaded:<LABEL>`) |

The consumer is `src-tauri/src/daemon_client.rs::parse_daemon_status`. It extracts everything after `launch_agent=`, treats `loaded:` as running, maps `installed:`/`not_installed` to not running, and reports any other value through `ProxyStatus::last_error`; it returns `Err` only when the marker is missing. It then TCP-probes the port (`probe_tcp_port`) and reports `EADDRINUSE` through `port_is_occupied`; launchd being "loaded" does not prove the proxy accepts requests.

Changing this string is a cross-crate change. Update all of:

- `crates/cc-use-daemon/src/main.rs`
- `src-tauri/src/daemon_client.rs` (`parse_daemon_status` and its unit tests)
- `src-tauri/tests/daemon_client.rs` (the same cases are duplicated as an integration test)
- `crates/cc-use-daemon/src/launchd.rs` unit tests that pin `classify_status_output` outputs

`status` also reports `management_token_present` using `management::read_existing_management_token`, which only reads. Do not switch it to `ensure_management_token`: a read-only status command must not create state.

## Manual inspection

```bash
cargo build -p cc-use-daemon
./target/debug/cc-use-daemon status
./target/debug/cc-use-daemon start        # writes the dev plist and bootstraps it
launchctl print gui/$UID/com.mipawn.cc-use.dev.daemon
plutil -lint ~/Library/LaunchAgents/com.mipawn.cc-use.dev.daemon.plist
./target/debug/cc-use-daemon stop
```

Use `start --foreground` in a terminal when you need daemon logs on stderr, and `pnpm dev:daemon` to rebuild-and-restart in one step.
