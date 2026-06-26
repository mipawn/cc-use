//! iTerm2 终端启动策略
//!
//! v3.2.0: 改用 wrapper 脚本方式。不再内联 env/token/CLI 命令到 AppleScript 中。
//! 终端只负责用 iTerm2 AppleScript 打开并执行 wrapper 脚本。

use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct ITerm2Strategy;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

impl TerminalStrategy for ITerm2Strategy {
    fn name(&self) -> &str {
        "iTerm2"
    }

    fn is_available(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            Command::new("mdfind")
                .args(["kMDItemCFBundleIdentifier == com.googlecode.iterm2"])
                .output()
                .map(|o| !o.stdout.is_empty())
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
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
            r#"tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "{}"
    end tell
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
