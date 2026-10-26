# Tauri Commands

> How the renderer talks to the Rust backend, and the exact files a command change
> touches. The authoritative example files are `src-tauri/src/commands/providers.rs`
> (typed input + validation), `commands/managed_instances.rs` (`*_inner` pattern) and
> `commands/settings.rs` (side effects after a write).

---

## Where a Command Lives

One file per domain under `src-tauri/src/commands/`; the module is declared in
`commands/mod.rs` and the function is registered in `lib.rs`. Current domains:
`api_keys`, `balance`, `claude_desktop_config`, `cli_tool`, `codex_config`, `console`,
`gateways`, `import_export`, `managed_instances`, `projects`, `providers`, `proxy`,
`sessions`, `settings`, `statistics`, `system`, `system_ext`, `terminal`, `user_agent`.

Keep `#[tauri::command]` functions thin: lock state, validate, call a
`Database`/service/`*_inner` function, map the error. Business rules do not belong in the
attribute function.

## Register the Command

```rust
// src-tauri/src/lib.rs — one entry per callable command
.invoke_handler(tauri::generate_handler![
    commands::providers::provider_list,
    // ... ~100 commands
    commands::system_ext::show_window_set_shortcut,
])
```

If the function is not in this list, the renderer's `invoke('...')` rejects at runtime and
nothing else warns you. Tests cannot catch it either — the list is only exercised by a
running Tauri app.

## Capabilities

Tauri 2 capabilities gate **plugin/core API access from the webview**, not custom
commands. `src-tauri/capabilities/default.json` currently lists only plugin permissions
(`dialog:*`, `shell:*`, `opener:*`, `updater:*`, `process:allow-restart`,
`global-shortcut:*`) plus `core:*` window permissions. Adding a custom command therefore
needs **no** capability change. You must edit `capabilities/default.json` when a command
starts calling a new plugin API (or a new permission within an existing plugin); otherwise
the plugin call fails with a permission error at runtime.

New plugins must also be registered in `lib.rs` (`.plugin(...)`) and added to
`src-tauri/Cargo.toml`.

## State Access

The app manages three state values in `lib.rs::run()`/`setup()`:

| State type | How to request it | Use |
|------------|-------------------|-----|
| `Arc<Mutex<Database>>` | `db: State<'_, Arc<Mutex<Database>>>` | All SQL |
| `Arc<ConsoleLogHandle>` | `state: State<'_, Arc<ConsoleLogHandle>>` | App-owned console history |
| `ConsoleBridgeHandle` | `bridge: State<'_, ConsoleBridgeHandle>` | Force SSE reconnect |

`AppHandle` is injected as a normal parameter when a command emits events or touches the
window; it is not a managed `State`.

```rust
#[tauri::command]
pub fn provider_list(db: State<'_, Arc<Mutex<Database>>>) -> Result<Vec<Provider>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.provider_list().map_err(|e| e.to_string())
}
```

State access is synchronous. For `async` commands, acquire and drop the DB guard **before**
the first `.await`:

```rust
// commands/settings.rs::settings_update — values are copied out, guard dropped,
// then the daemon is restarted asynchronously.
let (old_port, old_daemon_enabled, new_settings) = { /* lock scope */ };
if new_settings.proxy_port != old_port { crate::commands::proxy::proxy_restart_inner(&*db).await?; }
```

## The `*_inner` Pattern (testable commands)

Logic that commands share with startup code or tests lives in a plain function that takes
`&Database` (or `&Arc<Mutex<Database>>` for async) and returns `Result<T, String>`. The
`#[tauri::command]` wrapper only unwraps managed state.

- `commands/managed_instances.rs` — `managed_instance_update_assignment_inner` is tested by
  `src-tauri/tests/managed_instances_commands.rs` with a `TempDb`; the command wrapper
  passes `db.inner()`.
- `commands/proxy.rs` — `proxy_start_inner`, `proxy_stop_inner`, `proxy_status_inner`,
  `proxy_restart_inner` are called from `lib.rs` watchdog/startup and from `tray.rs`.
- `commands/codex_config.rs` / `commands/claude_desktop_config.rs` — `*_inner` variants hold
  file/DB work; both are used from non-command startup code (`lib.rs` refreshes the
  taken-over Claude Desktop profile).

Use this pattern whenever a command could be triggered by a background task, tray, or
another command. New commands with non-trivial branching should ship with an `_inner`
function so integration tests can call it without a Tauri runtime.

## Input Types

Prefer a typed `#[derive(Deserialize)]` struct over `serde_json::Value`. Structs that are
part of the IPC surface live in `models/mod.rs` (`CreateProviderInput`,
`UpdateApiKeyInput`, `UpdateManagedInstanceAssignmentInput`, …). Command-local inputs are
also acceptable when they are not persisted — e.g. `ModelCatalogPreviewInput` in
`commands/providers.rs`.

When raw JSON is unavoidable, validate before converting:

```rust
// commands/providers.rs::provider_create — adapter id is rejected here, where the
// dialog can show the error, before it reaches the database.
if let Some(adapter) = input.request_adapter.as_deref() {
    if !crate::shared_runtime::is_supported_request_adapter(adapter) {
        return Err(format!("Unsupported request adapter: {}", adapter));
    }
}
```

