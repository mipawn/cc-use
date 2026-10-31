# Backend Architecture

> Scope: the Rust backend of package `cc-use` — everything under `src-tauri/`. The two
> sidecar crates have their own spec layers under `.trellis/spec/cc-use-daemon` and
> `.trellis/spec/cc-use-cli`; read this file first because both sidecars link against the
> library defined here.

---

## Three Processes, One Library

CC Use is a **session-token proxy**: clients (Claude Code, Grok Build, Codex Desktop,
Claude Desktop) never receive a real API key, only a `session-` token routed by a local
daemon (`SECURITY.md`, “会话令牌隔离”).

| Binary | Crate / source | Role |
|--------|----------------|------|
| `CC Use` (Tauri app) | `src-tauri/` (`lib name = cc_use_lib`) | Control plane: windows, tray, config takeover, session/instance records, console UI |
| `cc-use-daemon` | `crates/cc-use-daemon/` | Data plane: the only production process that serves the proxy and holds real keys in memory |
| `cc-use-cli` (installed as `cc-use`) | `crates/cc-use-cli/` | Launch entry: prepares a managed instance and `exec`s the wrapper in the current terminal; no second management surface |

Both sidecars depend on the app crate as a path dependency:

```toml
# crates/cc-use-daemon/Cargo.toml, crates/cc-use-cli/Cargo.toml
cc_use_lib = { path = "../../src-tauri", package = "cc-use", default-features = false }
```

They are bundled because `src-tauri/tauri.conf.json` lists
`"externalBin": ["binaries/cc-use-daemon", "binaries/cc-use-cli"]`. The daemon binds the
port stored in the `proxyPort` setting; `src-tauri/src/lib.rs` initializes that setting to
`22345` in debug builds and `12345` in release so dev and prod can run side by side
(`lib.rs`, `run()` setup closure).

**Hard boundary:** the Tauri process never runs an HTTP server. `commands/proxy.rs` starts,
stops and probes the daemon through `src-tauri/src/daemon_client.rs`; console detail-mode and
history operations talk to the daemon’s `/_management/*` endpoints with the management token
(all still `127.0.0.1` only). `axum::serve` exists only in
`crates/cc-use-daemon/src/runtime.rs`; `build_proxy_router` in
`src-tauri/src/proxy/mod.rs` is used by `tests/proxy_websocket.rs` only.

---

## Module Map

