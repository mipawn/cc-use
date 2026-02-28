# Migration Guide: From 1.x (Electron) to 2.x (Tauri)

[中文版本](./MIGRATION.md)

This guide helps you migrate from CC Use 1.x (Electron version) to 2.x (Tauri version).

## Overview

CC Use 2.x is a major architectural upgrade, completely rewritten from Electron + Node.js to Tauri + Rust.

**Core Advantage: A More Reliable In-App Update Experience**

- ✅ **In-app update checks**: Automatically checks GitHub Releases (latest.json) on startup
- ✅ **Visible download progress**: Downloads updates in-app with progress
- ✅ **Signature verification**: Uses `tauri-plugin-updater` to verify update authenticity
- ✅ **Cross-platform consistency**: Same update check + download logic on macOS and Windows

## Automatic Data Migration

**Good News: Data migrates automatically!**

On first launch of 2.x, the app will automatically detect and migrate 1.x database:

- ✅ Provider configurations
- ✅ API keys
- ✅ Project configurations
- ✅ Usage records and statistics

**Prerequisite**: Do not delete the 1.x application data directory.

### Data Locations

**macOS:**

```
~/Library/Application Support/cc-use/data/cc-use.db
```

**Windows:**

```
%APPDATA%\cc-use\data\cc-use.db
```

## Migration Steps

### Recommended: Keep Old Data, Auto-Migrate

1. **Install 2.x directly**: Download from [Releases](https://github.com/mipawn/cc-use/releases)
2. **Launch app**: First launch will automatically detect and migrate 1.x data
3. **Verify data**: Check that providers, keys, and projects migrated correctly
4. **Uninstall 1.x**: After confirming data is correct, uninstall old version

### Manual Cleanup (Optional)

After confirming successful migration, you can clean up 1.x:

**macOS:**

```bash
# Remove app (must be done manually)
rm -rf /Applications/CC\ Use.app

# Clean old data (optional, recommend keeping for a while)
# rm -rf ~/Library/Application\ Support/cc-use
```

**Windows:**

```powershell
# Windows will automatically overwrite 1.x when installing 2.x, no manual uninstall needed

# Clean old data (optional, recommend keeping for a while)
# Remove-Item -Recurse -Force "$env:APPDATA\cc-use"
```

## FAQ

### Q: Is data migration automatic?

**A:** Yes. First launch of 2.x will automatically detect and migrate 1.x data, no manual steps required.

### Q: Do I need to uninstall 1.x first?

**A:** No. Recommended to install 2.x first, confirm migration success, then uninstall 1.x.

### Q: Can I delete old data after migration?

**A:** Yes, but recommend keeping it for a while (e.g., 1-2 weeks) to ensure no issues.

### Q: Why migrate to 2.x?

**A:** Main reason is a **more reliable in-app update experience** (checks GitHub Releases, visible download progress, signature verification), and the Rust backend generally improves stability.

### Q: Will 1.x continue to be maintained?

**A:** No. After 2.x release, 1.x will no longer receive updates or bug fixes.

## Technical Changes

| Component | 1.x              | 2.x                                                                            |
| --------- | ---------------- | ------------------------------------------------------------------------------ |
| Framework | Electron         | Tauri 2.x                                                                      |
| Backend   | Node.js          | Rust                                                                           |
| Database  | better-sqlite3   | rusqlite                                                                       |
| Proxy     | Express          | Axum                                                                           |
| Update    | electron-updater | `tauri-plugin-updater` (latest.json + signature verification, non-incremental) |

## Get Help

If you encounter migration issues:

- 📖 Check [README](../README.md)
- 🐛 Submit [GitHub Issue](https://github.com/mipawn/cc-use/issues)
- 💬 Join [Discussions](https://github.com/mipawn/cc-use/discussions)
