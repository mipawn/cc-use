//! CLI tool installation and Claude Code statusLine setup — the GUI side of
//! `docs/v3.7.0/cli-and-statusline.md`.

use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

const INSTALL_PATH: &str = "/usr/local/bin/cc-use";

/// The bundled CLI binary sits next to the app binary: `Contents/MacOS/` in a
/// bundle, `target/debug|release/` in dev. Same resolution the daemon uses.
fn bundled_cli_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位应用路径: {}", e))?;
    let dir = exe.parent().ok_or("无法定位应用目录")?;
    let candidate = dir.join("cc-use-cli");
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!("应用内未找到命令行工具（{}）", candidate.display()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolStatus {
    /// Bundled binary exists and can be installed.
    pub available: bool,
    pub bundled_path: Option<String>,
    /// /usr/local/bin/cc-use exists.
    pub installed: bool,
    /// The entry is a symlink created by cc-use (including an older app path).
    pub managed: bool,
    /// Symlink points at the current bundled binary.
    pub current: bool,
    /// Path currently linked (or the foreign file found there).
    pub target: Option<String>,
}

#[tauri::command]
pub fn cli_tool_status() -> CliToolStatus {
    let bundled = bundled_cli_path().ok();
    let link = std::path::Path::new(INSTALL_PATH);
    let installed = std::fs::symlink_metadata(link).is_ok();
    let linked_path = std::fs::read_link(link).ok();
    let managed = linked_path.as_deref().is_some_and(is_managed_cli_target);
    let target = linked_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .or_else(|| installed.then(|| INSTALL_PATH.to_string()));

    CliToolStatus {
        available: bundled.is_some(),
        installed,
        managed,
        current: match (&bundled, &linked_path) {
            (Some(bundled), Some(target)) => bundled == target,
            _ => false,
        },
        bundled_path: bundled.map(|p| p.to_string_lossy().to_string()),
        target,
    }
}

fn is_managed_cli_target(target: &Path) -> bool {
    target.file_name().and_then(|name| name.to_str()) == Some("cc-use-cli")
}

/// Create /usr/local/bin/cc-use via the macOS administrator-privileges dialog.
/// Explicit user action from the settings page; nothing runs at startup.
#[tauri::command]
pub async fn cli_tool_install() -> Result<CliToolStatus, String> {
    tauri::async_runtime::spawn_blocking(cli_tool_install_blocking)
        .await
        .map_err(|error| format!("安装任务异常结束: {}", error))?
}

fn cli_tool_install_blocking() -> Result<CliToolStatus, String> {
    let bundled = bundled_cli_path()?;
    let bundled_str = bundled.to_string_lossy().to_string();

    // Refuse to clobber a file we did not create (a real binary or someone
    // else's link outside the app bundle / target dir).
    let link = std::path::Path::new(INSTALL_PATH);
    if link.exists() && std::fs::read_link(link).is_err() {
        return Err(format!("{} 已存在且不是符号链接，未做改动。", INSTALL_PATH));
    }
    if std::fs::read_link(link).ok().as_deref() == Some(bundled.as_path()) {
        return Ok(cli_tool_status());
    }

    let shell = format!(
        "mkdir -p /usr/local/bin && ln -sf '{}' '{}'",
        bundled_str.replace('\'', "'\\''"),
        INSTALL_PATH
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("执行授权命令失败: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Err("已取消授权".to_string());
        }
        return Err(format!("安装失败: {}", stderr.trim()));
    }

    Ok(cli_tool_status())
}

/// Remove only the global command entry. The app, its data, and Claude Code's
/// independently configured statusLine remain untouched.
#[tauri::command]
pub async fn cli_tool_uninstall() -> Result<CliToolStatus, String> {
    tauri::async_runtime::spawn_blocking(cli_tool_uninstall_blocking)
        .await
        .map_err(|error| format!("卸载任务异常结束: {}", error))?
}

fn cli_tool_uninstall_blocking() -> Result<CliToolStatus, String> {
    let link = Path::new(INSTALL_PATH);
    let metadata = match std::fs::symlink_metadata(link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(cli_tool_status());
        }
        Err(error) => return Err(format!("检查 {} 失败: {}", INSTALL_PATH, error)),
    };
    if !metadata.file_type().is_symlink() {
        return Err(format!(
            "{} 不是 cc-use 创建的符号链接，未删除。",
            INSTALL_PATH
        ));
    }
    let target = std::fs::read_link(link)
        .map_err(|error| format!("读取 {} 失败: {}", INSTALL_PATH, error))?;
    if !is_managed_cli_target(&target) {
        return Err(format!("{} 不属于 cc-use，未删除。", INSTALL_PATH));
    }

    let script = format!(
        "do shell script \"rm -f '{}'\" with administrator privileges",
        INSTALL_PATH
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|error| format!("执行授权命令失败: {}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Err("已取消授权".to_string());
        }
        return Err(format!("卸载失败: {}", stderr.trim()));
    }
    Ok(cli_tool_status())
}

#[cfg(test)]
mod tests {
    use super::is_managed_cli_target;
    use std::path::Path;

    #[test]
    fn recognizes_only_cc_use_cli_link_targets() {
        assert!(is_managed_cli_target(Path::new(
            "/Applications/CC Use.app/Contents/MacOS/cc-use-cli"
        )));
        assert!(is_managed_cli_target(Path::new(
            "/workspace/target/debug/cc-use-cli"
        )));
        assert!(!is_managed_cli_target(Path::new(
            "/usr/local/bin/other-cli"
        )));
    }
}

#[tauri::command]
pub fn statusline_status() -> Result<crate::statusline_config::StatuslineState, String> {
    let bundled = bundled_cli_path()?;
    crate::statusline_config::inspect(&bundled)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineEnableResult {
    pub enabled: bool,
    /// Set when a third-party statusLine blocks us and force was not given.
    pub blocked_by: Option<String>,
    pub backup_path: Option<String>,
}

#[tauri::command]
pub fn statusline_enable(force: bool) -> Result<StatuslineEnableResult, String> {
    let bundled = bundled_cli_path()?;
    match crate::statusline_config::enable(&bundled, force)? {
        crate::statusline_config::EnableOutcome::Enabled { backup_path } => {
            Ok(StatuslineEnableResult {
                enabled: true,
                blocked_by: None,
                backup_path: backup_path.map(|p| p.to_string_lossy().to_string()),
            })
        }
        crate::statusline_config::EnableOutcome::AlreadyEnabled => Ok(StatuslineEnableResult {
            enabled: true,
            blocked_by: None,
            backup_path: None,
        }),
        crate::statusline_config::EnableOutcome::ThirdPartyPresent { command } => {
            Ok(StatuslineEnableResult {
                enabled: false,
                blocked_by: Some(command),
                backup_path: None,
            })
        }
    }
}

#[tauri::command]
pub fn statusline_restore() -> Result<bool, String> {
    crate::statusline_config::restore()
}
