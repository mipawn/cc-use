# Console and Logging

The daemon has three output sinks. Keep them separate; each has a different lifetime and retention rule.

1. **stderr** — always written by `console_logger.rs`, and the only sink for third-party crates. Goes to launchd/unified logging (there is no plist log file) or to the terminal for `start --foreground`.
2. **On-disk console history** — bounded JSONL written by `cc_use_lib::services::console_log_store`, owned by this daemon process.
3. **Live SSE broadcast** — realtime `ConsoleEvent`s for the app's Console page.

## Live stream (`console_stream.rs`)

- Route: `GET /_management/console/stream`, authenticated with the same management token as every other `/_management` route.
- `state.proxy_state.console_tx.subscribe()` returns a `tokio::sync::broadcast::Receiver`; `BroadcastStream` converts it to SSE. Events are serialized with `serde_json::to_string` and sent as `data: <json>` frames; keep-alive comments are sent every 15 s (`KeepAlive::new().interval(15s).text("keepalive")`).
- **No replay.** A subscriber only sees events emitted after it connects. The Console page reads history from the on-disk store instead (see below).
- **Slow consumers lose events, never block the proxy.** Broadcast lag is filtered out (`Err(_) => None`). The channel capacity is `CONSOLE_CHANNEL_CAPACITY` in `src-tauri/src/proxy/mod.rs` (256); `ProxyState::emit_console` deliberately discards `send` errors when nobody is subscribed.
- The consumer is `src-tauri/src/services/console_bridge.rs`, which reconnects with capped backoff (1 s → 10 s), parses frames on blank lines, and re-emits them as the Tauri event `proxy:consoleEvent`. `ConsoleBridgeHandle::restart` is triggered by `src-tauri/src/commands/settings.rs` when the daemon toggle or proxy port changes, so the bridge does not stay attached to the old port.
- Serialization failures are reported with `eprintln!`, not `log::*`. Keep it that way: routing a serialization failure back through the console broadcast risks re-entering the same path.

## Log adapter (`console_logger.rs`)

`console_logger::install(proxy_state.console_tx.clone(), console_log)` is called once during boot, immediately after `ProxyState` exists (see [Runtime Startup](./runtime-startup.md)). It:

- installs the process-global `ConsoleLogger` if no logger is already set, and then sets the global level to `Info` (`log::set_max_level`); `debug`/`trace` calls are therefore not emitted by the daemon. If another logger was installed first, installation silently degrades to "no console broadcast" — never install a second logger.
- writes every record to stderr with this exact shape (UTC time):

  ```text
  2026-10-23 12:34:56 [ INFO] cc_use_daemon::runtime: daemon booted; binding 127.0.0.1:12345
  ```

  (format string: `"{date} {time} [{level:>5}] {target}: {args}"`; the level is right-aligned to 5 characters).
- broadcasts and persists **only records whose target starts with `cc_use`** (`is_own_crate`: `cc_use`, `cc_use_lib`, `cc_use_daemon`, module paths such as `cc_use_lib::proxy::handler`). Third-party targets (`hyper`, `rusqlite`, `tokio`, `rustls`, ...) still hit stderr but never the UI or disk — this filter is why the Console page is readable.
- converts the record to `ConsoleEvent::log(level_lowercase, "daemon", Some(target), message)`, then calls `store.record(event.clone())` and `sender.send(event)` (send errors ignored).

The daemon crate itself has exactly one `log::*` call site today (`runtime.rs`: the `info!` boot line); `launchd.rs` and `management.rs` return `String` errors instead of logging, and library code called from the daemon process (proxy handler, metrics writer) logs through the same adapter. Prefer returning errors to logging in request paths; log lifecycle events with `info`, recoverable degradations with `warn`, and things an operator must see with `error`.

## On-disk history

- Directory: `cc_use_lib::services::console_log_store::console_log_dir()` → `~/.cc-use/logs/console`.
- Source: `ConsoleLogSource::Daemon`; files are named `daemon-<epoch>-<index:05>.jsonl`. The app writes its own `app-*` family. Each process owns its files; neither deletes files the other is appending to (`POST /_management/console/clear` exists for that reason).
- Records are append-only JSONL; each record carries `v` (format version), `source`, `epoch`, `seq`, `at`, optional dedup `id`, and the `ConsoleEvent`. `epoch`/`seq` form the cursor so a reader can tell "restarted writer" from "wrong record".
- **Every process start takes a fresh epoch/file; a new writer never reuses an old process's active file.** Old closed files stay replayable. On a local-day rollover the writer flushes/closes its active file first, then creates a new one.
- Retention is a bounded recovery window, not an archive: **the current local natural day plus the previous two**, computed from each record's UTC event timestamp converted to the current local offset (never by parsing a local naive string). Maintenance runs at startup, on an idle `recv_timeout` tick (≤30 s, no traffic or hidden window needed), on every append's date/UTC-offset change check, and on rollover. Invalid or anomalously future timestamps are treated as corrupt (skipped/counted, physically dropped) so they cannot outlive the TTL. Capacity protection stays on top: 10 MiB per file, 5 files per source, 50 MiB per source, 100 MiB total, 256 KiB per record, writer queue of 2048. TTL is applied before capacity eviction, and an active file is never unlinked by either rule.
- Closed-file compaction rewrites kept records through a unique same-directory temp file plus atomic rename, preserving `id`/`epoch`/`seq` verbatim; fully expired files are deleted. Cross-process directory maintenance uses a `flock`-based lock (`libc`, no new crate) ordered after the in-process serializer, with unique temp metadata files and atomic rename. Lock failures surface as maintenance state, never through the log channel.
- Writer counters are per source: `dropped` (queue overflow), `writeFailed`, `trimmed`, `capacityEvicted` (persisted in source metadata so a restart can explain an incomplete window). `GET /_management/console/log-status` returns
  `{ available, dropped, writeFailed, trimmed, capacityEvicted }`; `available: false` means the owner is offline and must not be rendered as zero.
- Clearing is queued behind pending writes and now really waits (`clear_and_wait`); the response is `200 { ok, generation }` only after the daemon's own files are gone. A partial failure is reported per owner instead of as a blanket success. The writer thread deliberately never logs — a logger that writes into the log store would recurse.
- The app's renderer `console.*` lines reach the same app-owned files through the dedicated command `console_log_append_renderer`, which validates/redacts at the Rust trust boundary and only returns enqueue counts (`{ accepted, rejected }`) — it is not a disk acknowledgement.

## Secrets and privacy

`SECURITY.md` lists the red lines: no full key in logs / Console / error messages, no real key in client config or terminal environment. Apply them to every sink:

- Never log `Authorization`, `x-api-key`, `x-cc-use-management-token`, full `session-*` tokens, or provider key values. The daemon logs only lifecycle facts today (port, boot).
- Instance ids (`instance-<nanoid>`) are safe. The instance *label* shown in the UI is the last 8 characters of the session token (`build_instance_label` in `src-tauri/src/terminal/mod.rs`) — treat that short code as UI-visible, but never log the whole token.
- Request/response detail is captured only when `ProxyState::detail_mode` is on, and it goes through the desensitisation in `src-tauri/src/proxy/console.rs` (`desensitize_body`) before it reaches an event. Do not bypass it with an ad-hoc `eprintln!`.
- DB error strings are acceptable in management `500` responses; they contain paths and SQLite messages. Re-check that rule before returning strings from a new operation that handles credentials.
- Anything that would be unsafe in the Console page is also unsafe in the JSONL files, because the Console page rehydrates from those files after a reload.
