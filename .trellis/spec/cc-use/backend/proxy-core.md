# Proxy Core

> The data plane. Code lives in `src-tauri/src/proxy/` and runs inside the
> `cc-use-daemon` process (`crates/cc-use-daemon/src/runtime.rs` mounts
> `proxy::handler::proxy_handler` as the router fallback). Tests drive the same handler
> directly without opening a port.

---

## Files

| File                    | Responsibility                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `proxy/mod.rs`          | `ProxyState`, concurrency permits, console/metrics fan-out, `build_proxy_state*`, `build_proxy_router`, unit tests for limits        |
| `proxy/handler.rs`      | The 4k-line request pipeline: auth, routing, request shaping, upstream call, streaming relay, usage parsing, logging, console events |
| `proxy/usage_parser.rs` | `TokenUsage`, non-stream JSON parsing, `StreamUsageAccumulator` for SSE                                                              |
| `proxy/auto_mode.rs`    | Claude Code permission-classifier detection and response compatibility (no body rewriting)                                           |
| `proxy/console.rs`      | `ConsoleEvent` tagged union, redaction/truncation helpers, `build_detail_fields*`                                                    |
| `proxy/key_selector.rs` | `select_key(db, provider_id)` — highest-priority active, non-exhausted key                                                           |

`key_selector::select_key` is **not** used by the request path and there is no load
balancing: a request is routed to the explicit key named by its session token. Do not
describe or implement “automatic key selection” in the proxy without changing the session
model first.

---

## Request Pipeline (`handler.rs::proxy_handler`)

Order matters; every early exit emits a console event.

1. `request_count.fetch_add(1)`, allocate `request_id = nanoid!`, capture method/path.
2. `classify_request_auth(authorization, x-api-key)` →
   `SessionToken | ProviderCredential | Missing` (`shared_runtime/route_plan.rs`).
3. Acquire concurrency permits: global (64) always; per-session (16) when the auth is a
   session token (`ProxyState::try_acquire_request_permits`). Rejection is HTTP 429 with a
   console `rejected` event.
4. Lock the DB, compute `route_plan_with_codex_takeover_fallback` and
   `build_route_execution`, drop the lock. Nothing after this point holds the DB guard
   across an `.await`.
5. `GET /v1/models`, `/models`, `/claude-desktop/v1/models`, `/claude/v1/models`,
   `/openai/v1/models` are answered from the model catalog (`services::model_catalog`)
   with `x-cc-use-model-catalog-source` / `...-fetched-at` headers, never from the
   inference alias table.
6. WebSocket upgrade (`upgrade: websocket`) → build upstream WS request (headers rebuilt by
   `build_upstream_ws_request`), connect via
   `connect_upstream_websocket`/`open_websocket_transport` (HTTP CONNECT tunnel when the
   provider has `http_proxy`), emit `ws` console event, then `ws_relay` in the upgrade task
   while holding the permits.
7. HTTP: `apply_upstream_auth_headers` (bearer vs `x-api-key`, chosen by
   `route_uses_bearer_auth` and the per-key `authScheme`), strip hop-by-hop headers, remove
   `accept-encoding` / `host` / `content-length`.
8. Read body ≤ `MAX_REQUEST_BODY_BYTES` (50 MiB), parse JSON, remember `model` and
   `stream`, apply `apply_model_mapping`, label Claude Messages classifier requests via
   `auto_mode::is_classifier` (no body rewrite), then `apply_provider_headers` (additive)
   and `apply_chosen_user_agent` (replacing). Emit `pending` (with detail fields only when
   `detail_mode` is on) and arm `RequestCancellationGuard`, which emits a `cancelled` event
   if the request future is dropped before completion.
9. Send via the cached client from `services::http_client::outbound_client_for_provider`
   (proxy-aware, 10 s connect timeout). Transport failure → record a
   `transport_error` request log and return 502.
10. `count_tokens` fallback: if the path is a count-tokens path and upstream answers
    404/405/501, answer locally with `estimate_input_tokens` and the
    `x-cc-use-count-tokens: estimated` header plus a console `estimated` event.
11. SSE (`content-type: text/event-stream`): stream through
    `SseModelNormalizingStream` + `UsageTrackingStream`; the accumulator parses usage,
    captures the first/last token timing, optionally captures detail bytes, and records the
    request log exactly once when the stream ends. If the client disconnects mid-stream,
    `Drop for UsageTrackingStream` records a `transport_error` row and emits a `cancelled`
    console event instead of a success. Bytes forwarded to the client are the untouched
    originals (decompression is only for capture/parsing).
12. Non-stream: enforce `MAX_NON_STREAM_RESPONSE_BYTES` (64 MiB), decompress only for
    inspection (`decompress_limited`), normalize Grok/Chat-Completions `model`, parse usage,
    decide whether to write `request_logs`, build console `ok` event with detail fields,
    forward the original bytes unless the body was re-serialized (then drop
    `content-encoding` / `content-length`).

