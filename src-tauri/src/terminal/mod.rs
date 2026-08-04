use crate::db::Database;
use crate::models::{ManagedInstance, ProxySession, TerminalLaunchPreview};
use crate::shared_runtime::{
    ensure_management_token, new_session_token, resolve_launch_preview_from_configs,
    ManagementTokenPaths,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub mod grok;
pub mod iterm2;
pub mod launcher;
pub mod mac_terminal;

const MANAGED_INSTANCE_HEARTBEAT_INTERVAL_SECS: u64 = 5;

/// Environment variables to inject into the terminal
pub type EnvObject = HashMap<String, String>;

struct ProjectLaunchContext {
    project_id: String,
    project_name: String,
    project_path: String,
    provider_id: String,
    api_key_id: String,
    cli_type: String,
    terminal_type: String,
    prelaunch_command: Option<String>,
}

struct PreparedManagedLaunch {
    instance_id: String,
    project_name: String,
    project_path: String,
    provider_id: String,
    api_key_id: String,
    cli_type: String,
    terminal_type: String,
    instance_label: String,
    env: EnvObject,
    script_path: PathBuf,
}

/// Terminal launch strategy
pub trait TerminalStrategy: Send + Sync {
    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn launch(
        &self,
        path: &str,
        env: &EnvObject,
        cli_command: &str,
        instance_label: Option<&str>,
    ) -> Result<(), String>;
}

/// Get the appropriate terminal strategy
pub fn get_strategy(terminal_type: &str) -> Option<Box<dyn TerminalStrategy>> {
    let strategy: Box<dyn TerminalStrategy> = match terminal_type {
        "iterm2" => Box::new(iterm2::ITerm2Strategy),
        "terminal" => Box::new(mac_terminal::MacTerminalStrategy),
        _ => return None,
    };

    if strategy.is_available() {
        Some(strategy)
    } else {
        None
    }
}

/// Get first available strategy as fallback
pub fn get_first_available() -> Option<Box<dyn TerminalStrategy>> {
    let strategies: Vec<Box<dyn TerminalStrategy>> = vec![
        Box::new(iterm2::ITerm2Strategy),
        Box::new(mac_terminal::MacTerminalStrategy),
    ];

    strategies.into_iter().find(|s| s.is_available())
}

fn build_instance_short_code(value: &str) -> String {
    let chars = value.chars().count();
    let take = chars.min(8);
    value
        .chars()
        .skip(chars.saturating_sub(take))
        .collect::<String>()
}

fn build_instance_label(session_token: &str) -> String {
    build_instance_short_code(session_token)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn set_script_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("Failed to set wrapper permissions: {}", e))?;
    }

    Ok(())
}

fn resolve_management_token() -> Result<String, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let paths = ManagementTokenPaths::from_home(&home_dir);
    ensure_management_token(&paths)
}

fn runtime_script_dir() -> Result<PathBuf, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let dir = home_dir.join(".cc-use").join("runtime");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create runtime directory: {}", e))?;
    Ok(dir)
}

fn resolve_launch_preview(
    db: &Database,
    cli_type: &str,
    api_key_id: &str,
    session_token: &str,
    proxy_port: i32,
    prelaunch_command: Option<String>,
) -> Result<TerminalLaunchPreview, String> {
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    let api_key = db
        .api_key_get(api_key_id)
        .map_err(|e| e.to_string())?
        .ok_or("API key not found")?;

    let (global_config, api_key_config) = match cli_type {
        "claude" | "claude_code" => (settings.claude_config.as_ref(), api_key.config.as_ref()),
        "grok" => (None, None),
        _ => return Err(format!("Unsupported terminal client: {}", cli_type)),
    };

    let preview = resolve_launch_preview_from_configs(
        cli_type,
        global_config,
        api_key_config,
        session_token,
        proxy_port,
    );

    let preview = TerminalLaunchPreview {
        cli_type: preview.cli_type,
        command: preview.command,
        env: preview.env,
        prelaunch_command,
    };

    Ok(preview)
}

