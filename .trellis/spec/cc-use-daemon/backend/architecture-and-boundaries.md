# Architecture and Boundaries

## Role: data plane, not control plane

The daemon is the only process that sees provider traffic. From `CONTRIBUTING.md`: 真实密钥永不落盘 (clients only get a `session-xxx` token; the real key stays inside the daemon) and 数据面与控制面分离 (the GUI is the control plane, `cc-use-daemon` is the resident data plane). Keep that split when adding code:

- The Tauri app (`src-tauri/`, crate `cc-use`, lib `cc_use_lib`) reads/writes configuration, prepares launches, renders UI, and supervises the daemon process.
- The daemon mounts the proxy router and forwards requests; it does not render UI, does not spawn terminals, and does not own settings.
- Clients (Claude Code, Grok Build, Codex Desktop, Claude Desktop) only learn `http://127.0.0.1:<port>` and a `session-*` token.

Request path:

```text
client -> 127.0.0.1:<settings.proxy_port> (daemon)
       -> cc_use_lib::proxy::handler::proxy_handler   (session token -> provider/key)
       -> provider API                                 (real key injected in-process)
```

Control path:

```text
GUI / wrapper script -> _management/* (x-cc-use-management-token) -> daemon state + DB
```

## What the daemon owns

- The listener: `runtime::run_foreground` binds `shared_runtime::network::proxy_bind_address(proxyListenScope, port)` — `127.0.0.1` by default, `0.0.0.0` only when the user explicitly set `proxyListenScope = "lan"` — and serves `runtime::build_daemon_router`, whose `fallback` is `cc_use_lib::proxy::handler::proxy_handler`. The management routes stay loopback-only in both modes (middleware in `management.rs`).
- Managed-instance lifecycle writes: `management::management_instance_heartbeat` / `management_instance_stop`, plus the background sweeper in `runtime.rs`.
- Its own console history: `ConsoleLogHandle::spawn(dir, ConsoleLogSource::Daemon)` under `~/.cc-use/logs/console`.
- Management token generation on boot: `management::resolve_management_token` -> `shared_runtime::ensure_management_token`.

## Code placement rules

| Concern | Lives in | Do not |
| --- | --- | --- |
| Proxy forwarding, session auth, key selection, upstream routing | `cc_use_lib` (`src-tauri/src/proxy/`, `src-tauri/src/shared_runtime/`) | Re-implement any of it inside `crates/cc-use-daemon/` |
| SQLite schema, queries, migrations | `cc_use_lib::db` (`src-tauri/src/db/`) | Add `rusqlite` to the daemon; it only calls `Database` methods |
| Management token file format, validation | `src-tauri/src/shared_runtime/management_token.rs` | Add a second token scheme or a second token path |
| `session-*` token format | `src-tauri/src/shared_runtime/session_token.rs` | Mint tokens with a different prefix or shape |
| Launch preview / wrapper script / instance rows | `src-tauri/src/terminal/mod.rs` (`prepare_cli_terminal_launch`) | Create instances from the daemon |
| LaunchAgent plist, staging, `launchctl` calls | `crates/cc-use-daemon/src/launchd.rs` | Teach the Tauri app to write plists directly |
| `/_management/*` HTTP surface | `crates/cc-use-daemon/src/management.rs` | Add management routes to the app process |
| Live console transport | `crates/cc-use-daemon/src/console_stream.rs` + `ConsoleEvent` in `src-tauri/src/proxy/console.rs` | Invent an ad-hoc event format for the UI |

The daemon crate deliberately has no `rusqlite`, no `clap`, and no `tauri` dependency; `Cargo.toml` pulls `cc_use_lib` with `default-features = false`. Adding a direct dependency for a concern that already exists in `cc_use_lib` is a design smell — check `crates/cc-use-daemon/Cargo.toml` before adding one.

Note that `cc_use_lib` is the `[lib]` target of the Tauri package (`src-tauri/Cargo.toml`, `name = "cc_use_lib"`), so linking it pulls the app's dependency graph. The daemon may call the library modules that do not require a running Tauri app — `db`, `models`, `proxy`, `services`, `shared_runtime` — but must never call `cc_use_lib::run()` or Tauri command functions. Terminal launching (`terminal`, `statusline_config`) is app/CLI territory, not the daemon's.

## Two independent auth planes

1. **Session tokens** (`session-*`) authenticate proxy traffic. They are minted in `cc_use_lib` and resolved by `proxy_handler`. They never authorize `/_management/*`.
2. **Management token** (`mgmt-*`) authenticates `/_management/*` only, via the `x-cc-use-management-token` header (`management::require_management_token`, `console_stream::console_stream`). It lives at `~/.cc-use/state/management-token`, is created by `shared_runtime::ensure_management_token`, and is written with mode `0600`.

Never make a management route accept a session token, and never let a proxy path accept the management token. The wrapper script written by `src-tauri/src/terminal/mod.rs` exports the management token to post heartbeat/stop calls — that script is the reason the management token must stay readable by the app process.

## Dev/prod isolation

All three crates branch on `cfg!(debug_assertions)`; app and daemon must agree or the app will drive the wrong process.

| Concern | Dev | Prod |
| --- | --- | --- |
| LaunchAgent label (`launchd.rs` `LABEL`) | `com.mipawn.cc-use.dev.daemon` | `com.mipawn.cc-use.daemon` |
| Support dir (`launchd.rs` `APP_SUPPORT_DIR`) | `com.mipawn.cc-use.dev` | `com.mipawn.cc-use` |
| SQLite data dir (`src-tauri/src/db/mod.rs` `app_data_dir_name`) | `com.mipawn.cc-use.dev` | `com.mipawn.cc-use` |
| Default proxy port (set once in `src-tauri/src/lib.rs` setup) | `22345` | `12345` |
| Daemon binary the app may spawn (`src-tauri/src/daemon_client.rs` `resolve_daemon_binary_path`) | `target/debug/cc-use-daemon` only | bundle beside the app executable only |

Rules:
- Never fall back from one profile's daemon to the other. `resolve_daemon_binary_path` intentionally refuses cross-profile fallback; that fallback was the cause of prod apps binding the dev port.
- Never reintroduce a runtime env-var or argv override to select a profile. The compile-time `cfg!` pair is the contract.
- `LEGACY_LABELS` in `launchd.rs` exists to retire old *labels*; it must never contain the current dev or prod label (see [Launchd Lifecycle](./launchd-lifecycle.md#labels-and-legacy-cleanup)).

## One daemon per profile

`docs/v4.0.0/prd.md` R07 requires one gateway service carrying every logical exit. The current code already has a single listener per profile and no per-client listener; keep it that way. The daemon is not a supervisor: it never starts another daemon, never forks per request, and the only background task it spawns itself is the stale-instance sweeper (`runtime::spawn_managed_instance_sweeper`). The console-log writer and the metrics writer are background threads owned by `cc_use_lib` handles.
