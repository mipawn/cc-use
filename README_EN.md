# CC Use

A desktop configuration manager for **Claude Code / Grok Build / Codex Desktop / Claude Desktop**. CC Use manages providers, keys, the local gateway, and desktop config takeover so multiple clients can share one observable key system.

[中文文档](./README.md)

> **3.3.4 Update**: Fixes Grok Build foreground launch and missing response models, adds custom project groups and per-launchpad instance isolation, and improves success-rate and token-unit displays.
>
> **🎉 3.2.0 Update**: The app is now organized around three clients: Claude Code, Codex Desktop, and Claude Desktop. Codex CLI launch support has been removed; Codex Desktop and Claude Desktop use config takeover instead. See [CHANGELOG](./CHANGELOG.md).
>
> **3.0 Architecture Update**: The local proxy is now an independent `cc-use-daemon` process, with instance identity explicitly modeled at launch time.
>
> **⚠️ Platform change**: Starting from 3.0, **only macOS is supported** — Windows builds are no longer published, and Windows-specific code is no longer maintained.
>
> **Historical migrations**: [From 1.x](./guides/MIGRATION_EN.md) · [From 0.x (cc-switch)](./guides/MIGRATION_FROM_CC_SWITCH_EN.md)

## Screenshots

|                 Dashboard                 |               Key Management               |
| :---------------------------------------: | :----------------------------------------: |
| ![Dashboard](./screenshots/dashboard.png) | ![Key Management](./screenshots/token.png) |

|                Project Management                |               Statistics                |
| :----------------------------------------------: | :-------------------------------------: |
| ![Project Management](./screenshots/project.png) | ![Statistics](./screenshots/statis.png) |

|                Settings                 |                Instances                 |
| :-------------------------------------: | :--------------------------------------: |
| ![Settings](./screenshots/settings.png) | ![Instances](./screenshots/instance.png) |

## Features

- **Provider & Key Management** - Manage providers and API keys on the unified Keys page; each key can target Claude Code, Grok Build, Codex Desktop, and Claude Desktop, with priority ordering, balance/usage queries, cost multipliers, and model mapping
- **Separate CLI Workspaces** - Claude Code and Grok Build each have their own launchpad in the sidebar; project directories can be reused, while provider, key, pre-launch command, and runtime instances stay isolated per client
- **Custom Project Groups** - Create or reuse named groups when editing a project; legacy projects fall back to Ungrouped instead of being forced into filesystem parent-directory groups
- **CLI Launch** - Click a project to launch a terminal; the wrapper injects a session token, instance metadata, and the local daemon URL while keeping the real key out of the terminal environment
- **Codex Desktop Config Takeover** - Writes a `cc-use` provider and stable `experimental_bearer_token` to `~/.codex/config.toml` while preserving `auth.json`; after the first restart, switching keys can update the daemon route without rewriting the desktop config
- **Claude Desktop Config Takeover** - Writes a Claude 3P profile and configLibrary entries pointing to `http://127.0.0.1:<port>/claude-desktop`, with config preview, official restore, and model-list takeover
- **Local Daemon Service** - A standalone `cc-use-daemon` process acts as the local gateway, routing by session token to the current provider/key and enabling cost tracking and hot-switching
- **Instance Management** - Each launchpad's Instances tab only shows managed instances from that client and only allows hot-switching to compatible keys
- **Cost Tracking** - Automatically logs token usage and cost for every API request; Chinese uses ten-thousand/hundred-million units, English uses `K / M / B`, and tooltips show exact counts
- **Statistics** - Dashboard shows today's cost, request count, daily trends, and top keys/projects; Statistics page provides detailed breakdowns by key/provider/client/model with request history
- **System Tray** - Minimize to tray on close while the daemon keeps running; tray menu supports service control and quick-launching recent projects
- **Auto Update** - In-app update detection and download with progress display (signature verification via `tauri-plugin-updater`)
- **Claude Code Config Management** - Global and per-key local configuration (JSON), automatically merged and injected at launch; the editor now lives on the Claude Code page
- **Internationalization** - Chinese and English UI
- **Dark Mode** - Light/dark theme switching

## Installation

