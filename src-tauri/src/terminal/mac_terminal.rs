//! Terminal.app 启动策略
//!
//! v3.2.0: 改用 wrapper 脚本方式。不再内联 env/token/CLI 命令到 AppleScript 中。
//! 终端只负责用 Terminal AppleScript 打开并执行 wrapper 脚本。

use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct MacTerminalStrategy;

impl TerminalStrategy for MacTerminalStrategy {
    fn name(&self) -> &str {
        "Terminal"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn launch(
        &self,
        wrapper_path: &str,
        _env: &EnvObject,
        _cli_command: &str,
        _instance_label: Option<&str>,
    ) -> Result<(), String> {
        // v3.2.0: 直接执行 wrapper 脚本,不内联 env/command
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            wrapper_path
        );

        let output = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("osascript failed: {}", stderr))
        }
    }
}
