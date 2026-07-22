# Grok Build Integration Guide

CC Use manages Grok Build as an independent process-level client. It may reuse the same project directory as Claude Code, while provider, key, pre-launch command, sessions, and running instances remain isolated for Grok Build.

## Prerequisites

- The `grok` CLI is installed on macOS and available through `grok --version`
- The provider supports OpenAI Chat Completions at `/v1/chat/completions`
- The API key targets Grok Build and optionally defines a `grok` model mapping

## Generated Configuration

Whenever CC Use prepares or launches Grok Build, it maintains `[model.cc-use]` in the user-level `~/.grok/config.toml` while preserving unrelated user settings. It does not use the enterprise-managed `managed_config.toml`.

The generated configuration is equivalent to:

```toml
[model.cc-use]
model = "<the key's grok model, defaulting to grok-4.5>"
base_url = "http://127.0.0.1:<daemon-port>/v1"
name = "CC Use"
description = "Local cc-use gateway"
env_key = "CC_USE_GROK_TOKEN"
api_backend = "chat_completions"
supports_backend_search = false
```

The terminal runs `grok -m cc-use`. `CC_USE_GROK_TOKEN` is the managed instance's session token, not the real upstream API key.

## Launch and Instances

1. Open the Grok Build launchpad from the sidebar.
2. Create or edit a project and select a Grok-compatible key.
3. Click Open. The wrapper starts Grok as the foreground TUI while retaining heartbeat and exit reporting.
4. The running instance appears only in the Grok Build launchpad's Instances tab.

On first use in a directory, Grok Build may ask whether you trust its contents. This is Grok's normal safety prompt.

## OpenAI Compatibility

Grok Build strictly deserializes Chat Completions responses. Some compatible gateways return `id / object / choices / usage` but omit the standard `model` field. CC Use applies a minimal compatibility fix only to Grok Build routes:

- Missing `model` on a non-streaming `chat.completion` is filled with the actual forwarded request model
- Missing `model` on SSE `chat.completion.chunk` events is filled even when JSON spans multiple network chunks
- Existing upstream `model` values are preserved
- Claude Code, Codex Desktop, and Claude Desktop do not enter this compatibility branch

## Troubleshooting

### The terminal stays blank after opening

Use a version that includes foreground TUI wrapper support. The older wrapper started `grok` in the background, preventing the interactive process from reading the terminal correctly. You can also run `grok -m cc-use` directly from the project directory to check whether Grok itself renders.

### `serialization error: missing field model`

The OpenAI-compatible upstream omitted `model`. The current daemon normalizes both regular JSON and SSE responses. Restart CC Use after upgrading so the new daemon is active.

### Configuration is not applied

- Confirm that `~/.grok/config.toml` contains `[model.cc-use]`
- Run `grok inspect --json` to inspect the configuration selected for the current directory
- Confirm that the local daemon is running and its port matches the generated base URL
- Restart the development app after Rust backend or daemon changes

See [xAI Grok Build Custom Models](https://docs.x.ai/build/overview#custom-models) for the upstream configuration format.