`commands/settings.rs::settings_update(updates: serde_json::Value)` is the deliberate
exception: settings are an open key/value table and the command writes every provided key
(`db/settings.rs::settings_update`). Do not copy that shape for entity commands.

`commands/terminal.rs::terminal_launch` still casts `options.get("providerId")` manually;
this is legacy. New commands should take a struct field instead of a locally decoded
`serde_json::Value`.

## Argument Naming (Tauri 2 contract)

Tauri converts Rust `snake_case` parameters to `camelCase` keys on the JS side:

- Rust `provider_ids` → `invoke('provider_reorder', { providerIds })`
  (`src/renderer/api/index.ts`).
- Rust `project_id` → `{ projectId }`; Rust `api_key_id` → `{ apiKeyId }`.

A mismatch is a runtime argument error (`invalid args`), not a TypeScript error. The `input`
parameter keeps its single-word name, which is why most calls are
`invoke('..._create', { input })`.

## Return Values and Errors

Almost every command returns `Result<T, String>` (`Result<(), String>` for writes). A few
read-only commands return their value directly when nothing can fail at runtime —
`provider_preset_list() -> Vec<ProviderPreset>`, `cli_tool_status() -> CliToolStatus`,
`console_log_status() -> serde_json::Value`. Everything that touches state, files or the
database uses `Result`. Error handling is standardized by convention, not by a shared error
enum:

- Lock failures → `map_err(|e| e.to_string())`.
- Database errors → `map_err(|e| e.to_string())` at the command boundary.
- Typed internal errors (`CodexConfigError`, `ClaudeDesktopConfigError`,
  `TerminalLauncherError`, `QueryScriptError`) are converted with `.to_string()` in the
  command; the renderer only ever sees the message.

The `String` is displayed to the user (usually raw), so it must be human-readable and must
never contain a key, token, or `Authorization` value. See
[errors-and-logging.md](./errors-and-logging.md).

Do not `unwrap()` DB/user input in command code; `lib.rs` uses `.expect(...)` only for
process-fatal startup. Return the error instead.

## Events

Commands emit Tauri events through `app.emit(...)` (`use tauri::Emitter`). Known event
names:

| Event | Emitted from | Payload |
|-------|--------------|---------|
| `proxy:statusChanged` | `commands/proxy.rs::emit_proxy_status` | `ProxyStatus` |
| `proxy:consoleEvent` | `services/app_logger.rs`, `services/console_bridge.rs` | `ConsoleEvent` |
| `app:migrationAvailable` | `lib.rs` setup | `bool` |

Event names are a cross-process contract with `src/renderer/`; grep the renderer before
renaming one.

## Async and Blocking Work

- Mark the command `async fn` when it awaits I/O (daemon HTTP calls, model catalog fetch,
  `proxy_start` port polling).
- Blocking work inside an async command must go to
  `tokio::task::spawn_blocking`; see `commands/proxy.rs::wait_for_port_ready`, which probes
  a TCP port without stalling the reactor.
- Fire-and-forget work uses `tauri::async_runtime::spawn` (`lib.rs` daemon ensure task and
  watchdog, `services/console_bridge.rs`).
- Long-running daemon operations return `Result<(), String>` after polling readiness, not
  “accepted”.

## Frontend Pairing (all five places)

Per `CONTRIBUTING.md` §“新增一个 Tauri 命令”:

1. `src-tauri/src/commands/<domain>.rs` — `#[tauri::command]`.
2. `src-tauri/src/lib.rs` — `invoke_handler!` registration.
3. `src-tauri/capabilities/default.json` — only when a plugin permission is newly used.
4. `src/renderer/api/types.ts` — add the method to the `Api` interface (typed args/return).
5. `src/renderer/api/index.ts` — implement it in `buildApi()` with the exact command name
   and camelCase argument keys.
6. UI code calls `api.<domain>.<method>(...)`.

Changing only the Rust side produces a runtime “command not found” (if unregistered) or
`undefined` results; changing only TypeScript types produces a clean `pnpm typecheck` and a
broken app. Both sides always change together.

## Checklist: Adding a Command

- [ ] Function in the right `commands/<domain>.rs`; module already declared in `commands/mod.rs`.
- [ ] Non-trivial logic moved to `*_inner(&Database, ...)` (sync) or an async inner helper.
- [ ] Registered in `lib.rs::invoke_handler`.
- [ ] Typed input struct instead of ad-hoc `serde_json::Value` casts.
- [ ] Returns `Result<T, String>`; no `.unwrap()` on user data.
- [ ] DB lock released before any `.await`.
- [ ] If it mutates settings that affect the daemon (`proxyPort`, `daemonEnabled`), it calls
      the existing side-effect path (`commands/settings.rs::settings_update` pattern).
- [ ] `src/renderer/api/types.ts` + `src/renderer/api/index.ts` updated.
- [ ] Emitted events documented/grepped in the renderer.
- [ ] `cargo fmt`, `cargo clippy`, `cargo test --workspace`, `pnpm typecheck`, `pnpm lint`.