### Size limits (do not raise casually)

| Constant                                      | Value           | Meaning                 |
| --------------------------------------------- | --------------- | ----------------------- |
| `MAX_REQUEST_BODY_BYTES`                      | 50 MiB          | Incoming HTTP body      |
| `MAX_NON_STREAM_RESPONSE_BYTES`               | 64 MiB          | Buffered response       |
| `MAX_DECOMPRESSED_CAPTURE_BYTES`              | 64 MiB          | Decode budget           |
| `MAX_COMPRESSED_STREAM_CAPTURE_BYTES`         | 16 MiB          | Compressed SSE capture  |
| `MAX_STREAM_DETAIL_CAPTURE_BYTES`             | 256 KiB         | Detail-mode stream body |
| `MAX_SSE_MODEL_NORMALIZATION_LINE_BYTES`      | 1 MiB           | One SSE line            |
| `MAX_WS_MESSAGE_BYTES` / `MAX_WS_FRAME_BYTES` | 64 MiB / 16 MiB | WebSocket relay         |

---

## Route Selection

`decide_route_plan` is the only routing decision:

| Auth                                                            | Plan                | Result                                                                                                                  |
| --------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `session-…` token                                               | `ExplicitSession`   | Resolve session → provider → key; reject on revoke/expiry/disabled/exhausted/client mismatch                            |
| Provider credential (non-session `Authorization` / `x-api-key`) | `PassThrough`       | Infer upstream family from path (`infer_upstream_family_from_path`) and forward to the official URL; no logging context |
| No auth                                                         | `RejectMissingAuth` | 401 + `rejected` console event                                                                                          |

**Gateway outlets** reuse the `session-…` path: a `proxy_sessions` row with
`session_kind='gateway'`, `expires_at=NULL`, `cli_type=NULL`, exactly one
`api_key_id`, and `is_active=1`. They skip the managed-instance gate, reject with
403 `Gateway is disabled` when inactive, and force `cli_type=None` in
`build_route_execution` so the local model-catalog intercept, auto-mode
classifier labeling, client compatibility check and `/v1/responses` inference are
all bypassed. The `count_tokens` local estimate is also skipped for gateways.
`proxy_session_cleanup_stale` excludes `gateway` (like `desktop`) and
`session_list` hides them; `gateway_list` is the dedicated query. Deleting a key
or provider removes the gateway rows bound to it.

Codex Desktop has one documented exception: when a `/v1/responses` request arrives with a
provider credential, `route_plan_with_codex_takeover_fallback` substitutes the session
token stored under `CODEX_SESSION_TOKEN_SETTING_KEY` **only if that session exists**. Codex
Desktop therefore uses config takeover (`~/.codex/config.toml` with a session token), not a
credential in the client config (`commands/codex_config.rs` module docs).

`resolve_session_resources` validation order (each failure is a `rejected` event with the
matching status): session exists → not revoked → not expired → managed instances still
active (`launching`/`running`/`stale`) → provider exists → provider active → key exists →
key belongs to provider → key active → key not exhausted → key supports the session’s client
→ touch `last_seen_at`.

Upstream URL resolution for an explicit session, in order:
`apiKey.clientConfigs[cliType].baseUrl` → `provider.baseUrl`
(`build_route_execution`), then `build_provider_upstream_url` joins the path (strips the
`/claude-desktop` prefix for Claude Desktop). Never read `provider.base_url` directly in a
command or the renderer.

---

## Model Shaping (all through shared helpers)

- `apply_model_mapping` uses `shared_runtime::model_mapping` scoped to the session’s client
  kind; the alias table (`alias_table_key(api_key_id, kind)`) maps catalog ids back to real
  provider ids.
- `auto_mode` no longer rewrites request bodies. It only identifies Claude Messages
  classifier requests (system prompt substring + final `<transcript>` envelope + absence
  of tools) so the pipeline can label them `request_kind=auto_mode` for the console and
  statistics. Auto mode compatibility is a launch-time concern instead:
  `terminal::resolve_launch_preview` calls
  `shared_runtime::launch_preview::apply_auto_mode_launch_env`, which injects
  `CLAUDE_CODE_AUTO_MODE_SERVER=0` and `CLAUDE_CODE_AUTO_MODE_MODEL` when the key's
  `autoMode.enabled` names a non-empty model
  (`shared_runtime::model_mapping::auto_mode_classifier_model`). Explicit user env wins,
  the default is no injection, and `safeguards` / `safeguard_results` pass through
  untouched. Tests in `proxy/auto_mode.rs`, `tests/launch_preview.rs`, and
  `tests/terminal_launch_preview.rs` pin this.
- Header policies are intentionally opposite and both live in `shared_runtime`:
  provider request headers are additive (`apply_provider_headers` skips names the client
  already sent), a chosen User-Agent replaces (`user_agent::apply`).

---

## Usage Accounting

