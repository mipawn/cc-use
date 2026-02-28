# Migrating from cc-switch to CC Use

[中文版本](./MIGRATION_FROM_CC_SWITCH.md)

## Overview

CC Use 2.x is a completely new desktop application, fundamentally different from the old cc-switch (0.x) CLI tool.

- **0.x (cc-switch)**: Command-line tool
- **1.x**: Electron desktop app
- **2.x**: Tauri desktop app (current version)

## Uninstall cc-switch

### Using Uninstall Command (Recommended)

```bash
cc-switch uninstall
```

### Manual Uninstall

If `cc-switch uninstall` doesn't work, clean up manually:

```bash
sudo rm /usr/local/bin/cc-switch
rm -rf ~/.config/cc-switch
rm -f ~/.zsh/completions/_cc-switch
rm -f ~/.local/share/bash-completion/completions/cc-switch
rm -f ~/.config/fish/completions/cc-switch.fish
```

Also clean up old cc-use CLI if previously installed:

```bash
sudo rm /usr/local/bin/cc-use
rm -rf ~/.config/cc-use
rm -f ~/.zsh/completions/_cc-use
rm -f ~/.local/share/bash-completion/completions/cc-use
rm -f ~/.config/fish/completions/cc-use.fish
```

## Install CC Use 2.x

Download the installer for your platform from [Releases](https://github.com/mipawn/cc-use/releases):

| Platform | Format                 |
| -------- | ---------------------- |
| macOS    | `.dmg`         |
| Windows  | `.exe` (NSIS)  |

## Feature Comparison

| Feature | cc-switch (0.x) | CC Use (2.x) |
|---------|----------------|--------------|
| Type | CLI tool | Desktop app |
| Configuration | Command-line | Visual interface |
| Provider Management | ❌ | ✅ |
| Key Management | Basic | Complete |
| Project Management | ❌ | ✅ |
| Local Proxy | ❌ | ✅ |
| Cost Tracking | ❌ | ✅ |
| Statistics | ❌ | ✅ |
| Auto Update | ❌ | ✅ |

## Get Help

- 📖 Check [README](../README.md)
- 🐛 Submit [GitHub Issue](https://github.com/mipawn/cc-use/issues)
