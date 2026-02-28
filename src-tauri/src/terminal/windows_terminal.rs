use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct WindowsTerminalStrategy;

impl TerminalStrategy for WindowsTerminalStrategy {
    fn name(&self) -> &str { "Windows Terminal" }

    fn is_available(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            Command::new("where")
                .arg("wt")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        { false }
    }

    fn launch(&self, path: &str, env: &EnvObject, cli_command: &str) -> Result<(), String> {
        let env_sets: String = env.iter()
            .map(|(k, v)| format!("$env:{}=\"{}\"", k, v))
            .collect::<Vec<_>>()
            .join("; ");

        let ps_command = if env_sets.is_empty() {
            format!("cd '{}'; {}", path, cli_command)
        } else {
            format!("cd '{}'; {}; {}", path, env_sets, cli_command)
        };

        Command::new("wt")
            .args(["new-tab", "powershell", "-NoExit", "-Command", &ps_command])
            .spawn()
            .map_err(|e| format!("Failed to launch Windows Terminal: {}", e))?;

        Ok(())
    }
}