Download the macOS installer from [Releases](https://github.com/mipawn/cc-use/releases):

| Platform | Format |
| -------- | ------ |
| macOS    | `.dmg` |

## Usage

### 1. Add Providers and Keys

Go to the Provider Keys page:

1. Click "Add Provider" - fill in name, Base URL, choose an icon, optionally configure token and balance query
2. Click "Add Key" under a provider - enter the key value and select target clients (Claude Code / Grok Build / Codex Desktop / Claude Desktop)
3. Configure cost multiplier, usage query, and model mapping as needed; only Claude Code shows local CLI config

### 2. Use Claude Code / Grok Build

Open either the Claude Code or Grok Build page from the sidebar:

1. Create a project from the Projects tab and select a custom group, project folder, and the current client's provider and key
2. Click the project launch button to open a terminal and create a managed instance
3. Use the current launchpad's Instances tab to inspect runtime state or switch to a compatible key; instances from the other CLI are not mixed in
4. Claude Code also provides a Global Config tab

Claude Code launches with `ANTHROPIC_BASE_URL`; Grok Build maintains a `cc-use` custom model in `~/.grok/config.toml`, injects its session token through `CC_USE_GROK_TOKEN`, and runs as the foreground TUI. Both connect only to the local daemon, while the real key stays inside it. See the [Grok Build integration guide](./guides/GROK_BUILD_EN.md) for configuration and troubleshooting.

### 3. Take Over Codex Desktop

Go to the Codex Desktop page:

1. Select a key that supports Codex Desktop
2. Apply takeover; CC Use writes `~/.codex/config.toml` and backs up `config.toml` / `auth.json`
3. Restart Codex Desktop after first takeover or official restore

Takeover does not rewrite `auth.json`, so official ChatGPT login and plugin capability are preserved. Once already taken over, switching keys only updates the daemon session route, so Codex Desktop's next request can use the new key.

### 4. Take Over Claude Desktop

Go to the Claude Desktop page:

1. Select a key that supports Claude Desktop
2. Apply takeover; CC Use writes the Claude 3P profile, `_meta.json`, and the related config files
3. Preview the generated config or restore official config at any time

Before takeover, CC Use probes the local daemon's model-list endpoint. Model mapping is also reflected in Claude Desktop's inference model list.

### 5. Daemon Service

The local daemon service is launched with the app and stays resident — terminals always go through it:

- Requests use session tokens instead of real API keys
- Token usage and cost are automatically logged for every request
- Hot-switch keys: Claude Code / Grok Build switch running instances from the Instances tab; Codex Desktop / Claude Desktop update daemon routing through stable config-takeover tokens

Check service status and port on the Settings page; click "Restart Service" if anything goes wrong.

### 6. Identify the Current Instance · Claude Code Status Line

When launching a terminal, cc-use injects a handful of environment variables so you can tell which managed instance the current window belongs to:

| Variable                  | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `CC_USE_INSTANCE_ID`      | Instance UUID — matches a row on the Instances page                     |
| `CC_USE_INSTANCE_LABEL`   | Short code (last 8 chars of the session token), ideal for the statusbar |
| `CC_USE_PROXY_PORT`       | Local daemon port                                                       |
| `CC_USE_MANAGEMENT_TOKEN` | Management token — **do not display**; used only by wrapper ↔ daemon    |

When running multiple windows, surface `CC_USE_INSTANCE_LABEL` via the Claude Code [statusLine](https://docs.claude.com/en/docs/claude-code/statusline) so you can tell at a glance which instance a window is bound to.

**The author personally uses [claude-hud](https://github.com/jarrodwatts/claude-hud)** — its `--extra-cmd` option appends `CC_USE_INSTANCE_LABEL` to the rendered status line as `{"label":"..."}` JSON. Reference `~/.claude/settings.json`:

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "bash -lc 'hud_dir=$(ls -td ~/.claude/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null | head -1); [ -n \"$hud_dir\" ] || exit 0; bun \"${hud_dir}src/index.ts\" --extra-cmd \"bash -lc '\\''[ -n \\\"\\$CC_USE_INSTANCE_LABEL\\\" ] && printf \\\"{\\\\\\\"label\\\\\\\":\\\\\\\"%s\\\\\\\"}\\\" \\\"\\$CC_USE_INSTANCE_LABEL\\\"'\\''\"'",
  },
}
```

Install steps: inside Claude Code, run `/plugin marketplace add jarrodwatts/claude-hud` → `/plugin install claude-hud` → `/claude-hud:setup`, then extend the generated `statusLine.command` with `--extra-cmd` as shown above.

Don't want claude-hud? Any command that reads `$CC_USE_INSTANCE_LABEL` and prints a single line works as a `statusLine`.

## How It Works

On startup, the app spawns a standalone `cc-use-daemon` process as the local gateway. Each client reaches the same daemon through a different integration form:

```
Claude Code wrapper → localhost:12345 (daemon) → actual API provider
Grok Build wrapper → localhost:12345/v1 (daemon) → actual API provider
Codex Desktop config.toml → localhost:12345/v1 (daemon) → actual API provider
Claude Desktop 3P gateway → localhost:12345/claude-desktop (daemon) → actual API provider
```

The daemon handles:

- Routing to the right provider/key via session token, so real API keys never reach client config or terminal environment
- Automatically logs token usage and cost for every request
- Hot-switching keys
- Tracks the lifecycle of every managed instance via wrapper heartbeat and stop reporting
- Adds the correct upstream auth header by provider type and forwards the client's native request shape
- Preserves the original `User-Agent` for regular HTTP requests; WebSocket upgrade handshakes are rebuilt with the required headers
- Adds the request model to Grok Build Chat Completions responses and SSE chunks only when an OpenAI-compatible upstream omits the required `model` field

> The old request/response format conversion layer has been removed in 3.2.0. Upstream providers need to support the API shape emitted by the target client: Claude Code / Claude Desktop use Anthropic Messages style, while Grok Build / Codex Desktop use OpenAI-style APIs.

## Building from Source & Testing

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Production build
pnpm build

# Development build (for testing)
pnpm build:dev

# Frontend tests (compat entrypoint)
pnpm test

# Rust tests
cargo test --workspace

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format code
pnpm format
```

## Tech Stack

- **Framework**: Tauri 2.x + Vite
- **Backend**: Rust (axum, rusqlite, tokio)
- **Frontend**: React 18 + TypeScript
- **UI**: Ant Design 6 + Tailwind CSS 4
- **State**: Zustand
- **Database**: SQLite (rusqlite)
- **Daemon**: standalone `cc-use-daemon` process (Axum + Hyper)
- **i18n**: i18next + sys-locale

## Supported Platforms

- macOS (Apple Silicon / Intel)

> ⚠️ **Note**: Starting from 3.0, Windows builds are no longer published and Windows-specific code is no longer maintained. Windows users should stay on 2.3.x, which will not receive further updates.

## License

MIT
