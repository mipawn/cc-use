use super::{EnvObject, TerminalStrategy};
use std::process::Command;

pub struct CmdStrategy;

impl TerminalStrategy for CmdStrategy {
    fn name(&self) -> &str { "CMD" }

    fn is_available(&self) -> bool {
        cfg!(target_os = "windows")
    }

    fn launch(&self, path: &str, env: &EnvObject, cli_command: &str) -> Result<(), String> {
        let env_sets: String = env.iter()
            .map(|(k, v)| format!("set {}={}", k, v))
            .collect::<Vec<_>>()
            .join(" && ");

        let full_command = if env_sets.is_empty() {
            format!("cd /d \"{}\" && {}", path, cli_command)
        } else {
            format!("cd /d \"{}\" && {} && {}", path, env_sets, cli_command)
        };

        Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &full_command])
            .spawn()
            .map_err(|e| format!("Failed to launch CMD: {}", e))?;

        Ok(())
    }
}
