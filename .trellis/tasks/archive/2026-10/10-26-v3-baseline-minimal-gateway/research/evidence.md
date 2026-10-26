# Evidence for 3.14.2 relaunch

Collected 2026-10-26 on branch `feat/v3.14.2-gateway-relaunch` (product code = tag `v3.14.2`).

## Baseline

- `git diff v3.14.2 HEAD -- src src-tauri crates` is empty.
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` (0 errors / 3 existing warnings), `pnpm test`, `cargo test -p cc-use-daemon`, `cargo fmt --all -- --check` all pass.

## Gateway architecture

- Only `cc-use-daemon` serves the proxy: `crates/cc-use-daemon/src/runtime.rs:34-46` sets `.fallback(daemon_proxy_handler)` → `cc_use_lib::proxy::handler::proxy_handler`.
- Auth classification: `src-tauri/src/shared_runtime/route_plan.rs:3-36`.
  - `session-` prefix → `ExplicitSession`; other credential → `PassThrough`; none → reject.
- Resolution: `src-tauri/src/proxy/handler.rs:1085-1192` (`build_route_execution`), `:1210-1349` (`resolve_session_resources`).
  - `session_kind == "managed"` requires an active managed instance (`:1251-1274`); other kinds skip it.
  - `expires_at = NULL` means no expiry (`:1241-1249`).
  - `cli_type = NULL` skips client compatibility (`:1334`), local model catalog intercept (`:361-365`), and auto-mode adaptation (`:551-558`).
- Local catalog intercept requires `cli_type` Some (`handler.rs:351-421`); `count_tokens` fallback is path-only (`:730-756`) and needs a `cli_type.is_some()` guard for gateway.
- Cleanup deletes all non-desktop sessions older than 30 days: `src-tauri/src/db/proxy_sessions.rs:188-198`.
- `proxy_sessions` schema: `src-tauri/src/db/mod.rs:224-236`; `ProxySession` model: `src-tauri/src/models/mod.rs:308-322`; TS mirror: `src/shared/types/index.ts:685-691`.
- `session_create` pattern: `src-tauri/src/commands/proxy.rs:239-264` (manual, 24h expiry).
- Daemon is a LaunchAgent with `RunAtLoad`/`KeepAlive` and a 30s app watchdog: `crates/cc-use-daemon/src/launchd.rs:255-284`, `src-tauri/src/lib.rs:310-416`.
- App and daemon share the same SQLite file (WAL): `src-tauri/src/db/mod.rs:37-79`.

## Provider UI

- The provider workspace is `/keys` (`src/renderer/pages/Keys.tsx`), not a separate Providers page.
- Quota block: `Keys.tsx:815-846`; component `ProviderUsageWindows.tsx`.
- Tight spacing root causes: `Keys.module.css:381-383` `.providerQuota { padding: 0 16px 14px; }`; `ProviderUsageWindows.module.css:26-30` `.reset` has no `margin-top`.
- Query button: `Keys.tsx:832-844` is a bare small button, shown only when there is a query script and no cached data; duplicates the header refresh icon at `Keys.tsx:730-748`.
- Model add flow: `KeyEditModal.tsx:514-537` → `ModelMappingEditor.tsx` → `ModelCatalogManager.tsx`.
- Fetch is transient (no DB write): `provider_model_catalog_preview` → `services/model_catalog.rs:67-74,76-196` (`persist=false`).
- Confusion: `ModelCatalogManager.tsx:93-95` auto-selects all catalog models when `selectionTouched=false`; custom-source list looks pre-added. Apply → key modal Save is still required.

## Auto mode (latest Claude Code, 2.1.310, 2026-10-23)

- Auto mode is GA and default for interactive sessions since 2.1.283; since 2.1.278 it asks the server for review by default whenever `ANTHROPIC_BASE_URL` points at a gateway.
- Server review is in-band: request adds an `anthropic-beta` value + `safeguards` body field; response/SSE adds `safeguard_results`.
- Official gateway guide: forward `anthropic-beta` verbatim, preserve unknown request/response fields, do not rewrite bodies/tool-use IDs/error bodies, keep streams alive.
- Client-side classifier only runs when server review is off/unavailable (`CLAUDE_CODE_AUTO_MODE_SERVER=0`); default model Claude Sonnet 5, override `CLAUDE_CODE_AUTO_MODE_MODEL` (2.1.302+).
- Local adapter `src-tauri/src/proxy/auto_mode.rs` is pinned to CC 2.1.220: exact system prefix, `<transcript>` envelope, no tools, `metadata.user_id.session_id`; it forces `thinking: enabled, budget_tokens: 1024`, `max_tokens >= 4096`, `output_config.effort: low`, and removes `temperature/top_p/top_k`.
- Current models use adaptive thinking; `thinking.type.enabled` is a known error case. The forced rewrite is unsafe; the default must be no change at all (adapter off), and the UI should show "不改（跟随 Claude Code）" rather than a named "preserve" default.
- New-key default is inconsistent: `src/renderer/utils/apiKeyEditor.ts:97-118` enables auto mode unless the template says otherwise; README says off; Rust default is off.
- Product decision (2026-10-26): default is **no adaptation at all** (pure pass-through). Adaptation is an opt-in "Auto mode compatibility" feature for providers that cannot support Claude Code's native auto mode; it is proxy-side only — no launch environment variables are injected, and the adapter only maps the classifier model, leaving thinking/effort alone unless explicitly configured.
- Sources: `https://code.claude.com/docs/en/permission-modes.md`, `https://code.claude.com/docs/en/llm-gateway-protocol.md`, `https://code.claude.com/docs/en/auto-mode-classifier-billing.md`, `https://code.claude.com/docs/en/env-vars.md`, `https://code.claude.com/docs/en/changelog.md`.