fn resolve_project_launch_context(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
    override_cli_type: Option<&str>,
) -> Result<ProjectLaunchContext, String> {
    let project = db
        .project_get(project_id)
        .map_err(|e| e.to_string())?
        .ok_or("Project not found")?;

    let normalize_cli_type = |value: &str| {
        if value == "claude" {
            "claude_code".to_string()
        } else {
            value.to_string()
        }
    };
    let cli_type = override_cli_type
        .map(normalize_cli_type)
        .unwrap_or_else(|| normalize_cli_type(&project.cli_type));
    let binding = project.bindings.get(&cli_type);
    let legacy_matches = normalize_cli_type(&project.cli_type) == cli_type;

    let provider_id = override_provider_id
        .map(|value| value.to_string())
        .or_else(|| binding.and_then(|value| value.provider_id.clone()))
        .or_else(|| {
            legacy_matches
                .then(|| project.provider_id.clone())
                .flatten()
        })
        .ok_or("No provider configured for this project")?;
    let api_key_id = override_api_key_id
        .map(|value| value.to_string())
        .or_else(|| binding.and_then(|value| value.api_key_id.clone()))
        .or_else(|| legacy_matches.then(|| project.api_key_id.clone()).flatten())
        .ok_or("No API key configured for this project")?;

    Ok(ProjectLaunchContext {
        project_id: project.id,
        project_name: project.name,
        project_path: project.path,
        provider_id,
        api_key_id,
        cli_type,
        terminal_type: binding
            .map(|value| value.terminal_type.clone())
            .or_else(|| legacy_matches.then(|| project.terminal_type.clone()))
            .unwrap_or_else(|| "iterm2".to_string()),
        prelaunch_command: binding
            .and_then(|value| value.prelaunch_command.clone())
            .or_else(|| {
                legacy_matches
                    .then(|| project.prelaunch_command.clone())
                    .flatten()
            })
            .filter(|value| !value.trim().is_empty()),
    })
}

