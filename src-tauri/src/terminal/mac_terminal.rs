//! Terminal.app 启动策略
//!
//! v3.2.0: 改用 wrapper 脚本方式。不再内联 env/token/CLI 命令到 AppleScript 中。
//! 终端只负责用 Terminal AppleScript 打开并执行 wrapper 脚本。

use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct MacTerminalStrategy;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

impl TerminalStrategy for MacTerminalStrategy {
    fn name(&self) -> &str {
        "Terminal"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn launch(
        &self,
        working_dir: &str,
        _env: &EnvObject,
        wrapper_path: &str,
        _instance_label: Option<&str>,
    ) -> Result<(), String> {
        // v3.2.0: 直接执行 wrapper 脚本,不内联 env/command
        let command = format!(
            "cd {} && {}",
            shell_quote(working_dir),
            shell_quote(wrapper_path)
        );
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            command.replace('"', "\\\"")
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
