use std::path::{Path, PathBuf};
use std::process::Command;

/// Launch agent label. dev/prod must differ so the two builds can coexist
/// without overwriting each other's plist or fighting for the same port.
#[cfg(debug_assertions)]
const LABEL: &str = "com.mipawn.cc-use.dev.daemon";
#[cfg(not(debug_assertions))]
const LABEL: &str = "com.mipawn.cc-use.daemon";

/// Labels we should proactively bootout + delete on every start, because
/// they belong to older revisions of this app that no longer use them.
///
/// IMPORTANT: do NOT add the *other* current label (e.g. the prod label
/// when compiled as dev) here. Dev and prod are legitimate siblings and
/// must coexist on the same machine — cleaning up the sibling would make
/// opening one app silently shut down the other. That was the regression
/// the first pass of this helper accidentally shipped.
const LEGACY_LABELS: &[&str] = &[
    // No retired labels yet. When we rename the current labels, move the
    // old strings into this list so existing users' LaunchAgents dirs get
    // swept on next launch.
];

pub fn install() -> Result<(), String> {
    cleanup_foreign_launch_agents();
    // bootout the current label first. Without this, launchctl returns
    // "already bootstrapped" when a stale plist is still loaded and the
    // freshly-written plist is silently ignored (wrong binary path, wrong
    // args, etc.). Treated as best-effort; stop() already swallows the
    // "not loaded" variants.
    let _ = stop();
    let paths = ensure_launch_agent()?;
    classify_bootstrap_result(run_launchctl([
        "bootstrap",
        &paths.domain_target,
        &paths.plist_path_string,
    ]))
}

pub fn start() -> Result<(), String> {
    cleanup_foreign_launch_agents();
    let _ = stop();
    let paths = ensure_launch_agent()?;
    classify_bootstrap_result(run_launchctl([
        "bootstrap",
        &paths.domain_target,
        &paths.plist_path_string,
    ]))
}

pub fn stop() -> Result<(), String> {
    let paths = launch_agent_paths()?;

    if !paths.plist_path.exists() {
        return Ok(());
    }

    classify_uninstall_result(run_launchctl(["bootout", &paths.service_target]))
}

pub fn restart() -> Result<(), String> {
    stop()?;
    start()
}

pub fn uninstall() -> Result<(), String> {
    let paths = launch_agent_paths()?;

    if paths.plist_path.exists() {
        stop()?;

        std::fs::remove_file(&paths.plist_path)
            .map_err(|e| format!("Failed to remove LaunchAgent plist: {}", e))?;
    }

    Ok(())
}

pub(crate) fn status() -> Result<String, String> {
    let paths = launch_agent_paths()?;
    classify_status_output(
        paths.plist_path.exists(),
        &paths.plist_path.display().to_string(),
        run_launchctl(["print", &paths.service_target]),
    )
}

#[derive(Debug, Clone)]
struct LaunchAgentPaths {
    launch_agents_dir: PathBuf,
    plist_path: PathBuf,
    plist_path_string: String,
    binary_path: PathBuf,
    domain_target: String,
    service_target: String,
}

fn launch_agent_paths() -> Result<LaunchAgentPaths, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let launch_agents_dir = home.join("Library").join("LaunchAgents");
    let plist_path = launch_agents_dir.join(format!("{}.plist", LABEL));
    let plist_path_string = plist_path.display().to_string();
    let binary_path = current_binary_path()?;
    let uid = current_uid();
    let domain_target = format!("gui/{}", uid);
    let service_target = format!("{}/{}", domain_target, LABEL);
    Ok(LaunchAgentPaths {
        launch_agents_dir,
        plist_path,
        plist_path_string,
        binary_path,
        domain_target,
        service_target,
    })
}

