use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct ITerm2Strategy;

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
        path: &str,
        env: &EnvObject,
        cli_command: &str,
        _instance_label: Option<&str>,
    ) -> Result<(), String> {
        let escaped_path = path.replace('\'', "'\\''");
        let env_inline = build_env_inline(env);

        let full_command = format!(
            "cd '{}' && clear && {} {}",
            escaped_path, env_inline, cli_command
        );
        let escaped_command = full_command.replace('\\', "\\\\").replace('"', "\\\"");

        let script = format!(
            r#"tell application "iTerm2"
                activate
                set newWindow to (create window with default profile)
                tell current session of newWindow
                    write text "{}"
                end tell
            end tell"#,
            escaped_command
        );

        run_osascript(&script)
    }
}

fn build_env_inline(env: &EnvObject) -> String {
    env.iter()
        .map(|(k, v)| {
            let escaped_value = v.replace('\'', "'\\''");
            format!("{}='{}'", k, escaped_value)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn run_osascript(script: &str) -> Result<(), String> {
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript failed: {}", stderr))
    }
}