`usage_parser::TokenUsage` has four counters: `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_creation_tokens`. The parser accepts Anthropic-style
(`input_tokens` / `output_tokens`, with cache fields) and OpenAI-style
(`prompt_tokens` / `completion_tokens`, `prompt_cache_hit_tokens`,
`prompt_tokens_details.cached_tokens`) shapes, and treats cache-read as a subset of input
where the provider includes cache in the input count.

Write policy (v3.7.0, comment in `proxy/handler.rs` before the write):

- success **with** billable usage → write a `request_logs` row;
- any failure (client/upstream/transport error) → write a row with the outcome;
- success **without** usage (model listing, etc.) → skip; writing it would inflate request
  counts.

Every row carries `session_id` (the session token), snapshot display names
(`key_alias`, `provider_name`, `project_name`), `request_id` (shared with console events),
`outcome` and optional `error_message` truncated to `MAX_ERROR_MESSAGE_BYTES`. Requests are
attributed from the session, not from whatever the client claims in the body.

---

## Concurrency, Cancellation, Side Effects

- Global semaphore 64, per-session semaphore 16; the per-session map is pruned when it
  grows past 1024 entries and a stale map entry is dropped when its strong count is 1.
- Permits are held for the whole request and moved into the streaming/WebSocket task.
- `RequestCancellationGuard` fires on drop unless disarmed; it emits a `cancelled` event
  (not a success and not an upstream failure, so success-rate metrics stay honest).
- `ProxyState::emit_console` is the only fan-out: it skips metrics for `pending` /
  `cancelled`, persists to the process’s console log when attached, then broadcasts on the
  `broadcast::Sender<ConsoleEvent>` (capacity 256; no subscribers → the event is dropped).
- Gateway metrics go through a **dedicated writer thread** fed by
  `mpsc::sync_channel(1024)` (`try_send`, drops on full with a debug log). Do not write
  metrics from the async request path.
- Detail mode is a flag on `ProxyState` (`detail_mode: AtomicBool`), toggled by the daemon
  management endpoint, snapshotted at dispatch time. It only adds redacted,
  truncated fields to console events — it must never change proxy behavior.
- `last_error` (`Arc<Mutex<Option<String>>>`) is the only error telemetry the app polls; it
  is set on upstream/WebSocket failures.

---

## Error Semantics

`proxy_handler` returns `Result<Response<Body>, Response<Body>>`. Every failure path must
produce both:

1. a client response via `handler::error_response(status, message)` with a plain-text JSON
   body, and
2. a `ConsoleEvent` explaining what happened to the operator.

A non-2xx upstream response is emitted as `ConsoleEvent::upstream_response_error` (kind
`upstream_error`, real status, truncated message), not `ok`. Streaming responses are
classified by status first, then by the protocol completion marker
(`message_stop` / `response.completed` / non-null `finish_reason` / `[DONE]`): a 2xx stream
that ends without one is recorded as `transport_error`. Client cancellation writes a
`transport_error` row (`Client disconnected before response`) in addition to the
`cancelled` event. Console history recorded by older builds may contain `ok` rows with a
4xx/5xx status; the renderer reclassifies them for display.

Messages are shown in the UI: no keys, tokens, or full request bodies. Keep them short
(`extract_error_message` truncates upstream error bodies).

---

## Rules

- Route decisions belong in `shared_runtime::route_plan` and `build_route_execution`; do not
  branch on paths in commands or in the renderer.
- Model mapping, presets, header policy and session tokens belong in `shared_runtime` so the
  daemon and CLI behave identically.
- Any new side effect on the request path must be non-blocking (channel, spawned writer) or
  bounded; never take the DB mutex across `.await`, never call a blocking TCP/HTTP API
  directly in the reactor (use `spawn_blocking`, as `commands/proxy.rs` does for port probes).
- Forwarding must preserve semantics for the client: byte-for-byte where possible; if you
  rewrite a body, remove stale `content-encoding`/`content-length` and document why.
- Streaming parsers must keep line buffering across transport chunks (bytes, not `String`,
  so split UTF-8 codepoints survive) and cap the line buffer
  (`MAX_SSE_LINE_BUFFER_BYTES`).
- Tests: `src-tauri/tests/proxy_auth.rs`, `proxy_handler_auth.rs`, `proxy_handler_console.rs`
  call the handler with a `build_proxy_state(...)` and assert status + `console_tx` events;
  `proxy_websocket.rs` runs a real local axum upstream through `build_proxy_router`.

## Anti-Patterns

- Adding a second router/handler or a second copy of the route decision in `commands/`.
- Reading the real key from the session and putting it on the client response, in a header
  the client sees, or in a log line.
- Writing `request_logs` / `gateway_request_events` directly in the async path instead of
  the existing `record_usage` / metrics writer.
- Treating a `cancelled` request as an upstream error in metrics.
- Changing behavior based on `detail_mode`.
- Unbounded buffering of bodies or SSE lines.
