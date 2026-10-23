# Errors and Logging

> How failures travel from the database/proxy to the user, and how the backend logs them.
> Two things are inseparable: a log line and an error string can both leave the machine
> (console history, diagnostics, screenshots), so both are subject to the same secret rules.

---

## Error Conventions by Layer

| Layer | Signature style | Example |
|-------|-----------------|---------|
| `commands/` | `Result<T, String>` | `commands/providers.rs::provider_list` |
| `db/` | `Result<T, rusqlite::Error>` | `db/providers.rs::provider_get` |
| `services/` | `Result<T, String>` (or a typed `thiserror` enum converted at the command) | `services/model_catalog.rs::provider_catalog` |
| `proxy/` | `Result<Response<Body>, Response<Body>>` + `handler::error_response` | `proxy/handler.rs::proxy_handler` |
| `shared_runtime/` | `Result<T, String>` for validation; pure helpers otherwise | `shared_runtime/user_agent.rs::validate`, `management_token.rs` |
| `daemon_client.rs` | `Result<T, String>`; human-readable daemon status | `start_daemon`, `read_daemon_status`, `parse_daemon_status` |

The command boundary is where everything becomes a `String`:

```rust
// commands/api_keys.rs / providers.rs pattern
let db = db.lock().map_err(|e| e.to_string())?;
db.api_key_list(&provider_id).map_err(|e| e.to_string())
```

The renderer receives that string and typically shows it directly, so it is **user-facing
copy**, not a log line.

## Typed Errors (internal only)

These exist where a module parses config or user-authored scripts; they are converted with
`.to_string()` before crossing the command boundary:

| Type | File | Notable variants |
|------|------|------------------|
| `LegacySecretReadError` | `db/keychain_migration.rs` | `Backend`, `InvalidUtf8`, `Unavailable` |
| `CodexConfigError` | `commands/codex_config.rs` | `NotFound`, `ReadError`, `ParseError`, `WriteError`, `BackupError`, `IoError` |
| `ClaudeDesktopConfigError` | `commands/claude_desktop_config.rs` | config detection/takeover failures |
| `TerminalLauncherError` | `terminal/launcher.rs` | terminal strategy failures |
| `QueryScriptError` | `services/query_script.rs` | `Script`, `Limit`, `Result`; implements `Display`/`Error` by hand instead of `thiserror` |

Use `thiserror` for new typed errors (`thiserror = "2"` is already a dependency); convert to
`String` at the edge. Do not expose a typed error over IPC — the `Api` interface has no
error union.

## Error Message Rules

- Write for a human: “Provider not found”, “API key is not compatible with claude_code
  instances” (`commands/managed_instances.rs`). Avoid internal codes and debug formatting.
- **Never echo a secret or user-typed credential.** The reference is
  `shared_runtime/user_agent.rs`: its `INVALID` message names the field and deliberately does
  not repeat the value, and its test asserts the rejected value is absent from the message.
  Same rule for `Authorization` headers, API keys, tokens, and the management token.
- Validation errors belong where the user can fix them (the command), not deep in the proxy:
  `provider_create` rejects an unknown `requestAdapter` instead of storing it.
- Upstream error bodies are truncated before being stored or shown
  (`proxy/handler.rs::extract_error_message`, `MAX_ERROR_MESSAGE_BYTES`).
- Do not branch on message text (`if err.contains("...")`) in Rust; branch on types/status.
- Prefer English in `shared_runtime` and new code. Existing command messages mix Chinese and
  English (`commands/providers.rs` has both `"不支持的启动台"` and `"Unsupported launchpad"`),
  so match the file you are editing rather than translating globally.
- `String` errors are not localized; static UI copy belongs in the frontend i18n files
  (`src/renderer/locales/zh.ts` / `en.ts`, per `CONTRIBUTING.md`).

## Panics

- `lib.rs::run()` uses `.expect("Failed to initialize database")` and
  `.expect("error while running tauri application")` — process-fatal startup only.
- Everywhere else return the error. Do not `unwrap()` on DB rows, `Option`s from settings, or
  user input in runtime paths; that turns a recoverable condition into a crashed daemon.
- Indexing into JSON (`value["x"]["y"]`) is fine for optional shaping because serde returns
  `Null`; indexing arrays/vectors is not.

---

## Logging Setup

The project uses the `log` facade with a custom global logger per process:

| Process | Logger | Installed from |
|---------|--------|----------------|
| Tauri app | `services/app_logger.rs::AppLogger` | `lib.rs` setup: `services::app_logger::install(handle, console_log)` |
| Daemon | `crates/cc-use-daemon/src/console_logger.rs::ConsoleLogger` | `crates/cc-use-daemon/src/runtime.rs::run_foreground` |
| CLI | No logger installed; CLI output goes to stdout/stderr for the terminal | `crates/cc-use-cli` |

Both logger implementations:

- always write to **stderr** in the same format
  `"%Y-%m-%d %H:%M:%S [ INFO] target: message"`, so `pnpm tauri dev`, launchd logs and macOS
  unified logging still work;
- only forward records whose target starts with `cc_use` (covers `cc_use_lib` and
  `cc_use_daemon`), so hyper/rustls/rusqlite noise does not flood the Console page;
- convert the record into `ConsoleEvent::log(level, source, target, message)`, persist it to
  the process’s console history, then emit/broadcast it on the `proxy:consoleEvent` channel
  (`CONSOLE_EVENT_NAME` in both `services/app_logger.rs` and
  `services/console_bridge.rs`).

