# Quality and Testing

> What CI checks, how the Rust test suite is structured, and the concrete forbidden
> patterns in this backend. Command list is copied from `CONTRIBUTING.md` and
> `.github/workflows/ci.yml`, not invented.

---

## Test Layout

Two layers, deliberately separate:

1. **Inline unit tests** — `#[cfg(test)] mod tests` at the bottom of the implementation
   file. Used for pure helpers and logic that needs no process or real file:
   `proxy/auto_mode.rs`, `proxy/console.rs`, `proxy/handler.rs`, `proxy/mod.rs`,
   `services/query_script.rs`,
   `services/console_log_store.rs`, `services/console_bridge.rs`,
   `services/http_client.rs`, `services/usage_service.rs`, `services/balance_service.rs`,
   `shared_runtime/*`, `db/mod.rs`, `db/request_logs.rs`, `db/user_agents.rs`,
   `db/go_preset_cleanup.rs`, `commands/codex_config.rs`,
   `commands/claude_desktop_config.rs`, `commands/providers.rs`, `commands/cli_tool.rs`,
   `commands/system.rs`, `daemon_client.rs`, `statusline_config.rs`, `terminal/*`,
   `tray.rs`, `usage_stats.rs`.
2. **Integration tests** — `src-tauri/tests/<domain>.rs`. Most start with `mod support;` to
   share fixtures; pure-logic suites (`balance_*`, `route_plan`, `session_token`,
   `management_token`, `user_agent`) call the public API directly. They compile against the
   public `cc_use_lib` API only, so they cannot use `#[cfg(test)]` helpers. Current files
   cover: `db_*` (api keys, projects, providers, proxy sessions, settings),
   `database_bootstrap`, `gateway_metrics`, `managed_instances_db`,
   `managed_instances_commands`, `import_export_security`, `proxy_auth`,
   `proxy_handler_auth`, `proxy_handler_console`, `proxy_websocket`, `model_mapping`,
   `provider_presets`, `project_session`, `route_plan`, `session_token`, `user_agent`,
   `launch_preview`, `terminal_launch_preview`, `usage_parser`, `balance_deepseek`,
   `balance_opencode_go`, `daemon_client`, `management_token`.

Sidecar crates have their own suites: `crates/cc-use-daemon/tests/management_api.rs` and
`crates/cc-use-cli/tests/commands.rs`. `cargo test --workspace` runs everything.

## Fixtures (`src-tauri/tests/support/mod.rs`)

The support module is the shared integration-test toolkit:

| Helper | Behavior |
|--------|----------|
| `TempDb::new()` | Creates `std::env::temp_dir()/cc-use-integration-<nanoid>.db` via `Database::open_at` (real SQLite, migrations applied); `Drop` removes the DB plus `-wal` / `-shm` |
| `create_provider(db, name, _provider_type)` | Inserts a provider with defaults; the type argument is ignored (kept for old call sites) |
| `create_api_key(db, provider_id, cli_type)` | Inserts an active key whose `types` is `[cli_type]`, value `sk-<cli_type>` |
| `create_project(db, provider_id, api_key_id, cli_type)` | Inserts a project with a unique `/tmp/...` path and `terminal` type |
| `build_proxy_state(db)` | Wraps the temp DB in `proxy::build_proxy_state` for handler tests |
| `create_proxy_session(...)` / `create_managed_instance(...)` | Seed sessions/instances with deterministic ids |
| `setup_provider_key_project(db, name)` | Provider + key + project triple |

Integration tests must use `Database::open_at`; `Database::new_in_memory()` is
`#[cfg(test)]`-only inside the library and invisible to integration tests.

## What Tests Look Like

- **DB tests** call the real `Database` and assert SQL-observable results (e.g.
  `tests/db_api_keys.rs::api_key_crud` re-reads `value`/`secret_ref` with a raw query).
  Migration behavior is tested by dropping/recreating schema pieces:
  `tests/database_bootstrap.rs`, `db/mod.rs::legacy_provider_table_gains_every_missing_column`.
- **Proxy tests** never open a production listener in the happy path: they call
  `proxy_handler(AxumState(state), Request<Body>)` directly, then either assert the
  `Response` status/headers/body or subscribe to `state.console_tx` and await the emitted
  `ConsoleEvent` with `tokio::time::timeout` (see `tests/proxy_handler_console.rs`).
