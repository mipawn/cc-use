# 旧版本废弃说明 (Deprecation Notice)

[English Version](#english-version)

## 中文版本

### 📢 重要通知

**CC Use 旧版本已正式废弃（2026-02-28）**

- **0.x 版本** (cc-switch CLI 工具) - 已于 2024 年废弃
- **1.x 版本** (Electron 桌面应用) - 已于 2026-02-28 废弃

随着 CC Use 2.x (Tauri 版本) 的发布，我们不再维护和支持旧版本。

### 废弃时间线

| 日期       | 事件                 |
| ---------- | -------------------- |
| 2026-02-28 | 2.x (Tauri) 正式发布 |
| 2026-02-28 | 0.x 和 1.x 停止维护  |

### 为什么废弃旧版本？

**核心原因：更可靠的自动更新机制**

2.x 采用 Tauri + Rust 架构，最大优势是**更可靠的应用内更新体验**：

- ✅ 应用内检查 GitHub Releases（latest.json）
- ✅ 应用内下载并展示进度
- ✅ 基于 `tauri-plugin-updater` 的签名校验
- ✅ macOS 和 Windows 使用统一的更新检查与下载逻辑

继续维护多个不同架构的版本会分散开发资源，影响新功能开发和 bug 修复效率。

### 受影响的版本

#### 0.x 版本 (cc-switch CLI)

- 命令行工具，已于 2024 年被 1.x 桌面应用取代
- 不再接收任何更新

#### 1.x 版本 (Electron 桌面应用)

- 1.5.0 (最后的 Electron 版本)
- 1.4.x, 1.3.x, 1.2.x, 1.1.x, 1.0.0
- 不再接收任何更新

### 我应该怎么做？

#### ✅ 推荐：立即迁移到 2.x

1. **安装 2.x**：从 [Releases](https://github.com/mipawn/cc-use/releases) 下载最新版本
2. **自动迁移**：首次启动时会自动检测并迁移 1.x 数据
3. **验证数据**：确认供应商、密钥、项目正确迁移
4. **卸载旧版本**：确认无误后卸载 0.x 或 1.x

详见 [迁移指南](./MIGRATION.md)

#### ⚠️ 不推荐：继续使用旧版本

如果你选择继续使用旧版本，请注意：

- ❌ 不会收到任何 bug 修复
- ❌ 不会收到安全更新
- ❌ 不会收到新功能
- ❌ 不会收到技术支持
- ❌ 可能与未来的系统版本不兼容

### 常见问题

#### Q: 旧版本还能继续使用吗？

**A:** 技术上可以，但**强烈不建议**。旧版本不再接收任何更新，包括安全补丁。

#### Q: 我的数据会丢失吗？

**A:** 不会。2.x 首次启动时会自动检测并迁移 1.x 数据。

#### Q: 迁移复杂吗？

**A:** 不复杂。数据会自动迁移，整个过程只需几分钟。详见 [迁移指南](./MIGRATION.md)。

#### Q: 为什么不继续维护旧版本？

**A:** 不同架构需要双倍的开发资源。集中精力在 2.x 上可以更快地修复 bug、添加新功能，为所有用户提供更好的体验。特别是 2.x 的自动更新机制更可靠，能确保用户始终使用最新版本。

### 获取帮助

如果你在迁移过程中需要帮助：

- 📖 阅读 [迁移指南](./MIGRATION.md)
- 🐛 提交 [GitHub Issue](https://github.com/mipawn/cc-use/issues)
- 💬 参与 [讨论](https://github.com/mipawn/cc-use/discussions)

---

## English Version

### 📢 Important Notice

**CC Use legacy versions have been officially deprecated (2026-02-28)**

- **0.x versions** (cc-switch CLI tool) - Deprecated in 2024
- **1.x versions** (Electron desktop app) - Deprecated on 2026-02-28

With the release of CC Use 2.x (Tauri version), we are no longer maintaining or supporting legacy versions.

### Deprecation Timeline

| Date       | Event                           |
| ---------- | ------------------------------- |
| 2026-02-28 | 2.x (Tauri) officially released |
| 2026-02-28 | 0.x and 1.x maintenance stopped |

### Why Deprecate Legacy Versions?

**Core Reason: More Reliable Auto-Update Mechanism**

2.x uses Tauri + Rust architecture, with the main advantage being **a more reliable in-app update experience**:

- ✅ In-app checks GitHub Releases (latest.json)
- ✅ In-app download with visible progress
- ✅ Signature verification via `tauri-plugin-updater`
- ✅ Unified update check + download logic on macOS and Windows

Maintaining multiple different architectures divides development resources and impacts the efficiency of new feature development and bug fixes.

### Affected Versions

#### 0.x versions (cc-switch CLI)

- Command-line tool, replaced by 1.x desktop app in 2024
- No longer receives any updates

#### 1.x versions (Electron desktop app)

- 1.5.0 (last Electron version)
- 1.4.x, 1.3.x, 1.2.x, 1.1.x, 1.0.0
- No longer receives any updates

### What Should I Do?

#### ✅ Recommended: Migrate to 2.x Immediately

1. **Install 2.x**: Download latest version from [Releases](https://github.com/mipawn/cc-use/releases)
2. **Auto-migrate**: First launch will automatically detect and migrate 1.x data
3. **Verify data**: Confirm providers, keys, and projects migrated correctly
4. **Uninstall old version**: After confirmation, uninstall 0.x or 1.x

See [Migration Guide](./MIGRATION_EN.md) for details.

#### ⚠️ Not Recommended: Continue Using Legacy Versions

If you choose to continue using legacy versions, be aware:

- ❌ No bug fixes
- ❌ No security updates
- ❌ No new features
- ❌ No technical support
- ❌ May become incompatible with future system versions

### FAQ

#### Q: Can I still use legacy versions?

**A:** Technically yes, but **strongly discouraged**. Legacy versions no longer receive any updates, including security patches.

#### Q: Will I lose my data?

**A:** No. 2.x will automatically detect and migrate 1.x data on first launch.

#### Q: Is migration complicated?

**A:** No. Data migrates automatically, the entire process takes only a few minutes. See [Migration Guide](./MIGRATION_EN.md).

#### Q: Why not continue maintaining legacy versions?

**A:** Different architectures require double the development resources. Focusing on 2.x allows us to fix bugs faster, add new features, and provide a better experience for all users. Especially, 2.x's auto-update mechanism is more reliable, ensuring users always have the latest version.

### Get Help

If you need help during migration:

- 📖 Read the [Migration Guide](./MIGRATION_EN.md)
- 🐛 Submit a [GitHub Issue](https://github.com/mipawn/cc-use/issues)
- 💬 Join [Discussions](https://github.com/mipawn/cc-use/discussions)

---

**Thank you for your understanding and support!**

感谢你的理解和支持！