fn grok_upstream_model(db: &Database, api_key_id: &str) -> String {
    db.api_key_get(api_key_id)
        .ok()
        .flatten()
        .and_then(|key| key.model_mapping)
        .and_then(|mapping| serde_json::from_str::<serde_json::Value>(&mapping).ok())
        .and_then(|mapping| {
            mapping
                .get("grok")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| "grok-4.5".to_string())
}

pub fn prepare_grok_config(db: &Database, api_key_id: &str) -> Result<(), String> {
    let settings = db.settings_get().map_err(|error| error.to_string())?;
    grok::ensure_user_config(settings.proxy_port, &grok_upstream_model(db, api_key_id))
}

fn write_managed_launch_script(
    script_path: &Path,
    project_path: &str,
    preview: &TerminalLaunchPreview,
    instance_id: &str,
    instance_label: &str,
    management_token: &str,
    proxy_port: i32,
) -> Result<(), String> {
    let mut env_entries = preview.env.iter().collect::<Vec<_>>();
    env_entries.sort_by(|a, b| a.0.cmp(b.0));

    let mut script = String::from("#!/bin/sh\n");
    script.push_str("set -u\n\n");
    script.push_str(&format!("cd {}\n\n", shell_quote(project_path)));

    for (key, value) in env_entries {
        script.push_str(&format!("export {}={}\n", key, shell_quote(value)));
    }

    script.push('\n');
    script.push_str(&format!(
        "export CC_USE_INSTANCE_ID={}\n",
        shell_quote(instance_id)
    ));
    script.push_str(&format!("export CC_USE_PROXY_PORT={}\n", proxy_port));
    script.push_str(&format!(
        "export CC_USE_MANAGEMENT_TOKEN={}\n",
        shell_quote(management_token)
    ));
    script.push_str(&format!(
        "export CC_USE_INSTANCE_LABEL={}\n",
        shell_quote(instance_label)
    ));
    script.push_str(&format!(
        "CC_USE_LAUNCH_COMMAND={}\n",
        shell_quote(&preview.command)
    ));
    script.push_str(&format!(
        "CC_USE_PRELAUNCH_COMMAND={}\n",
        shell_quote(preview.prelaunch_command.as_deref().unwrap_or(""))
    ));
    script.push_str(&format!(
        "CC_USE_FOREGROUND={}\n",
        if preview.cli_type == "grok" { "1" } else { "0" }
    ));
    script.push_str("CC_USE_STOP_SENT=0\n");
    script.push_str("CC_USE_CHILD_PID=\n");
    script.push_str("CC_USE_HB_PID=\n");
    script.push_str("CC_USE_INSTANCE_PHASE=launching\n");
    script.push_str("CC_USE_SCRIPT_PATH=\"$0\"\n\n");

    script.push_str(
        r#"cc_use_post() {
  endpoint="$1"
  payload="$2"
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  curl -sS -X POST \
    -H "x-cc-use-management-token: ${CC_USE_MANAGEMENT_TOKEN}" \
    -H 'content-type: application/json' \
    -d "$payload" \
    "http://127.0.0.1:${CC_USE_PROXY_PORT}${endpoint}" >/dev/null 2>&1 || true
}

cc_use_send_heartbeat() {
  process_pid="${CC_USE_CHILD_PID:-null}"
  cc_use_post '/_management/instances/heartbeat' \
    "{\"instanceId\":\"${CC_USE_INSTANCE_ID}\",\"processPid\":${process_pid},\"shellPid\":$$,\"phase\":\"${CC_USE_INSTANCE_PHASE}\"}"
}

cc_use_stop_once() {
  exit_code="${1:-0}"
  reason="${2:-process_exit}"
  if [ "${CC_USE_STOP_SENT}" = "1" ]; then
    return
  fi
  CC_USE_STOP_SENT=1
  if [ -n "${CC_USE_HB_PID:-}" ]; then
    kill "${CC_USE_HB_PID}" >/dev/null 2>&1 || true
  fi
  cc_use_post '/_management/instances/stop' \
    "{\"instanceId\":\"${CC_USE_INSTANCE_ID}\",\"processPid\":${CC_USE_CHILD_PID:-null},\"shellPid\":$$,\"exitCode\":${exit_code},\"stopReason\":\"${reason}\"}"
  rm -f "${CC_USE_SCRIPT_PATH}" >/dev/null 2>&1 || true
}

cc_use_heartbeat_loop() {
  while kill -0 "${CC_USE_CHILD_PID}" >/dev/null 2>&1; do
"#,
    );
    script.push_str(&format!(
        "    sleep {}\n",
        MANAGED_INSTANCE_HEARTBEAT_INTERVAL_SECS
    ));
    script.push_str(
        r#"    cc_use_send_heartbeat
  done
}

cc_use_prelaunch_heartbeat_loop() {
  while :; do
"#,
    );
    script.push_str(&format!(
        "    sleep {}\n",
        MANAGED_INSTANCE_HEARTBEAT_INTERVAL_SECS
    ));
    script.push_str(
        r#"    cc_use_send_heartbeat
  done
}

trap 'cc_use_stop_once $? shell_exit' EXIT HUP INT TERM
cc_use_send_heartbeat

if [ -n "${CC_USE_PRELAUNCH_COMMAND}" ]; then
  cc_use_prelaunch_heartbeat_loop &
  CC_USE_HB_PID=$!
  eval "$CC_USE_PRELAUNCH_COMMAND"
  CC_USE_PRELAUNCH_EXIT_CODE=$?
  kill "${CC_USE_HB_PID}" >/dev/null 2>&1 || true
  wait "${CC_USE_HB_PID}" 2>/dev/null || true
  CC_USE_HB_PID=
  if [ "${CC_USE_PRELAUNCH_EXIT_CODE}" -ne 0 ]; then
    cc_use_stop_once "${CC_USE_PRELAUNCH_EXIT_CODE}" prelaunch_failed
    exit "${CC_USE_PRELAUNCH_EXIT_CODE}"
  fi
fi

CC_USE_INSTANCE_PHASE=running
if [ "${CC_USE_FOREGROUND}" = "1" ]; then
  # Grok Build is an interactive TUI and must own the foreground terminal.
  # Running it with `&` prevents it from reading the TTY and leaves a blank window.
  CC_USE_CHILD_PID=$$
else
  eval "$CC_USE_LAUNCH_COMMAND" &
  CC_USE_CHILD_PID=$!
fi
cc_use_send_heartbeat
cc_use_heartbeat_loop &
CC_USE_HB_PID=$!
if [ "${CC_USE_FOREGROUND}" = "1" ]; then
  eval "$CC_USE_LAUNCH_COMMAND"
  CC_USE_EXIT_CODE=$?
else
  wait "${CC_USE_CHILD_PID}"
  CC_USE_EXIT_CODE=$?
fi
cc_use_stop_once "${CC_USE_EXIT_CODE}" process_exit
exit "${CC_USE_EXIT_CODE}"
"#,
    );

    std::fs::write(script_path, script)
        .map_err(|e| format!("Failed to write managed wrapper script: {}", e))?;
    set_script_permissions(script_path)?;
    Ok(())
}

