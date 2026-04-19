use crate::models::ProxyStatus;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const DAEMON_BINARY_NAME: &str = "cc-use-daemon";

/// Timeout for the TCP port probe used to distinguish "launchd says running"
/// from "port is actually reachable". Kept short so UI polling stays snappy.
const PROBE_TIMEOUT_MS: u64 = 500;

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
    let mut status = parse_daemon_status(&output, proxy_port)?;

    // launchctl thinks the service is loaded, but the process may still be
    // starting up, stuck, or listening on the wrong port. The port probe is
    // what actually proves a request from the CLI will land.
    let is_listening = probe_tcp_port(proxy_port);
    if status.is_running && !is_listening {
        status.is_running = false;
        if status.last_error.is_none() {
            status.last_error = Some(format!(
                "Daemon process loaded but port {} is not reachable",
                proxy_port
            ));
        }
    }

    Ok(status)
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

/// Locate the daemon binary that matches the current build profile.
///
/// Dev builds must only ever launch the dev-compiled daemon (which reads
/// the dev SQLite DB); production builds must only ever launch the daemon
/// shipped inside the app bundle. Allowing fallback between the two was
/// the root cause of prod apps running on the dev port.
fn resolve_daemon_binary_path() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Failed to resolve workspace root".to_string())?;
        let path = workspace_root
            .join("target")
            .join("debug")
            .join(DAEMON_BINARY_NAME);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Dev daemon binary not found at {}. Build it with: cargo build -p cc-use-daemon",
            path.display()
        ));
    }

    #[cfg(not(debug_assertions))]
    {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to resolve current executable path: {}", e))?;
        let current_dir = current_exe.parent().unwrap_or_else(|| Path::new("/"));

        let candidates = [
            // Tauri externalBin on macOS lands the binary next to the host
            // executable under Contents/MacOS.
            current_dir.join(DAEMON_BINARY_NAME),
            // Some Tauri versions place it under Resources instead.
            current_dir.join("../Resources").join(DAEMON_BINARY_NAME),
            current_dir
                .join("../Resources")
                .join("binaries")
                .join(DAEMON_BINARY_NAME),
        ];

        for candidate in &candidates {
            if candidate.exists() {
                return Ok(candidate.clone());
            }
        }

        let checked = candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "Production daemon binary '{}' not found. Checked: {}",
            DAEMON_BINARY_NAME, checked
        ))
    }
}

/// Returns true if a TCP connection to 127.0.0.1:port completes within
/// PROBE_TIMEOUT_MS. Used to distinguish "launchd says loaded" from
/// "requests actually make it to the proxy".
pub fn probe_tcp_port(port: i32) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{}", port).parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(PROBE_TIMEOUT_MS)).is_ok()
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
    use super::{parse_daemon_status, probe_tcp_port};
    use std::net::TcpListener;

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

    #[test]
    fn probe_tcp_port_returns_true_when_listener_accepts() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port() as i32;
        assert!(probe_tcp_port(port), "expected probe to succeed for {}", port);
    }

    #[test]
    fn probe_tcp_port_returns_false_when_port_closed() {
        // Bind to reserve a port, capture it, then drop the listener so the
        // port is almost certainly unused by the time we probe.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            listener.local_addr().expect("local addr").port() as i32
        };
        assert!(
            !probe_tcp_port(port),
            "expected probe to fail for closed port {}",
            port
        );
    }
}