- **WebSocket tests** (`tests/proxy_websocket.rs`) run a real local axum upstream on an
  ephemeral port, mount `proxy::build_proxy_router`, and use `tokio-tungstenite` as the
  client. No external network.
- **Daemon tests** (`crates/cc-use-daemon/tests/management_api.rs`) build the real
  `build_daemon_router` and call it with `tower::ServiceExt::oneshot`, so management auth and
  routing are exercised without binding a port.
- **Config-takeover tests** inject a `tempfile::TempDir` path into the manager
  (`commands/codex_config.rs`, `commands/claude_desktop_config.rs`,
  `statusline_config.rs`, `terminal/*`); they never touch the developer’s real
  `~/.codex`, `~/.claude` or `~/.grok`.
- **Script/balance tests** run the shipped extractor offline against captured provider
  payloads (`tests/balance_deepseek.rs`, `tests/balance_opencode_go.rs`).
- Async tests use `#[tokio::test]`; the crate enables the required tokio features already
  (`rt-multi-thread`, `time`, `sync`, `io-util`).

### Determinism rules

- No `sleep` as synchronization. Where a background thread must finish, poll with a bounded
  deadline (as `proxy/mod.rs` does: up to 50 × 2 ms) or wait on a channel.
- Network tests bind `127.0.0.1:0`, never a fixed port.
- Tests must not depend on the user’s home directory, real database, Keychain or daemon.

## What Is Intentionally Not Unit-Tested

- The `#[tauri::command]` wrappers themselves: they need `AppHandle`/webview state. Put logic
  in `*_inner` and test that instead (`tests/managed_instances_commands.rs`).
- Real upstream providers and real API keys (no network, no secrets in CI).
- launchd install/start/stop and macOS window automation: `daemon_client.rs` tests parse
  command output and probe TCP, but do not mutate the user’s LaunchAgents; terminal
  strategies are tested at command-generation level, not by opening windows.
- The Keychain itself: keychain restore is tested with a `FakeLegacySecretReader`
  (`db/mod.rs` tests).
- Tray menu rendering and badge painting (`tray.rs` tests only pure label/format helpers).
- Renderer behavior; frontend tests sit next to the modules they cover (e.g.
  `src/renderer/api/consoleStore.test.ts`) and run through `pnpm test` (Vitest).

## Running Tests

```bash
# Whole workspace (CI command)
cargo test --workspace

# Only the Tauri package
cd src-tauri && cargo test

# One integration file
cargo test -p cc-use --test proxy_auth

# Same thing through the repo script
pnpm test:rust

# Frontend, when IPC types/UI changed
pnpm typecheck && pnpm lint && pnpm test
```

CI (`.github/workflows/ci.yml`) runs, on PRs:

- Rust job (macOS): `cargo fmt --all -- --check`, then `cargo test --workspace`.
- Frontend job (Ubuntu): `pnpm typecheck`, `pnpm lint`, `pnpm test`.

`cargo clippy` is **not** in CI but is listed in `CONTRIBUTING.md`’s pre-commit checklist;
run it locally before requesting review.

## Quality Gate (from CONTRIBUTING.md)

```bash
# Rust backend
cd src-tauri && cargo build && cargo test --workspace && cargo clippy

# Frontend
pnpm tsc --noEmit && pnpm lint
```

Checklist:

- [ ] Rust compiles and `cargo clippy` has no warnings.
- [ ] TypeScript has no errors; ESLint passes.
- [ ] i18n: if user-facing copy changed, `src/renderer/locales/zh.ts` and `en.ts` both
      updated.
- [ ] DB schema change: `run_alter_migrations()` updated and idempotent.
- [ ] New feature: entry added to the `Unreleased` section of `CHANGELOG.md`.
- [ ] New/changed IPC: Rust command + `lib.rs` registration + `src/renderer/api/types.ts` +
      `src/renderer/api/index.ts` + TS model mirror.
- [ ] No secret in a log line, error string, export file, or client config.

## Forbidden Patterns (seen in this repo / named in project docs)

1. **Adding a column only to `CREATE TABLE`.** Existing databases never run that block.
   Every new column needs an `ALTER TABLE` in `db/mod.rs::run_alter_migrations()`
   (`CONTRIBUTING.md` §“新增数据库字段”).
2. **Making ALTER migrations fail on duplicate columns.** The list is rerun on every start;
   duplicate-column errors are the expected no-op.