fn prepare_managed_launch(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
    override_cli_type: Option<&str>,
) -> Result<PreparedManagedLaunch, String> {
    let context = resolve_project_launch_context(
        db,
        project_id,
        override_provider_id,
        override_api_key_id,
        override_cli_type,
    )?;
    create_managed_launch(
        db,
        &context.cli_type,
        &context.provider_id,
        &context.api_key_id,
        Some(context.project_id.as_str()),
        &context.project_name,
        &context.project_path,
        &context.terminal_type,
        context.prelaunch_command.clone(),
        "project_launch",
    )
}

/// Everything the CLI needs to run a freshly prepared instance inside the
/// terminal it was invoked from.
pub struct CliPreparedLaunch {
    pub instance_id: String,
    pub instance_label: String,
    pub script_path: PathBuf,
}

/// v3.7.0 CLI launch: same session/instance/wrapper preparation as a GUI
/// launch, but no terminal window is opened — the caller execs the wrapper in
/// the terminal it already owns. Instance semantics (heartbeat, stop, hot
/// switch) are identical to GUI-launched instances.
pub fn prepare_cli_terminal_launch(
    db: &Database,
    cli_type: &str,
    provider_id: &str,
    api_key_id: &str,
    project_id: Option<&str>,
    project_name: &str,
    project_path: &str,
    prelaunch_command: Option<String>,
) -> Result<CliPreparedLaunch, String> {
    let prepared = create_managed_launch(
        db,
        cli_type,
        provider_id,
        api_key_id,
        project_id,
        project_name,
        project_path,
        // The user's own terminal hosts the process; no strategy involved.
        "cli",
        prelaunch_command,
        "cli_launch",
    )?;
    Ok(CliPreparedLaunch {
        instance_id: prepared.instance_id,
        instance_label: prepared.instance_label,
        script_path: prepared.script_path,
    })
}

