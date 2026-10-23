# Management API

`crates/cc-use-daemon/src/management.rs` defines `management_routes()`, `DaemonState`, the request/response types, the management-token check, and the JSON error envelope. `console_stream.rs` adds the SSE route.

## Auth

- Every `/_management/*` request must carry `x-cc-use-management-token: <token>`.
- `require_management_token(&DaemonState, &HeaderMap)` compares the header with `DaemonState::management_token` using `cc_use_lib::shared_runtime::validate_management_token` (exact string equality). Missing and wrong values both produce `401` with `{"error": "Invalid management token"}`.
- No other channel is accepted: no query parameter, no cookie, no `Authorization: Bearer`. Keep the token in the header so it does not end up in URLs or access logs.
- The token is created at daemon boot by `resolve_management_token()` → `ensure_management_token` → `~/.cc-use/state/management-token` (mode `0600`). The app reads the same file with `read_management_token`; the wrapper script written by `src-tauri/src/terminal/mod.rs` receives it as `CC_USE_MANAGEMENT_TOKEN` and sends heartbeat/stop calls with it.
- `DaemonState` stores the token as a plain `String`; there is no rotation endpoint and no constant-time comparison. This is a loopback-only credential — do not expose these routes beyond `127.0.0.1` and do not log the value.

## Routes

| Method | Path | Handler | Success body |
| --- | --- | --- | --- |
| GET | `/_management/health` | `management_health` | `{"ok": true}` |
| GET | `/_management/console/detail-mode` | `management_console_detail_mode_get` | `{"enabled": <bool>}` |
| POST | `/_management/console/detail-mode` | `management_console_detail_mode` | `{"ok": true}` |
| POST | `/_management/instances/heartbeat` | `management_instance_heartbeat` | `{"ok": true}` |
| POST | `/_management/instances/stop` | `management_instance_stop` | `{"ok": true}` |
| GET | `/_management/console/stream` | `console_stream::console_stream` | SSE stream (`text/event-stream`) |
| POST | `/_management/console/clear` | `management_console_clear` | `{"ok": true}` |
| GET | `/_management/console/log-status` | `management_console_log_status` | `{"dropped": <u64>}` |

Read and write share the detail-mode path on purpose: the switch lives in the daemon (`ProxyState::detail_mode`), so a reloaded renderer must read the real value instead of assuming "off".

### Heartbeat body

`ManagementInstanceHeartbeatInput` (`#[serde(rename_all = "camelCase")]`): `instanceId` (required), `shellPid?`, `processPid?`, `phase?` (`"launching"` or `"running"`, default `"running"`).

- Invalid `phase` → `400` `"Invalid managed instance heartbeat phase"`.
- DB lock or query error → `500`.
- `managed_instance_touch_heartbeat` returns `false` for an instance that is no longer active (stopped/failed) → `409` `"Managed instance is no longer active"`.
- The wrapper posts `phase: "launching"` until the child process starts, so a heartbeat does not prematurely move a row to `running`.

### Stop body

`ManagementInstanceStopInput`: `instanceId` (required), `shellPid?`, `processPid?`, `stopReason?`, `exitCode?`.

- `stopReason` `"launch_failed"` or `"prelaunch_failed"` maps the final status to `"failed"`; every other reason maps to `"stopped"`.
- Unknown instance → `404` `"Managed instance not found"`.
- Instance already terminal (`stopped`/`failed`): revoke its session again and return `200` — stop is idempotent on purpose, so a duplicate wrapper trap is harmless (`terminal_instances_ignore_late_heartbeats_and_duplicate_stop_events`).
- `managed_instance_mark_stopped` returning `false` → `409` `"Managed instance is no longer active"`.
- On success the row is updated and `proxy_session_revoke(session_token, status, now)` makes the `session-*` token unusable.

### Console routes

- `GET /_management/console/detail-mode` reads `ProxyState::detail_mode` with `Ordering::Relaxed`; the POST writes it the same way. The proxy handler snapshots the flag once at dispatch (`detail_mode_at_dispatch` in `src-tauri/src/proxy/handler.rs`), so toggling only affects requests that start afterwards.
- `POST /_management/console/clear` calls `ConsoleLogHandle::clear()`, which enqueues a clear behind pending writes and returns immediately. The GUI clears its own files and asks the daemon to clear its own, because only the owning process may delete files it is appending to (`console_clear_drops_the_daemons_own_history`).
- `GET /_management/console/log-status` exposes `ConsoleLogHandle::dropped()`.
- The SSE route authenticates separately in `console_stream::console_stream`; it must stay behind the same token. A new SSE-like route should reuse `require_management_token` (make it `pub(crate)`) instead of adding a third copy of the header check.

## Errors

All handler failures use one envelope:

```json
{ "error": "human-readable message" }
```

built by `error_response(status, message)` → `(StatusCode, Json(json!({ "error": message })))`.

Rules:
- Call `require_management_token` before reading or mutating state, and return its `Err(Response)` unchanged.
- Use `400` for malformed semantic input, `404` for a missing row, `409` for a legal request against an instance that is no longer active, `500` for DB/lock failures.
- Messages must be safe to display in the UI and safe to log by the app: no session tokens, API keys, or management tokens. DB error strings (`e.to_string()`) are acceptable here because they contain paths/SQLite messages, not credentials — verify before reusing this pattern for new secret-bearing operations.
- Do not let the proxy handler see a `/_management` path. Everything under that prefix must be registered in `management_routes()`.

## In-repo consumers

| Endpoint | Consumer |
| --- | --- |
| `console/detail-mode` (GET + POST) | `src-tauri/src/commands/proxy.rs` (`console_detail_mode_get` / `console_detail_mode_set`) |
| `console/clear` | `src-tauri/src/commands/console.rs` (`console_log_clear` via `request_daemon_clear`) |
| `console/stream` | `src-tauri/src/services/console_bridge.rs` (`spawn_console_bridge`, reconnects with capped backoff) |
| `instances/heartbeat`, `instances/stop` | shell wrapper generated by `src-tauri/src/terminal/mod.rs` (`cc_use_post`, using `CC_USE_MANAGEMENT_TOKEN`) |
| `console/log-status` | no in-repo caller today; the app's `console_log_status` reads only the app-side store |
| `health` | no in-repo caller today; exercised by `tests/management_api.rs` |

`src-tauri/src/daemon_client.rs` is *not* an HTTP client. It spawns the daemon binary (`start`/`stop`/`restart`/`status`) and parses the status line; HTTP calls live in the files above. Do not add endpoint knowledge to `daemon_client.rs`.

## Adding or changing a route

1. Add the route inside `management_routes()` with the `/_management/` prefix; never add it to `runtime::build_daemon_router` separately.
2. Handler signature: `State<DaemonState>`, then `HeaderMap`, then an optional `Json<T>` body. Authenticate first.
3. Request inputs: `#[derive(Deserialize)]` + `#[serde(rename_all = "camelCase")]` so the renderer's camelCase payloads keep working. Keep responses minimal (`ManagementHealthResponse` or an explicit `serde_json::json!`).
4. Emit failures through `error_response`; no ad-hoc tuple responses.
5. Add tests to `crates/cc-use-daemon/tests/management_api.rs` covering missing token, wrong token, success, and each error status (see [Testing](./testing.md)).
6. Update the consuming app file and this table in the same change. If the change moves a flag or generation boundary, also update [Console and Logging](./console-and-logging.md).
