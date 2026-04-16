use crate::models::ProxyStatus;
use std::path::{Path, PathBuf};
use std::process::Command;

const DAEMON_BINARY_NAME: &str = "cc-use-daemon";

pub fn start_daemon() -> Result<(), String> {
    run_daemon_command(["start"])?;
    Ok(())
}

pub fn stop_daemon() -> Result<(), String> {
    run_daemon_command(["stop"])?;
    Ok(())
}

pub fn restart_daemon() -> Result<(), String> {
    run_daemon_command(["restart"])?;
    Ok(())
}

pub fn install_daemon() -> Result<(), String> {
    run_daemon_command(["install"])?;
    Ok(())
}

pub fn uninstall_daemon() -> Result<(), String> {
    run_daemon_command(["uninstall"])?;
    Ok(())
}

pub fn read_daemon_status(proxy_port: i32) -> Result<ProxyStatus, String> {
    let output = run_daemon_command(["status"])?;
    parse_daemon_status(&output, proxy_port)
}

fn run_daemon_command<const N: usize>(args: [&str; N]) -> Result<String, String> {
    let binary = resolve_daemon_binary_path()?;
    let output = Command::new(&binary)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute {}: {}", binary.display(), e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() { stderr } else { stdout };
        Err(format!(
            "{} {} failed: {}",
            binary.display(),
            args.join(" "),
            details
        ))
    }
}

fn resolve_daemon_binary_path() -> Result<PathBuf, String> {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "Failed to resolve workspace root".to_string())?;

    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve current executable path: {}", e))?;
    let current_dir = current_exe.parent().unwrap_or_else(|| Path::new("/"));

    let candidates = [
        workspace_root
            .join("target")
            .join("debug")
            .join(DAEMON_BINARY_NAME),
        workspace_root
            .join("target")
            .join("release")
            .join(DAEMON_BINARY_NAME),
        current_dir.join(DAEMON_BINARY_NAME),
        current_dir.join("../MacOS").join(DAEMON_BINARY_NAME),
        current_dir.join("../Resources").join(DAEMON_BINARY_NAME),
        current_dir
            .join("../Resources")
            .join("binaries")
            .join(DAEMON_BINARY_NAME),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("Failed to locate {} binary", DAEMON_BINARY_NAME))
}

pub fn parse_daemon_status(output: &str, proxy_port: i32) -> Result<ProxyStatus, String> {
    let launch_agent = output
        .split("launch_agent=")
        .nth(1)
        .ok_or_else(|| format!("Unexpected daemon status output: {}", output))?;

    let management_token_present = output.contains("management_token_present=true");

    let is_running = launch_agent.starts_with("loaded:");
    let last_error = if launch_agent.starts_with("loaded:")
        || launch_agent.starts_with("installed:")
        || launch_agent == "not_installed"
    {
        if !management_token_present && is_running {
            Some("Daemon running but management token missing".to_string())
        } else {
            None
        }
    } else {
        Some(launch_agent.to_string())
    };

    Ok(ProxyStatus {
        is_running,
        port: proxy_port,
        request_count: 0,
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_daemon_status;

    #[test]
    fn parse_daemon_status_marks_loaded_as_running() {
        let status = parse_daemon_status(
            "cc-use-daemon status; management_token_present=true; launch_agent=loaded:gui/501/com.mipawn.cc-use.daemon = {",
            22345,
        )
        .unwrap();
        assert!(status.is_running);
        assert_eq!(status.port, 22345);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn parse_daemon_status_marks_installed_as_not_running() {
        let status = parse_daemon_status(
            "cc-use-daemon status; management_token_present=true; launch_agent=installed:/tmp/test.plist",
            22345,
        )
        .unwrap();
        assert!(!status.is_running);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn parse_daemon_status_marks_not_installed_as_not_running() {
        let status = parse_daemon_status(
            "cc-use-daemon status; management_token_present=true; launch_agent=not_installed",
            22345,
        )
        .unwrap();
        assert!(!status.is_running);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn parse_daemon_status_rejects_unexpected_output() {
        let error = parse_daemon_status("unexpected", 22345).unwrap_err();
        assert!(error.contains("Unexpected daemon status output"));
    }
}
