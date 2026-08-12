//! Claude Code statusLine configuration — shared by the CLI
//! (`cc-use setup-statusline`) and the desktop app (Claude Code page).
//!
//! Writes the absolute binary path into `~/.claude/settings.json` so the
//! status bar works without PATH setup. Follows the same rules as other
//! config takeovers: explicit user action only, backup before first write,
//! never clobber a third-party value silently.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum StatuslineState {
    /// No statusLine configured at all.
    NotConfigured,
    /// statusLine points at a cc-use binary (path may be stale after update).
    Enabled { command: String, current: bool },
    /// statusLine is set to something that is not cc-use.
    ThirdParty { command: String },
}

pub enum EnableOutcome {
    Enabled { backup_path: Option<PathBuf> },
    AlreadyEnabled,
    ThirdPartyPresent { command: String },
}

fn settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法定位用户目录")?;
    Ok(home.join(".claude").join("settings.json"))
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.pre-cc-use-statusline.bak")
}

fn read_settings(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!("{} 不是 JSON 对象", path.display())),
        Err(e) => Err(format!(
            "{} 解析失败（不改动格式错误的配置）: {}",
            path.display(),
            e
        )),
    }
}

fn statusline_command(map: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    map.get("statusLine")
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn expected_command(exe: &Path) -> String {
    format!("{} statusline", shell_quote(&exe.to_string_lossy()))
}

fn is_cc_use_command(command: &str) -> bool {
    // Match only commands cc-use itself writes. A third-party wrapper may
    // mention cc-use-cli as one of its arguments and must still be treated as
    // third-party configuration.
    let command = command.trim();
    if matches!(command, "cc-use statusline" | "cc-use-cli statusline") {
        return true;
    }
    let Some(exe) = command.strip_suffix(" statusline") else {
        return false;
    };
    let unquoted = if exe.starts_with('\'') && exe.ends_with('\'') && exe.len() >= 2 {
        exe[1..exe.len() - 1].replace("'\\''", "'")
    } else if exe.starts_with('"') && exe.ends_with('"') && exe.len() >= 2 {
        exe[1..exe.len() - 1].to_string()
    } else if !exe.chars().any(char::is_whitespace) {
        exe.to_string()
    } else {
        return false;
    };
    unquoted.ends_with("/cc-use-cli")
}

/// Inspect the current statusLine setup, comparing against `exe` to detect a
/// stale path from a previous app version.
pub fn inspect(exe: &Path) -> Result<StatuslineState, String> {
    let path = settings_path()?;
    let map = read_settings(&path)?;
    match statusline_command(&map) {
        None => Ok(StatuslineState::NotConfigured),
        Some(command) if is_cc_use_command(&command) => {
            let expected = expected_command(exe);
            Ok(StatuslineState::Enabled {
                current: command == expected,
                command,
            })
        }
        Some(command) => Ok(StatuslineState::ThirdParty { command }),
    }
}

/// Atomic write via temp file + rename, matching the other config takeovers.
fn write_settings(
    path: &Path,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建 {}: {}", parent.display(), e))?;
    }
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| format!("序列化 settings.json 失败: {}", e))?;
    let temp = path.with_extension("json.cc-use.tmp");
    std::fs::write(&temp, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("替换 settings.json 失败: {}", e))?;
    Ok(())
}

pub fn enable(exe: &Path, force: bool) -> Result<EnableOutcome, String> {
    let path = settings_path()?;
    enable_at(&path, exe, force)
}

fn enable_at(path: &Path, exe: &Path, force: bool) -> Result<EnableOutcome, String> {
    let mut map = read_settings(&path)?;
    let expected = expected_command(exe);

    let existing = statusline_command(&map);
    match existing.as_deref() {
        Some(command) if command == expected => return Ok(EnableOutcome::AlreadyEnabled),
        Some(command) if !is_cc_use_command(&command) && !force => {
            return Ok(EnableOutcome::ThirdPartyPresent {
                command: command.to_string(),
            });
        }
        _ => {}
    }

    // Snapshot the state users chose to replace. Updating an older cc-use path
    // must not overwrite that snapshot with another cc-use command.
    let should_snapshot = existing
        .as_deref()
        .is_none_or(|command| !is_cc_use_command(command));
    let backup_path = if should_snapshot {
        let backup = backup_path(path);
        if path.exists() {
            std::fs::copy(&path, &backup).map_err(|e| format!("备份 settings.json 失败: {}", e))?;
            Some(backup)
        } else {
            if backup.exists() {
                std::fs::remove_file(&backup)
                    .map_err(|e| format!("清理旧状态栏备份失败: {}", e))?;
            }
            None
        }
    } else {
        None
    };

    map.insert(
        "statusLine".to_string(),
        serde_json::json!({
            "type": "command",
            "command": expected,
            "padding": 0,
        }),
    );
    write_settings(&path, &map)?;
    let written = read_settings(path)?;
    if statusline_command(&written).as_deref() != Some(expected.as_str()) {
        return Err(format!("写入 {} 后校验失败", path.display()));
    }
    Ok(EnableOutcome::Enabled { backup_path })
}

