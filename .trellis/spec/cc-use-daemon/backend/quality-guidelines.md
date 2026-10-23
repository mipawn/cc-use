# Quality Guidelines

## Error handling conventions

The daemon has no custom error type; boundaries return `Result<_, String>`.

- **Process commands** (`main.rs` → `launchd::*`, `runtime::run_foreground`): return `Err(String)` with context, e.g. `"Failed to write LaunchAgent plist: <io error>"`, `"Failed to bind daemon port <port>: <io error>"`. `main` prints it to stderr and exits `1`. Do not add per-command exit codes; the app only distinguishes success from failure.
- **HTTP handlers**: `Result<Json<T>, Response>`; every failure goes through `error_response(status, message)` so the body is always `{"error": "..."}`. Authenticate first, then lock, then mutate.
- **Background tasks**: best-effort operations may discard results, but add a comment explaining why. The sweeper uses `let _ =` for its four DB calls; `install()`/`start()` discard the pre-clean `stop()` error on purpose.
- **Lock poisoning**: HTTP handlers report `500 "Database lock failed"`; runtime helpers use `if let Ok(db) = db.lock()` where continuing without the DB is impossible. Never `unwrap()` a mutex in a request path.
- **Never put secrets in an error string**, an HTTP body, or a log line. See [Console and Logging](./console-and-logging.md#secrets-and-privacy) and `SECURITY.md`.

The expected error taxonomy for the management API is documented in [Management API](./management-api.md#errors); follow it instead of inventing new codes.

## Forbidden patterns

| Pattern | Why | Instead |
| --- | --- | --- |
| Adding `rusqlite`/SQL to `crates/cc-use-daemon` | The daemon has no SQLite dependency; schema ownership is `cc_use_lib::db` | Add or extend a `Database` method in `src-tauri/src/db/` |
| Re-implementing proxy/session/routing logic in the daemon | The app and CLI would diverge from the daemon | Call the existing `cc_use_lib` function (`proxy_handler`, `shared_runtime::*`) |
| Adding `clap`/argument parsing beyond `start [--foreground]`, `stop`, `restart`, `status`, `install`, `uninstall` | The daemon process surface is deliberately tiny; the app spawns it | Keep argv in `main.rs`; put new behavior behind `/_management/*` |
| Binding `0.0.0.0` or adding a second listener | The daemon injects real provider keys; it must stay loopback-only, and R07 requires one gateway | Bind `127.0.0.1:<settings.proxy_port>` only |
| Holding the DB mutex across `.await` or running long writes | `std::sync::Mutex`, shared SQLite file; rusqlite's default 5 s busy timeout means contention shows up as slow calls | Lock → query → drop guard; keep write transactions short |
| `unwrap` / `expect` / `panic!` outside tests | A panic kills the sidecar and the app sees an opaque restart loop | Return `Result`; use `error_response` |
| Swallowing unexpected `launchctl` failures | Users need the permission/path error | Extend `classify_*` only for known benign strings |
| Changing the status line, plist label, port source, or management route without the app side | The app parses them and will silently mis-report state | Update the consumers and their tests in the same change |
| Deleting console files owned by another process | Corruption: the other process is still appending | Ask the owner (`/_management/console/clear` for the daemon, app command for the app) |
| Logging full tokens, keys, auth headers, or request bodies outside detail mode | Violates `SECURITY.md` | Log lifecycle facts (port, instance id); detail only via `detail_mode` + desensitisation |

## Required patterns

- One responsibility per source file: `management.rs` (HTTP surface), `runtime.rs` (boot/router/sweeper), `launchd.rs` (agent lifecycle), `console_stream.rs` (SSE), `console_logger.rs` (log adapter). New behavior goes into the matching file; do not grow `main.rs` beyond argv dispatch.
- Expose modules through `lib.rs` only when integration tests need them (`management`, `runtime` are public for that reason). Keep everything else private.
- Management request structs: `Deserialize` + `#[serde(rename_all = "camelCase")]`. Responses stay small (`ManagementHealthResponse` or `serde_json::json!`).
- Keep `DaemonState` fields public: `tests/management_api.rs` constructs it as a struct literal. Changing a field is a test-and-app change.
- Extract decision logic into pure functions when it interacts with the OS (`classify_*`, `render_plist`, `foreign_labels`). That is how launchd behavior stays testable without running `launchctl`.
- Prefer `log::info!` for lifecycle, `warn!` for recoverable degradation, `error!` for operator-visible failures. `debug!`/`trace!` are filtered by the Info max level and will not appear anywhere in the daemon.
- Keep the console log store's bounded queue off the hot path: emit events, do not await disk I/O in a handler.

## Code review checklist

- [ ] Does the change belong to the daemon, or should it live in `cc_use_lib` / the app? (see [Architecture and Boundaries](./architecture-and-boundaries.md))
- [ ] Does every new `/_management` route authenticate before doing anything else?
- [ ] Are request bodies camelCase and responses limited to what consumers read?
- [ ] Are all error paths non-panicking and free of secrets?
- [ ] Is any DB lock held across an `.await`? Is any new write long-running?
- [ ] Is a background task failure visible or deliberately discarded with a comment?
- [ ] If the status line / plist / token path changed: are `daemon_client.rs` and its tests updated too?
- [ ] Is there a test for every new route (auth + success + error branches), or a pure-function test for OS interaction?
- [ ] Does the daemon still compile without new dependencies (`cargo tree -p cc-use-daemon --depth 1`)?

## Verification

```bash
cargo test -p cc-use-daemon
cargo clippy -p cc-use-daemon --all-targets
cargo fmt --all -- --check
```

CI runs `cargo fmt --all -- --check` and `cargo test --workspace` (`.github/workflows/ci.yml`); clippy is expected by `CONTRIBUTING.md` even though CI does not gate on it.
