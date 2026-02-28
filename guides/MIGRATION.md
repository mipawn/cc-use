# 迁移指南：从 1.x (Electron) 到 2.x (Tauri)

[English Version](./MIGRATION_EN.md)

本指南帮助你从 CC Use 1.x (Electron 版本) 迁移到 2.x (Tauri 版本)。

## 概述

CC Use 2.x 是一次重大架构升级，从 Electron + Node.js 完全重写为 Tauri + Rust。

**核心优势：更可靠的自动更新体验**

- ✅ **应用内检查更新**：启动后自动检查 GitHub Releases（latest.json）
- ✅ **可视化下载进度**：应用内下载并显示进度
- ✅ **签名校验**：基于 `tauri-plugin-updater` 验证更新来源
- ✅ **跨平台一致性**：macOS 和 Windows 采用一致的更新检查与下载逻辑

## 自动数据迁移

**好消息：数据会自动迁移！**

首次启动 2.x 时，应用会自动检测 1.x 的数据库文件并迁移：

- ✅ 供应商配置
- ✅ API 密钥
- ✅ 项目配置
- ✅ 使用记录和统计数据

**前提条件**：不要删除 1.x 的应用数据目录。

### 数据位置

**macOS:**

```
~/Library/Application Support/cc-use/data/cc-use.db
```

**Windows:**

```
%APPDATA%\cc-use\data\cc-use.db
```

## 迁移步骤

### 推荐方式：保留旧数据，自动迁移

1. **直接安装 2.x**：从 [Releases](https://github.com/mipawn/cc-use/releases) 下载安装
2. **启动应用**：首次启动时会自动检测并迁移 1.x 数据
3. **验证数据**：检查供应商、密钥、项目是否正确迁移
4. **卸载 1.x**：确认数据无误后，可以卸载旧版本

### 手动清理（可选）

确认数据迁移成功后，可以清理 1.x 应用：

**macOS:**

```bash
# 删除应用（必须手动删除）
rm -rf /Applications/CC\ Use.app

# 清理旧数据（可选，建议保留一段时间）
# rm -rf ~/Library/Application\ Support/cc-use
```

**Windows:**

```powershell
# Windows 安装 2.x 时会自动覆盖 1.x，无需手动卸载

# 清理旧数据（可选，建议保留一段时间）
# Remove-Item -Recurse -Force "$env:APPDATA\cc-use"
```

## 常见问题

### Q: 数据迁移是自动的吗？

**A:** 是的。首次启动 2.x 时会自动检测并迁移 1.x 数据，无需手动操作。

### Q: 我需要先卸载 1.x 吗？

**A:** 不需要。建议先安装 2.x 并确认数据迁移成功后，再卸载 1.x。

### Q: 迁移后可以删除旧数据吗？

**A:** 可以，但建议保留一段时间（如 1-2 周），确保没有问题后再删除。

### Q: 为什么要迁移到 2.x？

**A:** 主要原因是**更可靠的应用内更新体验**（自动检查 GitHub Releases、可视化下载进度、签名校验等），同时后端迁移到 Rust 也让整体运行更稳定。

### Q: 1.x 还会继续维护吗？

**A:** 不会。2.x 发布后，1.x 不再接收更新和 bug 修复。

## 技术变更

| 组件     | 1.x              | 2.x                                                      |
| -------- | ---------------- | -------------------------------------------------------- |
| 框架     | Electron         | Tauri 2.x                                                |
| 后端     | Node.js          | Rust                                                     |
| 数据库   | better-sqlite3   | rusqlite                                                 |
| 代理     | Express          | Axum                                                     |
| 更新机制 | electron-updater | `tauri-plugin-updater`（latest.json + 签名校验，非增量） |

## 获取帮助

如果遇到迁移问题：

- 📖 查看 [README](../README.md)
- 🐛 提交 [GitHub Issue](https://github.com/mipawn/cc-use/issues)
- 💬 参与 [讨论](https://github.com/mipawn/cc-use/discussions)