3. **Writing a real API key into a client config or terminal environment.** `SECURITY.md`
   red lines: no keys in `~/.claude/settings.json`, `~/.codex/config.toml`, wrapper env, logs
   or remote services. Clients get `session-…` tokens only.
4. **Logging credentials.** No full keys/tokens/`Authorization`/management token in `log::*`,
   error messages, Console events or exports (`errors-and-logging.md`). Exports redact key
   values and credential-bearing headers unless `include_api_keys` is explicitly true
   (`services/import_export.rs`, `tests/import_export_security.rs`).
5. **Duplicating route/model/header logic.** The decision lives in
   `shared_runtime::route_plan`, `shared_runtime::model_mapping` and `proxy/handler.rs`
   helpers; the daemon must use the same code (`crates/cc-use-daemon` mounts
   `proxy_handler`). A second copy in a command or the CLI drifts.
6. **Casting raw payload fields directly.** `commands/terminal.rs::terminal_launch` still
   does `options.get("providerId")`; new commands take a typed input struct instead. The
   cross-layer guide (`.trellis/spec/guides/cross-layer-thinking-guide.md`, Mistake 4)
   explains the cost: every consumer parses the same payload differently.
7. **Changing one side of the camelCase contract.** Rust `models/mod.rs` ↔
   `src/shared/types/index.ts`; see [data-model-contract.md](./data-model-contract.md).
8. **Holding the DB mutex across `.await`.** Copy values out of the lock, drop it, then
   await. `commands/settings.rs::settings_update` and `proxy/handler.rs` both demonstrate the
   pattern; the comment in `settings_update` names the deadlock it prevents.
9. **Blocking the async reactor.** TCP probes, HTTP, Keychain or process work inside async
   code must be wrapped: `commands/proxy.rs::wait_for_port_ready` uses
   `tokio::task::spawn_blocking`; the console-log and gateway-metric writers are dedicated
   threads. Do not extend the short-lived `Command::output` calls in `daemon_client.rs` into
   a pattern for network or large file I/O.
10. **Guessing instead of normalizing.** Legacy `claude` / `codex-app` spellings are
    normalized (`shared_runtime::model_mapping::client_key`,
    `db/projects.rs::normalize_project_cli_type`,
    `commands/managed_instances.rs::normalize_cli_type`); don’t add a new spelling or a
    per-call `if kind == ...` chain.
11. **Dev/prod fallback for sidecar binaries.** `daemon_client.rs::resolve_daemon_binary_path`
    deliberately refuses to fall back from the dev binary to the bundled one (comment: that
    caused prod apps to run on the dev port). Do not “make it more robust” by adding
    cross-profile candidates.
12. **Mutating user config files wholesale.** Config takeover writes only the owned keys and
    backs up first (`commands/codex_config.rs::OVERWRITTEN_TOP_LEVEL_KEYS`,
    `statusline_config.rs` backup/`ThirdPartyPresent`); statusline never overwrites a
    third-party command without `--force`.
13. **Printing to stdout from the backend.** App/daemon code logs through `log::*` (the two
    logger adapters own stderr formatting). The only user-facing stdout is the CLI crate and
    `cc-use-daemon`’s `status`/CLI output in `crates/cc-use-daemon/src/main.rs`.
14. **Adding a second logger or relying on `RUST_LOG`.** `env_logger` is not initialized;
    `log::set_max_level(Info)` is fixed in both processes.
15. **Creating a new table without retention.** High-volume tables need a cleanup path
    (`db/gateway_metrics.rs::gateway_event_cleanup`, 30 days / 50k rows;
    `lib.rs` startup cleanup for sessions/logs).

## Review Checklist (backend diff)

- [ ] New SQL lives in `db/<table>.rs`; no SQL in commands/services.
- [ ] Schema change touches ALTER + CREATE + SELECT/mapper/INSERT + model + TS + fixtures.
- [ ] Data rewrites are transactional and marker-guarded.
- [ ] New command registered and paired with the renderer `Api`.
- [ ] DB guard never crosses `.await`; blocking work moved off the reactor.
- [ ] Errors are returned, not unwrapped; messages contain no secrets.
- [ ] Logs use the right level and the own-crate filter; no stdout printing.
- [ ] Tests added at the right layer; they use `TempDb`/temp dirs and bind loopback port 0.
- [ ] `cargo fmt --all -- --check`, `cargo clippy`, `cargo test --workspace` pass.
- [ ] `CHANGELOG.md` Unreleased entry for user-visible behavior.
