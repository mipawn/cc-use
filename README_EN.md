# CC Use

A desktop configuration manager built exclusively for **Claude Code / Codex CLI**. Unlike general-purpose API management tools, CC Use does one thing: make it easier to manage and use your CLI.

[中文文档](./README.md)

> **🎉 3.0 Major Update**: The local proxy is now an independent `cc-use-daemon` process, with instance identity explicitly modeled at launch time. See [CHANGELOG](./CHANGELOG.md).
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

|                Settings                 |                Instances                |
| :-------------------------------------: | :-------------------------------------: |
| ![Settings](./screenshots/settings.png) | ![Instances](./screenshots/instance.png) |

## Features

- **Provider & Key Management** - Manage providers and API keys on the unified Keys page; each key can support both Claude Code and Codex CLI, with balance/usage queries (NewAPI / custom endpoints) and quick key duplication
- **Project Management** - Create projects bound to a provider, key, and CLI type; quickly switch bindings directly on the project card
- **One-Click Launch** - Click a project to launch a terminal with environment variables auto-injected, dropping you straight into CLI
- **Local Daemon Service** - A standalone `cc-use-daemon` process acts as the local gateway, transparently relaying requests and enabling cost tracking and hot-switching
- **Instance Management** - The Instances page shows every managed instance launched from the app, with a state machine covering `launching / running / stale / stopped / failed` and per-instance key hot-switching
- **Cost Tracking** - Automatically logs token usage and cost for every API request
- **Statistics** - Dashboard shows today's cost, request count, daily trends, and top keys/projects; Statistics page provides detailed breakdowns by key/provider/project/model with request history
- **System Tray** - Minimize to tray on close while the daemon keeps running; tray menu supports service control and quick-launching recent projects
- **Auto Update** - In-app update detection and download with progress display (signature verification via `tauri-plugin-updater`)
- **CLI Config Management** - Global and per-key CLI configuration (JSON), automatically merged and injected at launch
- **Internationalization** - Chinese and English UI
- **Dark Mode** - Light/dark theme switching

## Installation

Download the macOS installer from [Releases](https://github.com/mipawn/cc-use/releases):

| Platform | Format |
| -------- | ------ |
| macOS    | `.dmg` |

## Usage

### 1. Add Providers and Keys

Go to the Keys page:

1. Click "Add Provider" - fill in name, Base URL, choose an icon, optionally configure token and balance query
2. Click "Add Key" under a provider - enter the key value, select supported types (Claude Code / Codex CLI), optionally configure usage query and CLI config

### 2. Create a Project

Go to the Projects page and click "Add Project":

1. Enter a project name and select the project folder via the browse button
2. Select a provider and key to bind (cascading selector)
3. Choose the CLI type (Claude Code / Codex CLI)

After creation, you can quickly switch the bound key or CLI type directly on the project card.

### 3. Launch Terminal

On the Projects page or from the Dashboard's recent projects, click the open button to launch a terminal. The app injects environment variables via the local daemon and creates a managed instance for this launch:

- **Claude Code**: Sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
- **Codex CLI**: Sets `OPENAI_BASE_URL` + `OPENAI_API_KEY`

### 4. Daemon Service

The local daemon service is launched with the app and stays resident — terminals always go through it:

- Requests use session tokens instead of real API keys
- Token usage and cost are automatically logged for every request
- Hot-switch keys without restarting the terminal (Projects page edits the *next launch* default; Instances page edits the *currently running* instance)

Check service status and port on the Settings page; click "Restart Service" if anything goes wrong.

### 5. Identify the Current Instance · Claude Code Status Line

When launching a terminal, cc-use injects a handful of environment variables so you can tell which managed instance the current window belongs to:

| Variable                  | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `CC_USE_INSTANCE_ID`      | Instance UUID — matches a row on the Instances page                    |
| `CC_USE_INSTANCE_LABEL`   | Short code (last 8 chars of the session token), ideal for the statusbar |
| `CC_USE_PROXY_PORT`       | Local daemon port                                                      |
| `CC_USE_MANAGEMENT_TOKEN` | Management token — **do not display**; used only by wrapper ↔ daemon   |

When running multiple windows, surface `CC_USE_INSTANCE_LABEL` via the Claude Code [statusLine](https://docs.claude.com/en/docs/claude-code/statusline) so you can tell at a glance which instance a window is bound to.

**The author personally uses [claude-hud](https://github.com/jarrodwatts/claude-hud)** — its `--extra-cmd` option appends `CC_USE_INSTANCE_LABEL` to the rendered status line as `{"label":"..."}` JSON. Reference `~/.claude/settings.json`:

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "bash -lc 'hud_dir=$(ls -td ~/.claude/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null | head -1); [ -n \"$hud_dir\" ] || exit 0; bun \"${hud_dir}src/index.ts\" --extra-cmd \"bash -lc '\\''[ -n \\\"\\$CC_USE_INSTANCE_LABEL\\\" ] && printf \\\"{\\\\\\\"label\\\\\\\":\\\\\\\"%s\\\\\\\"}\\\" \\\"\\$CC_USE_INSTANCE_LABEL\\\"'\\''\"'"
  }
}
```

Install steps: inside Claude Code, run `/plugin marketplace add jarrodwatts/claude-hud` → `/plugin install claude-hud` → `/claude-hud:setup`, then extend the generated `statusLine.command` with `--extra-cmd` as shown above.

Don't want claude-hud? Any command that reads `$CC_USE_INSTANCE_LABEL` and prints a single line works as a `statusLine`.

## How It Works

On startup, the app spawns a standalone `cc-use-daemon` process as the local gateway. When launching a terminal from a project, the app generates a session token and injects it via a temporary wrapper script:

```
CLI → localhost:12345 (daemon) → actual API provider
```

The daemon handles four things:

- Routes to the right provider/key via session token, so real API keys never reach the terminal environment
- Automatically logs token usage and cost for every request
- Supports hot-switching keys without restarting the terminal
- Tracks the lifecycle of every managed instance via wrapper heartbeat and stop reporting

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