#[allow(clippy::too_many_arguments)]
fn create_managed_launch(
    db: &Database,
    cli_type: &str,
    provider_id: &str,
    api_key_id: &str,
    project_id: Option<&str>,
    project_name: &str,
    project_path: &str,
    terminal_type: &str,
    prelaunch_command: Option<String>,
    assignment_source: &str,
) -> Result<PreparedManagedLaunch, String> {
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    if cli_type == "grok" {
        grok::ensure_user_config(settings.proxy_port, &grok_upstream_model(db, api_key_id))?;
    }
    let launched_at = chrono::Utc::now().to_rfc3339();
    let session_token = new_session_token();
    let instance_id = format!("instance-{}", nanoid::nanoid!(16));
    let instance_label = build_instance_label(&session_token);
    let preview = resolve_launch_preview(
        db,
        cli_type,
        api_key_id,
        &session_token,
        settings.proxy_port,
        prelaunch_command,
    )?;
    let management_token = resolve_management_token()?;
    let script_path = runtime_script_dir()?.join(format!("{}.sh", instance_id));
    write_managed_launch_script(
        &script_path,
        project_path,
        &preview,
        &instance_id,
        &instance_label,
        &management_token,
        settings.proxy_port,
    )?;

    let session = ProxySession {
        session_token: session_token.clone(),
        provider_id: provider_id.to_string(),
        api_key_id: api_key_id.to_string(),
        project_id: project_id.map(str::to_string),
        created_at: launched_at.clone(),
        session_kind: "managed".to_string(),
        last_seen_at: launched_at.clone(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: Some(cli_type.to_string()),
    };
    if let Err(error) = db.proxy_session_create(&session) {
        let _ = std::fs::remove_file(&script_path);
        return Err(format!("Failed to create proxy session: {}", error));
    }

    let managed_instance = ManagedInstance {
        id: instance_id.clone(),
        session_token,
        project_id: project_id.map(str::to_string),
        provider_id: Some(provider_id.to_string()),
        api_key_id: Some(api_key_id.to_string()),
        cli_type: cli_type.to_string(),
        terminal_type: terminal_type.to_string(),
        project_path: project_path.to_string(),
        shell_pid: None,
        process_pid: None,
        status: "launching".to_string(),
        assignment_source: Some(assignment_source.to_string()),
        last_seen_at: launched_at.clone(),
        launched_at: launched_at.clone(),
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
    };

    if let Err(error) = db.managed_instance_create(&managed_instance) {
        let _ = db.proxy_session_delete(&managed_instance.session_token);
        let _ = std::fs::remove_file(&script_path);
        return Err(format!("Failed to create managed instance: {}", error));
    }

    Ok(PreparedManagedLaunch {
        instance_id,
        project_name: project_name.to_string(),
        project_path: project_path.to_string(),
        provider_id: provider_id.to_string(),
        api_key_id: api_key_id.to_string(),
        cli_type: cli_type.to_string(),
        terminal_type: terminal_type.to_string(),
        instance_label,
        env: EnvObject::new(),
        script_path,
    })
}

fn mark_launch_failed(db: &Database, instance_id: &str, stop_reason: &str) {
    let session_token = db
        .managed_instance_get(instance_id)
        .ok()
        .flatten()
        .map(|instance| instance.session_token);
    let now = chrono::Utc::now().to_rfc3339();
    let _ = db.managed_instance_mark_stopped(
        instance_id,
        None,
        None,
        "failed",
        Some(stop_reason),
        None,
        &now,
    );
    if let Some(session_token) = session_token {
        let _ = db.proxy_session_revoke(&session_token, stop_reason, &now);
    }
}

fn launch_with_preview(
    strategy: &dyn TerminalStrategy,
    path: &str,
    preview: &TerminalLaunchPreview,
    instance_label: Option<&str>,
) -> Result<(), String> {
    strategy.launch(path, &preview.env, &preview.command, instance_label)
}

pub fn get_launch_preview(
    db: &Database,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    api_key_id: Option<&str>,
    cli_type: &str,
) -> Result<TerminalLaunchPreview, String> {
    if let Some(project_id) = project_id {
        let context = resolve_project_launch_context(
            db,
            project_id,
            provider_id,
            api_key_id,
            Some(cli_type),
        )?;
        let settings = db.settings_get().map_err(|e| e.to_string())?;
        return resolve_launch_preview(
            db,
            &context.cli_type,
            &context.api_key_id,
            "preview-session-token",
            settings.proxy_port,
            context.prelaunch_command,
        );
    }

    let api_key_id = api_key_id.ok_or("API key is required")?;
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    resolve_launch_preview(
        db,
        cli_type,
        api_key_id,
        "preview-session-token",
        settings.proxy_port,
        None,
    )
}

pub fn launch_terminal(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
    override_cli_type: Option<&str>,
) -> Result<(), String> {
    let prepared = prepare_managed_launch(
        db,
        project_id,
        override_provider_id,
        override_api_key_id,
        override_cli_type,
    )?;

    let strategy = get_strategy(&prepared.terminal_type)
        .or_else(|| get_first_available())
        .ok_or("No terminal available")?;

    // v3.2.0: 终端在项目目录打开,并执行 wrapper 脚本
    let wrapper_path = prepared.script_path.to_string_lossy().to_string();
    if let Err(error) = strategy.launch(
        &prepared.project_path,
        &prepared.env,
        &wrapper_path,
        Some(&prepared.instance_label),
    ) {
        let _ = std::fs::remove_file(&prepared.script_path);
        mark_launch_failed(db, &prepared.instance_id, "launch_failed");
        return Err(error);
    }

    if let Err(e) = db.project_update_last_opened(project_id) {
        log::error!("Failed to update project last_opened_at: {}", e);
    }

    let provider = db.provider_get(&prepared.provider_id).ok().flatten();
    let api_key = db.api_key_get(&prepared.api_key_id).ok().flatten();
    let usage_log = crate::models::UsageLog {
        id: nanoid::nanoid!(),
        project_id: Some(project_id.to_string()),
        project_name: prepared.project_name,
        provider_id: Some(prepared.provider_id.clone()),
        provider_name: provider.map(|p| p.name),
        api_key_id: Some(prepared.api_key_id.clone()),
        api_key_alias: api_key.and_then(|k| k.alias),
        key_type: Some(prepared.cli_type),
        launched_at: chrono::Utc::now().to_rfc3339(),
        duration: None,
    };
    if let Err(e) = db.usage_log_create(&usage_log) {
        log::error!("Failed to create usage log: {}", e);
    }

    Ok(())
}

pub fn launch_terminal_path_only(default_terminal_type: &str, path: &str) -> Result<(), String> {
    let strategy = get_strategy(default_terminal_type)
        .or_else(|| get_first_available())
        .ok_or("No terminal available")?;
    let preview = TerminalLaunchPreview {
        cli_type: "claude".to_string(),
        env: EnvObject::new(),
        command: "claude".to_string(),
        prelaunch_command: None,
    };
    launch_with_preview(strategy.as_ref(), path, &preview, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(cli_type: &str) -> TerminalLaunchPreview {
        TerminalLaunchPreview {
            cli_type: cli_type.to_string(),
            env: EnvObject::new(),
            command: if cli_type == "grok" {
                "grok -m cc-use".to_string()
            } else {
                "claude".to_string()
            },
            prelaunch_command: None,
        }
    }

    #[test]
    fn grok_wrapper_runs_the_tui_in_the_foreground() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grok-wrapper.sh");

        write_managed_launch_script(
            &path,
            "/tmp/project",
            &preview("grok"),
            "instance-test",
            "test",
            "management-token",
            22345,
        )
        .unwrap();

        let script = std::fs::read_to_string(&path).unwrap();
        assert!(script.contains("CC_USE_FOREGROUND=1"));
        assert!(script.contains(
            "if [ \"${CC_USE_FOREGROUND}\" = \"1\" ]; then\n  eval \"$CC_USE_LAUNCH_COMMAND\""
        ));
    }

    #[test]
    fn claude_wrapper_keeps_the_existing_background_supervision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude-wrapper.sh");

        write_managed_launch_script(
            &path,
            "/tmp/project",
            &preview("claude_code"),
            "instance-test",
            "test",
            "management-token",
            22345,
        )
        .unwrap();

        let script = std::fs::read_to_string(&path).unwrap();
        assert!(script.contains("CC_USE_FOREGROUND=0"));
        assert!(script.contains("eval \"$CC_USE_LAUNCH_COMMAND\" &\n  CC_USE_CHILD_PID=$!"));
        assert!(script.contains("CC_USE_INSTANCE_PHASE=launching"));
        assert!(script.contains("\\\"phase\\\":\\\"${CC_USE_INSTANCE_PHASE}\\\""));
        assert!(script.contains("cc_use_prelaunch_heartbeat_loop"));
        assert!(script.contains("CC_USE_INSTANCE_PHASE=running"));
        let syntax = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .status()
            .unwrap();
        assert!(syntax.success());
    }
}