/// Remove the statusLine entry only when it points at cc-use.
/// Returns whether anything was removed.
pub fn restore() -> Result<bool, String> {
    let path = settings_path()?;
    restore_at(&path)
}

fn restore_at(path: &Path) -> Result<bool, String> {
    let mut map = read_settings(&path)?;
    match statusline_command(&map) {
        Some(command) if is_cc_use_command(&command) => {
            let backup = backup_path(path);
            let previous = if backup.exists() {
                let mut backup_map = read_settings(&backup)?;
                backup_map.remove("statusLine")
            } else {
                None
            };
            match previous {
                Some(value)
                    if value
                        .get("command")
                        .and_then(|command| command.as_str())
                        .is_none_or(|command| !is_cc_use_command(command)) =>
                {
                    map.insert("statusLine".to_string(), value);
                }
                _ => {
                    map.remove("statusLine");
                }
            }
            write_settings(&path, &map)?;
            if backup.exists() {
                std::fs::remove_file(&backup).map_err(|e| format!("清理状态栏备份失败: {}", e))?;
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn recognizes_cc_use_commands() {
        assert!(is_cc_use_command(
            "/Applications/cc-use.app/Contents/MacOS/cc-use-cli statusline"
        ));
        assert!(is_cc_use_command("cc-use statusline"));
        assert!(is_cc_use_command(
            "'/Applications/CC Use.app/Contents/MacOS/cc-use-cli' statusline"
        ));
        assert!(is_cc_use_command(
            "\"/Applications/CC Use.app/Contents/MacOS/cc-use-cli\" statusline"
        ));
        assert!(!is_cc_use_command(
            "claude-hud --extra-cmd /Applications/cc-use.app/Contents/MacOS/cc-use-cli statusline"
        ));
        assert!(!is_cc_use_command("bun /Users/x/.claude/hud.js"));
        assert!(!is_cc_use_command("~/.claude/statusline.sh"));
    }

    #[test]
    fn quotes_the_bundled_app_path_for_the_shell() {
        let exe = Path::new("/Applications/CC Use.app/Contents/MacOS/cc-use-cli");
        assert_eq!(
            expected_command(exe),
            "'/Applications/CC Use.app/Contents/MacOS/cc-use-cli' statusline"
        );
    }

    #[test]
    fn force_then_restore_recovers_third_party_statusline() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &settings,
            r#"{"theme":"dark","statusLine":{"type":"command","command":"claude-hud"}}"#,
        )
        .unwrap();
        let exe = Path::new("/Applications/cc-use.app/Contents/MacOS/cc-use-cli");

        let blocked = enable_at(&settings, exe, false).unwrap();
        assert!(matches!(blocked, EnableOutcome::ThirdPartyPresent { .. }));
        enable_at(&settings, exe, true).unwrap();
        assert!(restore_at(&settings).unwrap());

        let restored = read_settings(&settings).unwrap();
        assert_eq!(statusline_command(&restored).as_deref(), Some("claude-hud"));
        assert_eq!(restored.get("theme").and_then(|v| v.as_str()), Some("dark"));
        assert!(!backup_path(&settings).exists());
    }

    #[test]
    fn restore_removes_cc_use_when_there_was_no_previous_statusline() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, r#"{"theme":"dark"}"#).unwrap();
        let exe = Path::new("/Applications/cc-use.app/Contents/MacOS/cc-use-cli");

        enable_at(&settings, exe, false).unwrap();
        assert!(restore_at(&settings).unwrap());

        let restored = read_settings(&settings).unwrap();
        assert!(statusline_command(&restored).is_none());
        assert_eq!(restored.get("theme").and_then(|v| v.as_str()), Some("dark"));
    }
}
