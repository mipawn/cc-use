//! 终端启动器 - 逐终端原生入口
//!
//! 实现不同终端的原生启动机制,避免 AppleScript 转义地狱。
//!
//! ## 启动策略
//!
//! - Ghostty: `open -na Ghostty --args --working-directory=<dir> -e <wrapper>`
//! - WezTerm: `wezterm cli spawn --cwd <dir> -- <wrapper>` (复用) 或 `wezterm start --cwd <dir> -- <wrapper>` (冷启)
//! - Warp: `open "warp://action/new_tab?path=<urlencoded dir>"`
//! - iTerm2: osascript `create window with default profile command "<wrapper>"`
//! - Terminal: osascript `tell app "Terminal" to do script "<wrapper>"`

use std::path::Path;
use std::process::Command;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum TerminalLauncherError {
    #[error("Terminal not available: {0}")]
    NotAvailable(String),
    #[error("Launch failed: {0}")]
    LaunchFailed(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// 终端类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalType {
    Auto,
    ITerm2,
    Terminal,
    Ghostty,
    WezTerm,
    Warp,
}

impl TerminalType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "iterm2" => Self::ITerm2,
            "terminal" => Self::Terminal,
            "ghostty" => Self::Ghostty,
            "wezterm" => Self::WezTerm,
            "warp" => Self::Warp,
            _ => Self::Auto,
        }
    }

    pub fn to_str(&self) -> &str {
        match self {
            Self::Auto => "auto",
            Self::ITerm2 => "iterm2",
            Self::Terminal => "terminal",
            Self::Ghostty => "ghostty",
            Self::WezTerm => "wezterm",
            Self::Warp => "warp",
        }
    }
}

/// 终端启动器
pub struct TerminalLauncher;

impl TerminalLauncher {
    /// 启动终端并执行 wrapper 脚本
    pub fn launch(
        terminal: TerminalType,
        working_dir: &Path,
        wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        let resolved_terminal = if terminal == TerminalType::Auto {
            Self::detect_available_terminal()
        } else {
            terminal
        };

        match resolved_terminal {
            TerminalType::Ghostty => Self::launch_ghostty(working_dir, wrapper_script),
            TerminalType::WezTerm => Self::launch_wezterm(working_dir, wrapper_script),
            TerminalType::Warp => Self::launch_warp(working_dir, wrapper_script),
            TerminalType::ITerm2 => Self::launch_iterm2(working_dir, wrapper_script),
            TerminalType::Terminal => Self::launch_terminal(working_dir, wrapper_script),
            TerminalType::Auto => {
                // Fallback to Terminal.app
                Self::launch_terminal(working_dir, wrapper_script)
            }
        }
    }

    /// 检测可用终端（按优先级）
    fn detect_available_terminal() -> TerminalType {
        if Self::is_terminal_available("iTerm") {
            TerminalType::ITerm2
        } else if Self::is_terminal_available("Ghostty") {
            TerminalType::Ghostty
        } else if Self::is_terminal_available("WezTerm") {
            TerminalType::WezTerm
        } else if Self::is_terminal_available("Warp") {
            TerminalType::Warp
        } else {
            TerminalType::Terminal
        }
    }

    /// 检查终端是否可用（通过 bundle ID）
    fn is_terminal_available(app_name: &str) -> bool {
        Command::new("mdfind")
            .arg(format!(
                "kMDItemCFBundleIdentifier == '{}'",
                Self::bundle_id(app_name)
            ))
            .output()
            .map(|output| !output.stdout.is_empty())
            .unwrap_or(false)
    }

    fn bundle_id(app_name: &str) -> &str {
        match app_name {
            "iTerm" => "com.googlecode.iterm2",
            "Ghostty" => "com.mitchellh.ghostty",
            "WezTerm" => "com.github.wez.wezterm",
            "Warp" => "dev.warp.Warp-Stable",
            "Terminal" => "com.apple.Terminal",
            _ => "",
        }
    }

