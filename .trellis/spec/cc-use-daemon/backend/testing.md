# Testing

The daemon has two test layers. Put pure logic in the module's `#[cfg(test)]` block; put protocol behavior in the integration test.

## Integration tests: `crates/cc-use-daemon/tests/management_api.rs`

The test builds the real router without opening a socket:

```rust
use cc_use_daemon::management::DaemonState;
use cc_use_daemon::runtime::build_daemon_router;
use tower::ServiceExt; // .oneshot(...)

let response = app().oneshot(
    Request::builder()
        .uri("/_management/health")
        .header("x-cc-use-management-token", "mgmt-test")
        .body(Body::empty())
        .unwrap(),
).await.unwrap();
```

Local harness helpers:

| Helper | Purpose |
| --- | --- |
| `app_with_db()` | temp SQLite file (`Database::open_at`, which runs migrations), `build_proxy_state`, temp console-log dir, `DaemonState` with literal token `"mgmt-test"`; returns `(Router, Arc<Mutex<Database>>)` |
| `app()` | `app_with_db().0`, for auth-only cases |
| `app_with_console_log()` | same but returns the `Arc<ConsoleLogHandle>` and log dir so disk effects can be asserted |
| `seed_managed_instance(&db)` | creates provider → API key → `ProxySession` (`session-managed`, `session_kind = "managed"`) → `ManagedInstance` (`instance-managed`, status `launching`) through `cc_use_lib::db` methods |

Conventions:
- Use `#[tokio::test]`; the router is `Clone`, so `app.clone()` supports multiple requests in one test.
- Set `content-type: application/json` whenever the handler takes `Json<T>`; otherwise axum rejects the body before the handler runs.
- Assert on DB rows (`managed_instance_get`, `proxy_session_get`) after a mutation, not only on the HTTP status.
- For JSON responses, read the body with `axum::body::to_bytes(response.into_body(), 4096)` and parse with `serde_json`.
- Construct `DaemonState` directly with a literal management token. Never call `resolve_management_token()` in tests: it writes to the developer's real `~/.cc-use/state`.
- Tests use `std::env::temp_dir()` + `nanoid` for paths and leave files behind. New tests may use `tempfile::tempdir()` (already a dev-dependency) when cleanup matters; both patterns exist in the crate.

Existing cases define the expected contract:

- Auth: `rejects_management_request_without_token`, `rejects_management_request_with_wrong_token`, `accepts_management_request_with_token`, `console_stream_rejects_without_token`, `console_stream_rejects_with_wrong_token`, `console_clear_requires_the_management_token`.
- Proxy fallback: `proxy_path_without_auth_is_still_rejected` (non-management path is answered by the proxy handler and is not accidentally public).
- Instance lifecycle: `heartbeat_updates_managed_instance_status_and_pids`, `launching_heartbeat_preserves_launching_until_the_cli_starts`, `stop_marks_managed_instance_as_stopped`, `terminal_instances_ignore_late_heartbeats_and_duplicate_stop_events` (409 on late heartbeat, 200 on duplicate stop, session revoked).
- Console: `console_stream_accepts_with_token_and_returns_sse_content_type`, `console_clear_drops_the_daemons_own_history`, `console_detail_mode_can_be_read_back`.

For a new route, cover at least:

1. `401` without the token and with a wrong token.
2. The success status and the exact response shape.
3. The state change it claims to make (via a DB read or a store read).
4. Every error branch the handler implements (`400`, `404`, `409`, `500`), with the documented body.
5. Idempotency if the route is called by the wrapper retry/trap path.

For a changed route, add a regression case named after the reported scenario, not after the implementation detail.

## Unit tests inside `src/`

`launchd.rs` and `console_logger.rs` keep their pure helpers testable and test them without touching the system:

- `classify_bootstrap_result`, `classify_uninstall_result`, `classify_status_output` — the exact tolerated strings and the propagated errors.
- `render_plist` / `xml_escape` / `LABEL` — plist content, XML escaping, dev/prod label match, debug launcher wrapper.
- `LEGACY_LABELS` invariants: `current_label_is_not_in_legacy_list`, `foreign_labels_excludes_current`, `foreign_labels_returns_only_legacy_entries`.
- `is_own_crate`, `level_to_str`, and the `ConsoleEvent::Log` mapping in `console_logger.rs`; the logger tests use `tempfile::tempdir()` for the store so no real log directory is touched.

Rule: never execute `launchctl` from a test. It mutates the developer's or CI runner's LaunchAgents. Follow the existing pattern: extract the decision into a pure function (`classify_*`, `render_*`, `foreign_*`) and test that.

## Commands

```bash
cargo test -p cc-use-daemon                      # unit + integration
cargo test -p cc-use-daemon --test management_api
cargo test -p cc-use-daemon launchd               # filter by test name

# Cross-crate contract checks when touching the status line or token path:
cargo test -p cc-use --test daemon_client
cargo test -p cc-use --test management_token
```

Related app-side definitions worth reading before changing behavior: `src-tauri/src/daemon_client.rs` (status parsing, port probe), `src-tauri/tests/daemon_client.rs` (duplicated parser cases), `src-tauri/tests/management_token.rs` (token file semantics).

Avoid timing-dependent assertions where possible. `console_clear_drops_the_daemons_own_history` sleeps 200 ms because the clear is queued behind the writer thread; if you change the clear path, replace the sleep with a deterministic wait (`clear_and_wait`) instead of lengthening it.
