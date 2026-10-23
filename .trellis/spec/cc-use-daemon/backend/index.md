# cc-use-daemon — Backend Development Guidelines

> The always-on data plane of CC Use. Read this before touching `crates/cc-use-daemon/`.

## What lives here

`crates/cc-use-daemon/` builds the `cc-use-daemon` binary — a macOS LaunchAgent sidecar that owns the local proxy listener, routes `session-*` tokens to real provider keys, records managed-instance lifecycle, and serves the `/_management/*` API plus the console SSE stream. The Tauri app is the control plane; the daemon is the data plane (`CONTRIBUTING.md`, "数据面与控制面分离").

## Source map

| Source | Responsibility |
| --- | --- |
| `crates/cc-use-daemon/src/main.rs` | argv dispatch (`start [--foreground]`, `stop`, `restart`, `status`, `install`, `uninstall`) and process exit codes |
| `crates/cc-use-daemon/src/launchd.rs` | plist rendering, binary staging, `launchctl bootstrap/bootout/print`, dev/prod labels, status string |
| `crates/cc-use-daemon/src/runtime.rs` | foreground startup order, router assembly, bind, stale-instance sweeper |
| `crates/cc-use-daemon/src/management.rs` | `/_management/*` routing, `DaemonState`, management-token auth and token file resolution |
| `crates/cc-use-daemon/src/console_stream.rs` | console SSE endpoint (`/_management/console/stream`) |
| `crates/cc-use-daemon/src/console_logger.rs` | `log::Log` adapter: stderr + on-disk history + broadcast |
| `crates/cc-use-daemon/src/lib.rs` | public modules; the integration test imports `management` and `runtime` |
| `crates/cc-use-daemon/tests/management_api.rs` | router-level integration tests (tower `oneshot`, temp DB) |
| `crates/cc-use-daemon/Cargo.toml` | dependency boundary: `axum`, `tokio`, `cc_use_lib` — no `rusqlite`, no `clap` |

## Guidelines index

| Guideline | Use it when |
| --- | --- |
| [Architecture and Boundaries](./architecture-and-boundaries.md) | deciding whether code belongs in the daemon, `cc_use_lib`, or the app; dev/prod isolation |
| [Launchd Lifecycle](./launchd-lifecycle.md) | changing install/start/stop/status, the plist, labels, staging, or the status wire format |
| [Runtime Startup](./runtime-startup.md) | changing boot order, DB access, the sweeper, binding, or shutdown behavior |
| [Management API](./management-api.md) | adding or changing a `/_management/*` route, its auth, body shape, or status codes |
| [Console and Logging](./console-and-logging.md) | touching SSE, the log adapter, log levels, console file retention, or anything that could log a secret |
| [Testing](./testing.md) | writing tests for the daemon, or deciding what a change must cover |
| [Quality Guidelines](./quality-guidelines.md) | review checklist, forbidden patterns, required patterns |

Shared code follows [cc-use backend guidelines](../../cc-use/backend/index.md); the CLI that launches managed instances is described in [cc-use-cli backend guidelines](../../cc-use-cli/backend/index.md). Cross-package reasoning: [thinking guides](../../guides/index.md).

## Pre-Development Checklist

1. Read [Architecture and Boundaries](./architecture-and-boundaries.md) and confirm the change belongs in the daemon, not in `cc_use_lib` (`src-tauri/src/proxy/`, `src-tauri/src/db/`, `src-tauri/src/shared_runtime/`) or the Tauri app.
2. If the change touches the process surface (`main.rs`, `launchd.rs`, plist, status output), check both sides: `src-tauri/src/daemon_client.rs` parses the status line and spawns these commands.
3. If it touches a `/_management/*` route, list every in-repo consumer first: `src-tauri/src/commands/proxy.rs` (detail-mode), `src-tauri/src/commands/console.rs` (clear), `src-tauri/src/services/console_bridge.rs` (SSE), and the heartbeat/stop calls embedded in `src-tauri/src/terminal/mod.rs`'s wrapper script.
4. Never place real keys, session tokens, or the management token in a log line, an error string, or a JSON response.
5. Add or extend a test in `crates/cc-use-daemon/tests/management_api.rs` (routes) or the module's `#[cfg(test)]` block (pure helpers); see [Testing](./testing.md).
6. Update `CHANGELOG.md` when user-visible behavior changes (`CONTRIBUTING.md`).

## Quality Check

Run from the repository root:

```bash
cargo test -p cc-use-daemon
cargo clippy -p cc-use-daemon --all-targets
cargo fmt --all -- --check
```

If the change alters the daemon `status` output, the plist label, or the management-token path, also run the app-side checks that pin the other end of the contract:

```bash
cargo test -p cc-use --test daemon_client
cargo test -p cc-use --test management_token
```

Manual smoke test on macOS (rebuilds and restarts the dev daemon):

```bash
pnpm dev:daemon
./target/debug/cc-use-daemon status
```

Expected status format: `cc-use-daemon status; management_token_present=<bool>; launch_agent=<...>` — see [Launchd Lifecycle](./launchd-lifecycle.md#status-wire-contract).