    /// Ghostty: 原生 CLI
    fn launch_ghostty(
        working_dir: &Path,
        wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        let status = Command::new("open")
            .arg("-na")
            .arg("Ghostty")
            .arg("--args")
            .arg("--working-directory")
            .arg(working_dir)
            .arg("-e")
            .arg(wrapper_script)
            .status()?;

        if status.success() {
            Ok(())
        } else {
            Err(TerminalLauncherError::LaunchFailed(
                "Ghostty launch failed".to_string(),
            ))
        }
    }

    /// WezTerm: 原生 CLI (优先复用 mux)
    fn launch_wezterm(
        working_dir: &Path,
        wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        // 先尝试复用已开实例
        let spawn_result = Command::new("wezterm")
            .arg("cli")
            .arg("spawn")
            .arg("--cwd")
            .arg(working_dir)
            .arg("--")
            .arg(wrapper_script)
            .status();

        if let Ok(status) = spawn_result {
            if status.success() {
                return Ok(());
            }
        }

        // 复用失败,冷启动新实例
        let status = Command::new("wezterm")
            .arg("start")
            .arg("--cwd")
            .arg(working_dir)
            .arg("--")
            .arg(wrapper_script)
            .status()?;

        if status.success() {
            Ok(())
        } else {
            Err(TerminalLauncherError::LaunchFailed(
                "WezTerm launch failed".to_string(),
            ))
        }
    }

    /// Warp: URI scheme (注意: wrapper 需在 URI 外执行)
    fn launch_warp(
        working_dir: &Path,
        _wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        let encoded_path = urlencoding::encode(working_dir.to_str().unwrap_or(""));
        let uri = format!("warp://action/new_tab?path={}", encoded_path);

        let status = Command::new("open").arg(uri).status()?;

        if status.success() {
            Ok(())
        } else {
            Err(TerminalLauncherError::LaunchFailed(
                "Warp launch failed".to_string(),
            ))
        }
    }

    /// iTerm2: AppleScript with command
    fn launch_iterm2(
        _working_dir: &Path,
        wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        let script = format!(
            r#"tell application "iTerm"
    create window with default profile command "{}"
end tell"#,
            wrapper_script.display()
        );

        let status = Command::new("osascript").arg("-e").arg(&script).status()?;

        if status.success() {
            Ok(())
        } else {
            Err(TerminalLauncherError::LaunchFailed(
                "iTerm2 launch failed".to_string(),
            ))
        }
    }

    /// Terminal.app: AppleScript with do script
    fn launch_terminal(
        _working_dir: &Path,
        wrapper_script: &Path,
    ) -> Result<(), TerminalLauncherError> {
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            wrapper_script.display()
        );

        let status = Command::new("osascript").arg("-e").arg(&script).status()?;

