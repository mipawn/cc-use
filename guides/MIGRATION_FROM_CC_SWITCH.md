# 从 cc-switch 迁移到 CC Use

[English Version](./MIGRATION_FROM_CC_SWITCH_EN.md)

## 概述

CC Use 2.x 是全新的桌面应用，与旧版 cc-switch (0.x) CLI 工具完全不同。

- **0.x (cc-switch)**: 命令行工具
- **1.x**: Electron 桌面应用
- **2.x**: Tauri 桌面应用（当前版本）

## 卸载 cc-switch

### 使用卸载命令（推荐）

```bash
cc-switch uninstall
```

### 手动卸载

如果 `cc-switch uninstall` 无法正常工作，手动清理：

```bash
sudo rm /usr/local/bin/cc-switch
rm -rf ~/.config/cc-switch
rm -f ~/.zsh/completions/_cc-switch
rm -f ~/.local/share/bash-completion/completions/cc-switch
rm -f ~/.config/fish/completions/cc-switch.fish
```

同时清理旧版 cc-use CLI（如果安装过）：

```bash
sudo rm /usr/local/bin/cc-use
rm -rf ~/.config/cc-use
rm -f ~/.zsh/completions/_cc-use
rm -f ~/.local/share/bash-completion/completions/cc-use
rm -f ~/.config/fish/completions/cc-use.fish
```

## 安装 CC Use 2.x

从 [Releases](https://github.com/mipawn/cc-use/releases) 下载对应平台的安装包：

| 平台    | 格式                   |
| ------- | ---------------------- |
| macOS   | `.dmg`         |
| Windows | `.exe` (NSIS)  |

## 功能对比

| 功能 | cc-switch (0.x) | CC Use (2.x) |
|------|----------------|--------------|
| 类型 | CLI 工具 | 桌面应用 |
| 配置管理 | 命令行 | 可视化界面 |
| 供应商管理 | ❌ | ✅ |
| 密钥管理 | 基础 | 完整 |
| 项目管理 | ❌ | ✅ |
| 本地代理 | ❌ | ✅ |
| 费用追踪 | ❌ | ✅ |
| 统计分析 | ❌ | ✅ |
| 自动更新 | ❌ | ✅ |

## 获取帮助

- 📖 查看 [README](../README.md)
- 🐛 提交 [GitHub Issue](https://github.com/mipawn/cc-use/issues)
