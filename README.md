# cc-use

> [!CAUTION]
> ## ⛔ THIS PROJECT HAS BEEN DEPRECATED ⛔
> This project is no longer maintained and will not receive any updates or bug fixes.
> Please do not use this project for new installations.

---

A CLI tool for managing multiple Claude Code / Codex CLI configurations. Quickly switch between different API endpoints and keys.

[中文文档](./README_CN.md)

> **Breaking Change in v1.0.0**: The project has been renamed from `cc-switch` to `cc-use`. This version is NOT compatible with the old cc-switch. See [Upgrading from v0.x](#upgrading-from-v0x-cc-switch) for migration instructions.

## Features

- **Multi-CLI Support** - Manage both Claude Code and Codex CLI providers
- **WebUI Management** - Visual interface for managing providers and configurations
- **Common Environment Variables** - Shared across all providers (global or per CLI type)
- **Usage Tracking** - Optional usage quota display for providers
- Interactive provider selection
- Self-update support
- Cross-platform (macOS, Linux, Windows)

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/mipawn/cc-use/main/scripts/install.sh | bash
```

### Manual Install

Download the binary for your platform from [Releases](https://github.com/mipawn/cc-use/releases) and place it in your PATH.

## Shell Completion (Tab)

Completions are installed automatically during installation. If not working, add manually:

**Zsh:** Add to `~/.zshrc`:
```bash
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```
Then generate completion file:
```bash
mkdir -p ~/.zsh/completions
cc-use completion zsh > ~/.zsh/completions/_cc-use
```

**Bash:**
```bash
mkdir -p ~/.local/share/bash-completion/completions
cc-use completion bash > ~/.local/share/bash-completion/completions/cc-use
```

**Fish:**
```bash
mkdir -p ~/.config/fish/completions
cc-use completion fish > ~/.config/fish/completions/cc-use.fish
```

## Uninstall

```bash
cc-use uninstall
```

## Usage

### Interactive Mode

Simply run `cc-use` to interactively select a provider:

```bash
cc-use
```

### Commands

| Command | Description |
|---------|-------------|
| `cc-use` | Interactive provider selection and launch CLI |
| `cc-use list` | List all providers |
| `cc-use list --type claude` | List only Claude Code providers |
| `cc-use list --type codex` | List only Codex CLI providers |
| `cc-use config` | Open WebUI to manage providers |
| `cc-use update` | Check and install updates |
| `cc-use uninstall` | Uninstall cc-use |
| `cc-use completion <shell>` | Generate shell completion script |
| `cc-use --help` | Show help message |
| `cc-use --version` | Show version |

### Supported CLI Types

| Icon | Type | Description |
|------|------|-------------|
| 🟠 | `claude` | Claude Code |
| 🟢 | `codex` | Codex CLI |

### Examples

```bash
# Interactive selection
cc-use

# List all providers
cc-use list

# List only Claude Code providers
cc-use list --type claude

# Open WebUI to manage providers
cc-use config

# Check for updates and install
cc-use update
```

## Configuration

### WebUI Management

Run `cc-use config` to open the WebUI at `http://localhost:9527`. The WebUI allows you to:

- Add, edit, and delete providers
- Configure common environment variables (global or per CLI type)
- Set up usage tracking for providers
- Reorder providers via drag-and-drop

### Config File

Providers are stored in `~/.config/cc-use/config.json`.

### Config Format (v3)

```json
{
  "version": "3",
  "common": {
    "_global": {
      "API_TIMEOUT_MS": "300000"
    },
    "claude": {
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    },
    "codex": {}
  },
  "providers": [
    {
      "id": "1234567890-abc123",
      "name": "my-api",
      "type": "claude",
      "description": "My API Proxy",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com",
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx"
      },
      "order": 0
    }
  ]
}
```

### Common Environment Variables

Common environment variables are shared across providers. They can be configured at three levels:

- **Global (`_global`)** - Applied to all providers regardless of CLI type
- **Claude (`claude`)** - Applied only to Claude Code providers
- **Codex (`codex`)** - Applied only to Codex CLI providers

Provider-specific variables take precedence over common variables.

### Frequently Used Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL |
| `ANTHROPIC_AUTH_TOKEN` | API authentication token |
| `ANTHROPIC_API_KEY` | API key (alternative to token) |
| `API_TIMEOUT_MS` | API request timeout in milliseconds |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Disable telemetry |

## How It Works

cc-use launches the CLI (Claude Code or Codex) as a subprocess with provider-specific environment variables. Environment variables are merged at runtime: `common._global` + `common.<type>` + `provider.env` (provider takes precedence).

```typescript
// Merge order: common._global -> common.<type> -> provider.env -> process.env
const mergedEnv = { ...common._global, ...common[type], ...provider.env };
spawn(cliCommand, args, {
  env: { ...process.env, ...mergedEnv },
  stdio: "inherit"
});
```

**Equivalent shell command:**

```bash
# Linux/macOS
ANTHROPIC_BASE_URL=https://api.example.com ANTHROPIC_AUTH_TOKEN=sk-xxx claude

# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL="https://api.example.com"; $env:ANTHROPIC_AUTH_TOKEN="sk-xxx"; claude
```

## Building from Source

Requires [Bun](https://bun.sh) runtime.

```bash
# Install dependencies
bun install
cd webui && bun install && cd ..

# Run CLI in development
bun run dev

# Run WebUI in development (separate terminal)
bun run dev:webui

# Build binary (includes WebUI)
bun run build

# Build for all platforms
bun run build:all
```

### Build Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Run CLI in development mode |
| `bun run dev:webui` | Run WebUI dev server (Vite) |
| `bun run build:webui` | Build WebUI |
| `bun run embed:webui` | Embed WebUI into CLI |
| `bun run build` | Build CLI binary (includes WebUI) |
| `bun run build:cli` | Build CLI binary only |
| `bun run build:all` | Build for all platforms |

## Supported Platforms

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)

## Upgrading from v0.x (cc-switch)

**v1.0.0 is NOT compatible with the old cc-switch.** The project has been renamed from `cc-switch` to `cc-use`, and the config format has changed.

### Uninstall old version

```bash
# Uninstall cc-switch (old name)
cc-switch uninstall

# Then install cc-use v1.0.0
curl -fsSL https://raw.githubusercontent.com/mipawn/cc-use/main/scripts/install.sh | bash
```

### Manual removal (if cc-switch uninstall doesn't work)

```bash
# Remove the binary
sudo rm /usr/local/bin/cc-switch

# Remove old config (optional, different path)
rm -rf ~/.config/cc-switch

# Remove shell completions
rm -f ~/.zsh/completions/_cc-switch
rm -f ~/.local/share/bash-completion/completions/cc-switch
rm -f ~/.config/fish/completions/cc-switch.fish

# Remove lines added to shell config (if any)
# Edit ~/.zshrc and remove lines related to cc-switch completions
# Edit ~/.bashrc and remove lines related to cc-switch completions
```

## License

MIT