        if status.success() {
            Ok(())
        } else {
            Err(TerminalLauncherError::LaunchFailed(
                "Terminal launch failed".to_string(),
            ))
        }
    }

    /// 生成启动命令（用于预览或测试）
    pub fn generate_launch_command(
        terminal: TerminalType,
        working_dir: &Path,
        wrapper_script: &Path,
    ) -> String {
        match terminal {
            TerminalType::Ghostty => {
                format!(
                    "open -na Ghostty --args --working-directory {} -e {}",
                    working_dir.display(),
                    wrapper_script.display()
                )
            }
            TerminalType::WezTerm => {
                format!(
                    "wezterm cli spawn --cwd {} -- {}",
                    working_dir.display(),
                    wrapper_script.display()
                )
            }
            TerminalType::Warp => {
                let encoded_path = urlencoding::encode(working_dir.to_str().unwrap_or(""));
                format!("open \"warp://action/new_tab?path={}\"", encoded_path)
            }
            TerminalType::ITerm2 => {
                format!(
                    "osascript -e 'tell application \"iTerm\" to create window with default profile command \"{}\"'",
                    wrapper_script.display()
                )
            }
            TerminalType::Terminal => {
                format!(
                    "osascript -e 'tell application \"Terminal\" to do script \"{}\"'",
                    wrapper_script.display()
                )
            }
            TerminalType::Auto => "auto (detect available)".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_terminal_type_conversions() {
        assert_eq!(TerminalType::from_str("iterm2"), TerminalType::ITerm2);
        assert_eq!(TerminalType::from_str("ghostty"), TerminalType::Ghostty);
        assert_eq!(TerminalType::from_str("wezterm"), TerminalType::WezTerm);
        assert_eq!(TerminalType::from_str("warp"), TerminalType::Warp);
        assert_eq!(TerminalType::from_str("terminal"), TerminalType::Terminal);
        assert_eq!(TerminalType::from_str("unknown"), TerminalType::Auto);

        assert_eq!(TerminalType::ITerm2.to_str(), "iterm2");
        assert_eq!(TerminalType::Auto.to_str(), "auto");
    }

    #[test]
    fn test_generate_launch_command_ghostty() {
        let cmd = TerminalLauncher::generate_launch_command(
            TerminalType::Ghostty,
            Path::new("/Users/test/project"),
            Path::new("/Users/test/.cc-use/runtime/wrapper.sh"),
        );

        assert!(cmd.contains("open -na Ghostty"));
        assert!(cmd.contains("--working-directory /Users/test/project"));
        assert!(cmd.contains("-e /Users/test/.cc-use/runtime/wrapper.sh"));
    }

    #[test]
    fn test_generate_launch_command_wezterm() {
        let cmd = TerminalLauncher::generate_launch_command(
            TerminalType::WezTerm,
            Path::new("/Users/test/project"),
            Path::new("/Users/test/.cc-use/runtime/wrapper.sh"),
        );

        assert!(cmd.contains("wezterm cli spawn"));
        assert!(cmd.contains("--cwd /Users/test/project"));
        assert!(cmd.contains("-- /Users/test/.cc-use/runtime/wrapper.sh"));
    }

    #[test]
    fn test_generate_launch_command_warp() {
        let cmd = TerminalLauncher::generate_launch_command(
            TerminalType::Warp,
            Path::new("/Users/test/project"),
            Path::new("/Users/test/.cc-use/runtime/wrapper.sh"),
        );

        assert!(cmd.contains("open \"warp://action/new_tab?path="));
        assert!(cmd.contains("%2FUsers%2Ftest%2Fproject")); // URL encoded
    }

    #[test]
    fn test_generate_launch_command_iterm2() {
        let cmd = TerminalLauncher::generate_launch_command(
            TerminalType::ITerm2,
            Path::new("/Users/test/project"),
            Path::new("/Users/test/.cc-use/runtime/wrapper.sh"),
        );

        assert!(cmd.contains("osascript -e"));
        assert!(cmd.contains("iTerm"));
        assert!(cmd.contains("create window with default profile command"));
        assert!(cmd.contains("/Users/test/.cc-use/runtime/wrapper.sh"));
    }

    #[test]
    fn test_generate_launch_command_terminal() {
        let cmd = TerminalLauncher::generate_launch_command(
            TerminalType::Terminal,
            Path::new("/Users/test/project"),
            Path::new("/Users/test/.cc-use/runtime/wrapper.sh"),
        );

        assert!(cmd.contains("osascript -e"));
        assert!(cmd.contains("Terminal"));
        assert!(cmd.contains("do script"));
        assert!(cmd.contains("/Users/test/.cc-use/runtime/wrapper.sh"));
    }

    #[test]
    fn test_bundle_id_mapping() {
        assert_eq!(
            TerminalLauncher::bundle_id("iTerm"),
            "com.googlecode.iterm2"
        );
        assert_eq!(
            TerminalLauncher::bundle_id("Ghostty"),
            "com.mitchellh.ghostty"
        );
        assert_eq!(
            TerminalLauncher::bundle_id("WezTerm"),
            "com.github.wez.wezterm"
        );
        assert_eq!(TerminalLauncher::bundle_id("Warp"), "dev.warp.Warp-Stable");
        assert_eq!(
            TerminalLauncher::bundle_id("Terminal"),
            "com.apple.Terminal"
        );
    }
}