| Path | Responsibility | Read it when |
|------|----------------|--------------|
| `src-tauri/src/main.rs` | 3 lines: calls `cc_use_lib::run()` | Rarely; the app entry is `lib.rs` |
| `src-tauri/src/lib.rs` | Module tree, plugin registration, `invoke_handler!`, `setup()` boot sequence, daemon watchdog | Adding a command, changing startup behavior |
| `src-tauri/src/commands/` | One file per domain; `#[tauri::command]` wrappers | Adding/changing IPC |
| `src-tauri/src/db/` | rusqlite access, one module per table, migrations, legacy keychain lift | Any schema/query change |
| `src-tauri/src/models/mod.rs` | All serde DTOs sent over IPC (camelCase) | Any field exposed to the renderer |
| `src-tauri/src/proxy/` | Proxy core: `handler.rs`, `key_selector.rs`, `usage_parser.rs`, `auto_mode.rs`, `console.rs`, state/router in `mod.rs` | Any request-path change |
| `src-tauri/src/services/` | Process services: console store/bridge, app logger, HTTP client cache, model catalog, query scripts, import/export, balance/usage refresh | Cross-cutting runtime behavior |
| `src-tauri/src/shared_runtime/` | Tauri-free rules shared by app, daemon and CLI: session tokens, routing, model mapping, presets, account scripts, headers, management token | Logic that must behave identically in all three processes |
| `src-tauri/src/terminal/` | Terminal strategies (iTerm2, Terminal.app), managed-launch wrapper script, Grok config | Launch/instance work |
| `src-tauri/src/tray.rs` | Tray menu, badge, menu-event handlers | Tray-facing changes |
| `src-tauri/src/auto_launch.rs` | Login-item management via `auto-launch` | Boot-at-login changes |
| `src-tauri/src/statusline_config.rs` | Reads/writes Claude Code `statusLine` with backup, shared by GUI (`commands/cli_tool.rs`) and CLI | Statusline changes |
| `src-tauri/src/usage_stats.rs` | Tray badge aggregation (today's tokens only) | Badge changes |
| `src-tauri/src/daemon_client.rs` | Spawns/inspects the daemon binary, parses `cc-use-daemon status`, probes the TCP port | Daemon lifecycle |

---

## Boot Sequence (`lib.rs::run`)

1. `Database::new()` opens/migrates SQLite; it is wrapped in `Arc<Mutex<Database>>` and
   `.manage()`d, so every command can request it as `State<'_, Arc<Mutex<Database>>>`.
2. Plugins are registered (`dialog`, `shell`, `opener`, `updater`, `process`,
   `global-shortcut`) and the `cc-use-icon://` URI scheme is served by
   `commands::system::icon_response`.
3. `invoke_handler(tauri::generate_handler![...])` lists every command. A command missing
   from this list is not callable; the frontend gets a rejected promise, not a compile
   error.
4. `setup()` seeds legacy defaults (`closeToTray`, `proxyPort`, debug/prod port split),
   spawns the app-side console log writer
   (`services::console_log_store`, source `App`), installs the `log` adapter
   (`services::app_logger::install`) **before** the rest of boot work, starts the realtime
   console SSE bridge (`services::console_bridge::spawn_console_bridge`, whose handle is
   managed state so settings changes can reconnect it), applies window geometry, builds the
   tray, restores the global shortcut, emits `app:migrationAvailable` when an Electron DB
   is found, and spawns the daemon ensure-task.
5. A watchdog task re-checks daemon health every 30 s when `daemonEnabled` is true and
   restarts it via `commands::proxy::proxy_start_inner`. The daemon is also restarted when
   `lastDaemonVersion` differs from `env!("CARGO_PKG_VERSION")`.

Startup work is best-effort except two process-fatal `.expect(...)` calls in `lib.rs`
(`Database::new()` and the Tauri runtime handoff). Everything else logs
(`log::warn!` / `log::error!`) and continues.

---

## State and Shared Contracts

- **Database** — one `Arc<Mutex<Database>>` for the whole app. `Database` exposes
  `pub conn: rusqlite::Connection`; methods take `&self`. Never hold the mutex guard across
  `.await` (see `commands/settings.rs::settings_update`, which drops the guard before
  `proxy_restart_inner(...).await`, and `proxy/handler.rs`, which scopes the DB lock to
  `build_route_execution` before any network `.await`).
- **Management token** — `~/.cc-use/state/management-token`, mode `0o600`
  (`shared_runtime/management_token.rs`). The app sends it as
  `x-cc-use-management-token` to the daemon (`commands/proxy.rs`,
  `commands/console.rs`); the terminal wrapper script receives it as
  `CC_USE_MANAGEMENT_TOKEN` (`terminal/mod.rs::write_managed_launch_script`). It is a
  local-only capability: never log it, never put it in a client config file.
- **Console history** — `~/.cc-use/logs/console`, created mode `0o700`
  (`services/console_log_store.rs::console_log_dir`). Each process owns its source
  (`daemon` / `app`) and takes a fresh epoch/file per start; the app never deletes daemon
  files directly — it asks the daemon over `/_management/console/clear` and reports a
  per-owner result. The window is the current local day plus the previous two (from UTC
  record timestamps), and size budgets stay on top: 10 MiB/file, 5 files/source,
  50 MiB/source, 100 MiB total, 256 KiB per record. Per-source `dropped`/`writeFailed`/
  `trimmed`/`capacityEvicted` are surfaced by `console_log_status` (daemon offline =>
  `available: false`). Renderer `console.*` lines join the app-owned files through
  `console_log_append_renderer`. Cross-process maintenance uses a `flock` directory lock.
- **Proxy state** — `proxy::ProxyState` (DB handle, request counter, console broadcast
  channel, console log handle, detail-mode flag, concurrency semaphores). Built by
  `proxy::build_proxy_state_with_console_log` only inside the daemon; tests build it with
  `build_proxy_state`.

---

## `shared_runtime` Owns Cross-Process Logic

Anything the daemon or CLI must execute identically belongs here, not in `commands/`:

- `session_token.rs` — `SESSION_TOKEN_PREFIX`, `new_session_token`, `is_session_token`,
  `CODEX_SESSION_TOKEN_SETTING_KEY`.
- `route_plan.rs` — `classify_request_auth`, `decide_route_plan`, `RequestAuth`,
  `RoutePlan`.
- `model_mapping.rs` — v2 mapping scopes (`clients.<kind>`), role/catalog helpers,
  `sanitize_mapping`, `upstream_mapping`.
- `provider_presets.rs` — preset catalogue and `apply_preset_defaults`.
- `account_scripts.rs` — legacy balance/usage kinds → script text.
- `request_headers.rs` and `user_agent.rs` — the two header policies that intentionally
  differ: provider headers are **additive** (never overwrite what the client sent), a
  chosen User-Agent **replaces** the client's (`user_agent.rs` module docs).
- `project_session.rs`, `launch_preview.rs`, `upstream_routing.rs`,
  `management_token.rs`.

Evidence of reuse: `crates/cc-use-cli/src/cmds.rs` calls
`cc_use_lib::terminal::prepare_cli_terminal_launch` and
`cc_use_lib::statusline_config::*`; `crates/cc-use-daemon/src/runtime.rs` imports
`cc_use_lib::proxy::handler::proxy_handler` and `build_proxy_state_with_console_log`;
`crates/cc-use-daemon/src/management.rs` imports `cc_use_lib::shared_runtime::*`.

---

## Placement Rules

- New Tauri command → `commands/<domain>.rs`, registered in `lib.rs`; see
  [tauri-commands.md](./tauri-commands.md).
- New SQL → `db/<table>.rs`; schema change → `db/mod.rs`; see [database.md](./database.md).
- New IPC DTO → `models/mod.rs` plus the TypeScript mirror; see
  [data-model-contract.md](./data-model-contract.md).
- New outbound HTTP call → reuse `services/http_client.rs` (cached clients, proxy-aware,
  timeouts) instead of `reqwest::Client::new()`.
- New rule needed by more than one process → `shared_runtime/`; it must not import `tauri`.
- New provider/model-shaping behavior → `shared_runtime/model_mapping.rs` or
  `proxy/` (never duplicated in a command).
- Any mutation of a user-owned client config (`~/.codex/config.toml`,
  `~/.claude/settings.json`, Claude Desktop config, `~/.grok/config.toml`) → the owning
  module must back up first and preserve keys it does not own; see
  `commands/codex_config.rs` (`OVERWRITTEN_TOP_LEVEL_KEYS`, backup manager) and
  `statusline_config.rs` (`backup_path`, `EnableOutcome::ThirdPartyPresent`).

### Tauri-free zones

Only these files reference `tauri` (verify with
`grep -rln "tauri::\|use tauri" src-tauri/src --include=*.rs`): `lib.rs`, everything under
`commands/`, `tray.rs`, `services/app_logger.rs`, `services/console_bridge.rs`.
`db/`, `models/`, `proxy/`, `shared_runtime/`, `terminal/`, `statusline_config.rs`,
`usage_stats.rs`, `auto_launch.rs` and the remaining `services/` stay Tauri-free so the
daemon and CLI can link them. Pulling `tauri` into one of those files breaks both sidecars
at build time.

---

## Anti-Patterns

- Starting an HTTP listener in the Tauri process, or loading the proxy inside a command.
- Duplicating route/model-mapping/header logic in `commands/` instead of calling
  `shared_runtime` or `proxy` helpers.
- Adding `tauri` usage to a shared module to “save a parameter”.
- Reading `Database` directly from the tray/UI layer with an unscoped lock, or awaiting
  while holding it.
- Writing a client config file without a backup or by replacing the whole file instead of
  the owned keys.
- Logging a management token, session token or real key (see
  [errors-and-logging.md](./errors-and-logging.md)).
