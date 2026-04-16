# CC Use

A desktop configuration manager built exclusively for **Claude Code / Codex CLI**. Unlike general-purpose API management tools, CC Use does one thing: make it easier to manage and use your CLI.

[中文文档](./README.md)

> **🎉 2.0 Major Update**: Completely rewritten from Electron to Tauri + Rust! Core advantage: **More reliable auto-update mechanism**
>
> **Migrating from 1.x?** Data migrates automatically → [Migration Guide](./guides/MIGRATION_EN.md)
>
> **Migrating from 0.x (cc-switch)?** See [Migrating from cc-switch](./guides/MIGRATION_FROM_CC_SWITCH_EN.md)

## Screenshots

|                 Dashboard                 |               Key Management               |
| :---------------------------------------: | :----------------------------------------: |
| ![Dashboard](./screenshots/dashboard.png) | ![Key Management](./screenshots/token.png) |

|                Project Management                |               Statistics                |
| :----------------------------------------------: | :-------------------------------------: |
| ![Project Management](./screenshots/project.png) | ![Statistics](./screenshots/statis.png) |

|                Settings                 |
| :-------------------------------------: |
| ![Settings](./screenshots/settings.png) |

## Features

- **Provider & Key Management** - Manage providers and API keys on the unified Keys page; each key can support both Claude Code and Codex CLI, with balance/usage queries (NewAPI / custom endpoints) and quick key duplication
- **Project Management** - Create projects bound to a provider, key, and CLI type; quickly switch bindings directly on the project card
- **One-Click Launch** - Click a project to launch a terminal with environment variables auto-injected, dropping you straight into CLI
- **Local Proxy** - Built-in proxy server that relays requests via session tokens, enabling cost tracking and hot-switching
- **Cost Tracking** - In proxy mode, automatically logs token usage and cost for every API request
- **Statistics** - Dashboard shows today's cost, request count, daily trends, and top keys/projects; Statistics page provides detailed breakdowns by key/provider/project/model with request history
- **System Tray** - Minimize to tray on close, keeping the proxy running; tray menu supports proxy control and quick-launching recent projects
- **Auto Update** - In-app update detection and download with progress display (signature verification via `tauri-plugin-updater`)
- **CLI Config Management** - Global and per-key CLI configuration (JSON), automatically merged and injected at launch
- **Internationalization** - Chinese and English UI
- **Dark Mode** - Light/dark theme switching
- **Code Quality** - Integrated ESLint + Prettier for consistent code style

## Installation

Download the installer for your platform from [Releases](https://github.com/mipawn/cc-use/releases):

| Platform | Format                 |
| -------- | ---------------------- |
| macOS    | `.dmg`                 |
| Windows  | `.exe` (NSIS) / `.msi` |

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

On the Projects page or from the Dashboard's recent projects, click the open button to launch a terminal. The app will auto-start the proxy and inject environment variables:

- **Claude Code**: Sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
- **Codex CLI**: Sets `OPENAI_BASE_URL` + `OPENAI_API_KEY`

### 4. Proxy Control

Toggle the local proxy on the Projects page or Settings page. With proxy enabled:

- Requests are relayed through the local proxy using session tokens instead of real API keys
- Token usage and cost are automatically logged for every request
- Hot-switching keys without restarting the terminal

Disabling the proxy will stop usage tracking.

## How It Works

CC Use supports two modes:

**Direct mode** - The terminal connects to the API provider directly with the real API key.

**Proxy mode** - With the local proxy enabled, requests are relayed through it:

```
CLI → localhost:12345 (proxy) → actual API provider
```

The proxy uses session tokens instead of real API keys, enabling:

- Real API keys are never exposed to the terminal environment
- Automatic logging of token usage and cost for every request
- Hot-switching keys without restarting the terminal

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

For the fuller test index and explicit entrypoints such as `pnpm test:web`, `pnpm test:rust`, and `pnpm test:all`, see [docs/testing/README.md](./docs/testing/README.md).

## Tech Stack

- **Framework**: Tauri 2.x + Vite
- **Backend**: Rust (axum, rusqlite, tokio)
- **Frontend**: React 18 + TypeScript
- **UI**: Ant Design 6 + Tailwind CSS 4
- **State**: Zustand
- **Database**: SQLite (rusqlite)
- **Proxy**: Axum + Hyper
- **i18n**: i18next + sys-locale

## Supported Platforms

- macOS (Apple Silicon / Intel)
- Windows (x64)

> ⚠️ **Note**: The Windows build has not been thoroughly tested yet and may have compatibility issues. If you encounter any problems, please open an [Issue](https://github.com/mipawn/cc-use/issues).

## License

MIT