Both call `log::set_max_level(log::LevelFilter::Info)`. Consequences:

- `log::debug!` / `log::trace!` records are filtered by the facade and never reach the UI or
  console history in current builds. The handful of `log::debug!` calls
  (`proxy/handler.rs`, `proxy/mod.rs`) are for local development only.
- `env_logger` is declared in `src-tauri/Cargo.toml` but is **not initialised anywhere**
  (`grep -rn env_logger src-tauri/src` returns nothing), and `RUST_LOG` is not read. Do not
  tell users to set `RUST_LOG`; it has no effect.
- Never install a second logger (`tauri-plugin-log` is not used). `install()` silently falls
  back if another logger won — that is a bug signal, not a supported mode.

## Log Levels

| Level | Use for | Examples in repo |
|-------|---------|------------------|
| `error!` | A user-visible feature failed and was not recovered | `proxy/handler.rs` “Failed to record usage log”, `lib.rs` watchdog restart failure, `tray.rs` desktop switch failure |
| `warn!` | Recovered/degraded behavior, retries, skipped data | `proxy/mod.rs` metrics writer issues, `commands/settings.rs` “daemon toggle failed”, `shared_runtime/user_agent.rs` unusable stored UA, `lib.rs` watchdog detected stopped daemon |
| `info!` | Lifecycle milestones only | `lib.rs` “app booted; version …”, daemon boot/port binding, “App version changed (… -> …), restarting daemon”, watchdog “auto-restart succeeded” |
| `debug!` | Development diagnostics; invisible in shipped builds | dropped metrics events, oversized capture skips, WebSocket close code |

Do not log per-request success at `info!` — high-volume request data belongs in
`request_logs` and the Console event stream, not in the log. Do not log inside hot loops.

## What Must Never Be Logged

`SECURITY.md` red lines (contributions violating these are rejected):

1. Real API keys (`api_keys.value`, `providers.token`, keychain secrets).
2. `Authorization`, `x-api-key`, `proxy-authorization` header values.
3. The management token (`~/.cc-use/state/management-token`) or the
   `x-cc-use-management-token` header value.
4. Request/response bodies containing credentials. The only sanctioned way to show bodies is
   Console **detail mode**, which runs through
   `proxy/console.rs::build_detail_fields_with_content_type` →
   `desensitize_header` / `desensitize_body` / `desensitize_json_secret_fields` and truncates
   to `TRUNCATION_LIMIT` (8192 bytes). Redaction covers the listed sensitive headers and
   `sk-ant-` / `sk-or-` / `sk-` prefixes; it is deliberately coarse, not a license to log raw
   bodies elsewhere.
5. Anything uploaded off-device — the app has no telemetry path; do not add one that carries
   configuration or credentials.

Session tokens (`session-…`) are temporary but still act as bearer credentials for the local
daemon: treat them as sensitive in logs. Error strings that include a whole upstream URL are
acceptable; URLs with embedded credentials are not (the proxy never builds those).

## Console History (observability surface)

- Events: `proxy/console.rs::ConsoleEvent`, tagged union (`category`: `request` / `log`).
  Request kinds: `pending`, `ok`, `cancelled`, `upstream_error`, `rejected`, `ws`; log sources:
  `daemon`, `app`, `renderer`.
- On-disk store: `services/console_log_store.rs` at `~/.cc-use/logs/console` (mode `0o700`),
  bounded (see [architecture.md](./architecture.md)). The writer thread never blocks the
  caller; `record()` returns `false` and increments `dropped()` on overload. A process only
  clears its own files.
- App ↔ daemon transport: the app keeps one SSE connection to
  `/_management/console/stream` (`services/console_bridge.rs`, capped exponential backoff
  1–10 s), authenticating with `x-cc-use-management-token`. The bridge is alerting-safe: it
  never surfaces errors into the UI, it just reconnects.
- A Console page reload reads history back via `commands/console.rs::console_log_read_recent`
  and the on-disk generation; the live stream is not replayed.

## Verification

```bash
# Ad-hoc stdout/stderr printing outside the sanctioned places (logger adapters,
# the CLI crate, and cc-use-daemon's `status` output in main.rs) is a smell
grep -rn "println!\|eprintln!" src-tauri/src crates/cc-use-daemon/src

# Log calls in the backend
grep -rn "log::\(error\|warn\|info\|debug\|trace\)!" src-tauri/src --include=*.rs

# A new error message must not interpolate a credential
grep -rn "format!.*\(token\|api_key\|value\|authorization\)" src-tauri/src
```

The first grep legitimately reports the two logger adapters,
`crates/cc-use-daemon/src/console_stream.rs`, and `crates/cc-use-daemon/src/main.rs` (command
output). The last grep is a review prompt, not an automatic failure — legitimate uses exist
(e.g. `provider_create` includes the adapter id).

## Anti-Patterns

- `println!` / bare `eprintln!` outside the two logger adapters and the CLI crate.
- Logging an entire struct that derives `Debug` while it contains a key/token field.
- Treating the log as the error channel (returning `Ok(())` and only logging a failure).
- Writing error text that repeats the rejected value (see `user_agent.rs`).
- Adding a request body to a log line because “detail mode is off anyway”.
- Raising the global level to `Debug` to diagnose a user issue — debug records are not
  persisted and the Console page will not show them.
