use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct MacTerminalStrategy;

impl TerminalStrategy for MacTerminalStrategy {
    fn name(&self) -> &str { "Terminal" }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn launch(&self, path: &str, env: &EnvObject, cli_command: &str) -> Result<(), String> {
        let escaped_path = path.replace('\'', "'\\''");
        let env_inline: String = env.iter()
            .map(|(k, v)| {
                // Escape single quotes in the value for shell
                let escaped_value = v.replace('\'', "'\\''");
                // Use single quotes to avoid issues with special characters
                format!("{}='{}'", k, escaped_value)
            })
            .collect::<Vec<_>>()
            .join(" ");

        let full_command = format!("cd '{}' && clear && {} {}", escaped_path, env_inline, cli_command);
        // Escape for AppleScript string: backslash and double quote need escaping
        let escaped_command = full_command.replace('\\', "\\\\").replace('"', "\\\"");

        let script = format!(
            r#"tell application "Terminal"
                activate
                do script "{}"
            end tell"#,
            escaped_command
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