fn ensure_launch_agent() -> Result<LaunchAgentPaths, String> {
    let paths = launch_agent_paths()?;
    std::fs::create_dir_all(&paths.launch_agents_dir)
        .map_err(|e| format!("Failed to create LaunchAgents directory: {}", e))?;
    std::fs::write(&paths.plist_path, render_plist(&paths.binary_path))
        .map_err(|e| format!("Failed to write LaunchAgent plist: {}", e))?;
    Ok(paths)
}

fn current_binary_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("Failed to resolve daemon binary path: {}", e))
}

fn current_uid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn run_launchctl<const N: usize>(args: [&str; N]) -> Result<String, String> {
    let output = Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute launchctl: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() { stderr } else { stdout };
        Err(format!("launchctl {} failed: {}", args.join(" "), details))
    }
}

/// Labels we should proactively clean up before starting: anything in
/// LEGACY_LABELS that still has a plist on disk.
fn foreign_labels(current: &str) -> Vec<&'static str> {
    LEGACY_LABELS
        .iter()
        .copied()
        .filter(|label| *label != current)
        .collect()
}

/// Best-effort cleanup of LaunchAgents from retired label names. Errors
/// are swallowed: if launchctl or the filesystem complains, we continue.
/// We deliberately do NOT touch the *other* current label (dev vs prod)
/// — both are valid, coexisting siblings.
fn cleanup_foreign_launch_agents() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let agents_dir = home.join("Library").join("LaunchAgents");
    let uid = current_uid();

    for foreign in foreign_labels(LABEL) {
        let plist = agents_dir.join(format!("{}.plist", foreign));
        if !plist.exists() {
            continue;
        }
        let service_target = format!("gui/{}/{}", uid, foreign);
        let _ = run_launchctl(["bootout", &service_target]);
        let _ = std::fs::remove_file(&plist);
    }
}

fn render_plist(binary_path: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{binary}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
"#,
        label = LABEL,
        binary = binary_path.display()
    )
}

fn classify_bootstrap_result(result: Result<String, String>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.contains("already bootstrapped") => Ok(()),
        Err(error) => Err(error),
    }
}