## Console / error observability

- `ConsoleEvent::ok` hardcodes `kind: "ok"` (`proxy/console.rs:355-389`); `upstream_error` hardcodes `status: None` (`:428-457`).
- Non-streaming always emits `ok` regardless of status: `proxy/handler.rs:1006-1016`.
- Streaming normal end always emits `ok`: `handler.rs:2525-2535`.
- `finalize_usage` classifies by billable usage + status; non-2xx without usage becomes `transport_error` with a generic message, losing the real status/body: `handler.rs:2287-2337` (esp. `:2309-2335`).
- No stream completion marker in `StreamUsageAccumulator`: `proxy/usage_parser.rs:127-354`.
- Client cancellation emits only a console event, no DB row: `handler.rs:245-257`.
- Decompression failure is warn-only: `handler.rs:911-923`.
- Auto-mode classifier 200 without usage is skipped as success: `handler.rs:929-937,961-983`.
- WS post-upgrade errors only debug-log: `handler.rs:2861-2890`.
- Console UI: `isProblemEvent` (`Console.tsx:126-132`) ignores `cancelled`; color/tag by `kind === 'ok'` (`:62-77,401,418,525`).
- `request_logs` already has `outcome`, `status_code`, `error_message` (`db/mod.rs:200-225`); no new column is required for the required fixes.

## Menu bar

- Tauri config: `src-tauri/tauri.conf.json:15-43,72-74` (no Info.plist/activation policy).
- Dock toggles exist at `src-tauri/src/lib.rs:427-430`, `tray.rs:673-682`, `commands/system_ext.rs:87-96`.
- Close behavior: `lib.rs:418-443`; `closeToTray=false` destroys the last window and exits (no Dock to reopen).
- No `RunEvent::Reopen` handler: `lib.rs:447-448`.
- Prior working implementation in git: commit `bc200fb` (Info.plist LSUIElement, `set_activation_policy(Accessory)`, removed dock toggles, `show_main_window` + Reopen).
- Tray already exists: `tauri.conf.json:38-43`, `tray.rs:433-503`.
- No automated window-lifecycle tests; manual macOS acceptance required.
