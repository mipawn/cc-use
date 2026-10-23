# Runtime Startup

`runtime::run_foreground` is the only long-running code path in the daemon. The plist runs it as `cc-use-daemon start --foreground`; `src/main.rs` never starts a server on any other subcommand.

## Boot order (do not reorder casually)

`run_foreground` performs these steps in order, and each step depends on the previous one:

1. `Database::new()` — opens the same SQLite file the app uses (`~/Library/Application Support/<APP_SUPPORT_DIR>/data/cc-use.db`). Failure returns `"Failed to initialize database: ..."`.
2. `db.settings_get()` — the listen port comes from the `proxyPort` setting (`GlobalSettings::proxy_port`, default `12345` in `src-tauri/src/models/mod.rs`).
3. `console_log_dir()` + `ConsoleLogHandle::spawn(dir, ConsoleLogSource::Daemon)` — the daemon keeps its own bounded console history on disk. A missing home directory is fatal (`"Cannot locate a home directory for console logs"`).
4. `build_proxy_state_with_console_log(db.clone(), console_log.clone())` — constructs `ProxyState`, including the broadcast sender (`console_tx`) and the session/metrics machinery from `cc_use_lib`.
5. `console_logger::install(proxy_state.console_tx.clone(), console_log.clone())` — the log adapter is installed *after* `ProxyState` exists because it needs a live `Sender`; from this point every `log::info!` (including the boot line below) is visible on the Console page.
6. `log::info!("daemon booted; binding 127.0.0.1:{}", settings.proxy_port)` — the first observable log line.
7. `build_daemon_state(db, proxy_state, console_log)` — resolves the management token with `management::resolve_management_token`, which creates `~/.cc-use/state/management-token` when absent. A daemon boot can therefore create the token file.
8. `spawn_managed_instance_sweeper(db)` — starts the stale-instance task.
9. `build_daemon_router(state)` — merges `management_routes()` and installs `daemon_proxy_handler` as the fallback.
10. `TcpListener::bind(127.0.0.1:<port as u16>)` — loopback only. Failure reads `"Failed to bind daemon port <port>: <error>"`.
11. `axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())` — serves until the process dies or the server errors.

Rules:
- Bind `127.0.0.1`, never `0.0.0.0`. The daemon is a local sidecar that injects real provider keys; exposing the listener is a security regression (`SECURITY.md`).
- The port comes only from the database setting. There is no `--port` flag; port changes are an app responsibility (`src-tauri/src/commands/settings.rs` restarts the daemon and resets the console bridge). The daemon casts `proxy_port as u16`, so it trusts the app to have stored a valid port.
- Anything that needs the console broadcast must be created after `build_proxy_state_with_console_log` and logged after `console_logger::install`.
- Startup failures are returned as `String`; `main` prints them to stderr and exits `1`. With `KeepAlive=true`, launchd restarts the process, so a deterministic failure (bad DB permissions, occupied port) becomes a restart loop. The app surfaces the real reason through `daemon_client::read_daemon_status` (port probe + `EADDRINUSE` detection), so keep bind errors descriptive.

## Router assembly

```text
Router::new()
  .merge(management_routes())        // /_management/*
  .fallback(daemon_proxy_handler)    // everything else -> cc_use_lib proxy_handler
  .with_state(DaemonState)
```

`daemon_proxy_handler` exists only to adapt `State<DaemonState>` to `State<Arc<ProxyState>>`; it must stay a thin call into `cc_use_lib::proxy::handler::proxy_handler`. Do not put business logic in it.

Because every non-management path falls through to the proxy handler, a new HTTP surface needs an explicit `/_management/...` route in `management_routes()`; otherwise it will be treated as provider traffic and answered by the proxy auth path (see `proxy_path_without_auth_is_still_rejected` in `tests/management_api.rs`).

## Stale-instance sweeper

`spawn_managed_instance_sweeper` ticks every `MANAGED_INSTANCE_SWEEP_INTERVAL_SECS` (10 s) and calls, under one short `db.lock()`:

- `managed_instance_fail_launching_older_than(stale_cutoff, now)` — 20 s (`MANAGED_INSTANCE_STALE_AFTER_SECS`)
- `managed_instance_mark_stale_older_than(stale_cutoff)` — 20 s
- `managed_instance_stop_stale_older_than(stop_cutoff, now)` — 120 s (`MANAGED_INSTANCE_STOP_STALE_AFTER_SECS`)
- `proxy_session_revoke_stopped_managed(now)`

The thresholds are deliberately different: a launch that never reports a process fails fast, while a stop event is given two minutes to arrive. All four results are discarded with `let _ =`, so sweep failures are silent. If you touch this task, prefer adding a `log::warn!` over changing control flow; the sweeper must never block the proxy path.

## Shared state and DB locking

`DaemonState` holds `Arc<Mutex<Database>>`, `Arc<ProxyState>`, `Arc<ConsoleLogHandle>`, and the management token string. It is `Clone`; handlers receive a clone through axum state.

- Use `std::sync::Mutex`, not `tokio::sync::Mutex`, and keep the critical section short.
- Never hold the DB lock across an `.await`. Handlers lock, perform one query, and drop the guard before building the response (see `management_instance_heartbeat`).
- Lock poisoning is reported, not ignored: HTTP handlers map it to `500` with `"Database lock failed"`. Runtime helpers use `if let Ok(db) = db.lock()` where a poisoned lock is unrecoverable.
- The app process shares the same SQLite file. `Database::new` sets `journal_mode = WAL` and `foreign_keys = ON` (`src-tauri/src/db/mod.rs`); the bundled rusqlite installs its default 5 s busy timeout, so contention shows up as a slow call rather than an immediate `SQLITE_BUSY`. Keep write transactions short in both processes and do not add new writers to the proxy hot path.

`build_proxy_state_inner` in `cc_use_lib` also spawns a `cc-use-metrics-writer` thread, and `ConsoleLogHandle` owns its own writer thread. Both are library-managed; the daemon only creates the handles.

## Shutdown behavior

There is no signal handler, no graceful-shutdown future, and no `axum::serve(...).with_graceful_shutdown(...)`. `stop`/`restart` boot out the service; launchd terminates the process. Consequences to respect:

- Records still queued in the console log writer are not flushed on SIGTERM. Do not add blocking cleanup on the proxy path to compensate.
- SQLite is in WAL mode, so an abrupt exit does not corrupt the database, but the app may observe the port disappear mid-request and report a transport error.
- The GUI closing does not stop the daemon; it is a LaunchAgent with `RunAtLoad`/`KeepAlive`. Only the settings toggle, tray/menu commands, `cc-use-daemon stop`, or `uninstall` stop it.

If you ever add a graceful-shutdown path, update this file, [Launchd Lifecycle](./launchd-lifecycle.md), and the console store expectations in [Console and Logging](./console-and-logging.md) in the same change.