fn classify_uninstall_result(result: Result<String, String>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(error)
            if error.contains("No such process")
                || error.contains("could not find service")
                || error.contains("not loaded") =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn classify_status_output(
    plist_exists: bool,
    plist_display: &str,
    print_result: Result<String, String>,
) -> Result<String, String> {
    if !plist_exists {
        return Ok("not_installed".to_string());
    }

    match print_result {
        Ok(output) => Ok(format!("loaded:{}", output.lines().next().unwrap_or(LABEL))),
        Err(error)
            if error.contains("Could not find service")
                || error.contains("not found")
                || error.contains("No such process") =>
        {
            Ok(format!("installed:{}", plist_display))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_bootstrap_result, classify_status_output, classify_uninstall_result,
        foreign_labels, render_plist, LABEL, LEGACY_LABELS,
    };
    use std::path::Path;

    #[test]
    fn current_label_is_not_in_legacy_list() {
        // Regression guard: the current dev/prod labels must never land in
        // LEGACY_LABELS, or cleanup_foreign_launch_agents would kill the
        // other build's daemon every time this one starts.
        assert!(
            !LEGACY_LABELS.contains(&LABEL),
            "LABEL {} leaked into LEGACY_LABELS, dev/prod coexistence would break",
            LABEL
        );
    }

    #[test]
    fn label_matches_build_profile() {
        // When the test binary is compiled with debug_assertions (the default
        // for `cargo test`), the daemon label must be the dev variant.
        if cfg!(debug_assertions) {
            assert_eq!(LABEL, "com.mipawn.cc-use.dev.daemon");
        } else {
            assert_eq!(LABEL, "com.mipawn.cc-use.daemon");
        }
    }

    #[test]
    fn foreign_labels_excludes_current() {
        let foreign = foreign_labels(LABEL);
        assert!(!foreign.contains(&LABEL));
    }

    #[test]
    fn foreign_labels_returns_only_legacy_entries() {
        // All entries emitted by foreign_labels must be retired labels,
        // never an in-use sibling. Today LEGACY_LABELS is empty, so this
        // collapses to "foreign list is empty"; when future renames add
        // entries, this still holds because foreign_labels pulls from
        // LEGACY_LABELS exclusively.
        let foreign = foreign_labels(LABEL);
        for label in &foreign {
            assert!(
                LEGACY_LABELS.contains(label),
                "foreign_labels emitted a non-legacy label: {}",
                label
            );
        }
    }

    #[test]
    fn render_plist_contains_label_and_binary() {
        let plist = render_plist(Path::new("/tmp/cc-use-daemon"));
        assert!(plist.contains(LABEL));
        assert!(plist.contains("/tmp/cc-use-daemon"));
        assert!(plist.contains("--foreground"));
    }

    #[test]
    fn classify_status_output_returns_not_installed_when_plist_missing() {
        let status =
            classify_status_output(false, "/tmp/test.plist", Ok("ignored".to_string())).unwrap();
        assert_eq!(status, "not_installed");
    }

    #[test]
    fn classify_status_output_returns_loaded_when_launchctl_print_succeeds() {
        let status = classify_status_output(
            true,
            "/tmp/test.plist",
            Ok("gui/501/com.mipawn.cc-use.daemon = {\n  state = running".to_string()),
        )
        .unwrap();
        assert_eq!(status, "loaded:gui/501/com.mipawn.cc-use.daemon = {");
    }

    #[test]
    fn classify_status_output_returns_loaded_with_label_when_stdout_is_empty() {
        let status = classify_status_output(true, "/tmp/test.plist", Ok(String::new())).unwrap();
        assert_eq!(status, format!("loaded:{}", LABEL));
    }

    #[test]
    fn classify_status_output_returns_installed_when_service_not_found() {
        let status = classify_status_output(
            true,
            "/tmp/test.plist",
            Err("launchctl print failed: Could not find service".to_string()),
        )
        .unwrap();
        assert_eq!(status, "installed:/tmp/test.plist");
    }

    #[test]
    fn classify_status_output_returns_installed_when_no_such_process() {
        let status = classify_status_output(
            true,
            "/tmp/test.plist",
            Err("launchctl print failed: No such process".to_string()),
        )
        .unwrap();
        assert_eq!(status, "installed:/tmp/test.plist");
    }

    #[test]
    fn classify_status_output_bubbles_unexpected_errors() {
        let error = classify_status_output(
            true,
            "/tmp/test.plist",
            Err("launchctl print failed: permission denied".to_string()),
        )
        .unwrap_err();
        assert!(error.contains("permission denied"));
    }

    #[test]
    fn classify_bootstrap_result_allows_already_bootstrapped() {
        assert!(classify_bootstrap_result(Err(
            "launchctl bootstrap failed: already bootstrapped".to_string()
        ))
        .is_ok());
    }

    #[test]
    fn classify_bootstrap_result_bubbles_unexpected_error() {
        let error = classify_bootstrap_result(Err(
            "launchctl bootstrap failed: permission denied".to_string()
        ))
        .unwrap_err();
        assert!(error.contains("permission denied"));
    }

    #[test]
    fn classify_uninstall_result_allows_missing_process_errors() {
        assert!(classify_uninstall_result(Err(
            "launchctl bootout failed: No such process".to_string()
        ))
        .is_ok());
        assert!(classify_uninstall_result(Err(
            "launchctl bootout failed: could not find service".to_string()
        ))
        .is_ok());
        assert!(
            classify_uninstall_result(Err("launchctl bootout failed: not loaded".to_string()))
                .is_ok()
        );
    }

    #[test]
    fn classify_uninstall_result_bubbles_unexpected_error() {
        let error = classify_uninstall_result(Err(
            "launchctl bootout failed: permission denied".to_string()
        ))
        .unwrap_err();
        assert!(error.contains("permission denied"));
    }
}
