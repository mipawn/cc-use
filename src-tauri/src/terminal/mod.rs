use crate::db::Database;
use crate::models::{ManagedInstance, ProxySession, TerminalLaunchPreview};
use crate::shared_runtime::{
    ensure_management_token, new_session_token, resolve_launch_preview_from_configs,
    ManagementTokenPaths,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub mod iterm2;
pub mod mac_terminal;
pub mod launcher;

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
    command: String,
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
) -> Result<TerminalLaunchPreview, String> {
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    let api_key = db
        .api_key_get(api_key_id)
        .map_err(|e| e.to_string())?
        .ok_or("API key not found")?;

    let global_config = if cli_type == "codex" {
        settings.codex_config.as_ref()
    } else {
        settings.claude_config.as_ref()
    };

    let preview = resolve_launch_preview_from_configs(
        cli_type,
        global_config,
        api_key.config.as_ref(),
        session_token,
        proxy_port,
    );

    let preview = TerminalLaunchPreview {
        cli_type: preview.cli_type,
        command: preview.command,
        env: preview.env,
    };

    Ok(preview)
}

fn resolve_project_launch_context(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<ProjectLaunchContext, String> {
    let project = db
        .project_get(project_id)
        .map_err(|e| e.to_string())?
        .ok_or("Project not found")?;

    let provider_id = override_provider_id
        .map(|value| value.to_string())
        .or_else(|| project.provider_id.clone())
        .ok_or("No provider configured for this project")?;
    let api_key_id = override_api_key_id
        .map(|value| value.to_string())
        .or_else(|| project.api_key_id.clone())
        .ok_or("No API key configured for this project")?;

    Ok(ProjectLaunchContext {
        project_id: project.id,
        project_name: project.name,
        project_path: project.path,
        provider_id,
        api_key_id,
        cli_type: project.cli_type,
        terminal_type: project.terminal_type,
    })
}

fn write_managed_launch_script(
    script_path: &Path,
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
    script.push_str("CC_USE_STOP_SENT=0\n");
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
  cc_use_post '/_management/instances/heartbeat' \
    "{\"instanceId\":\"${CC_USE_INSTANCE_ID}\",\"processPid\":${CC_USE_CHILD_PID},\"shellPid\":$$}"
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

eval "$CC_USE_LAUNCH_COMMAND" &
CC_USE_CHILD_PID=$!
cc_use_send_heartbeat
cc_use_heartbeat_loop &
CC_USE_HB_PID=$!
trap 'cc_use_stop_once $? shell_exit' EXIT HUP INT TERM
wait "${CC_USE_CHILD_PID}"
CC_USE_EXIT_CODE=$?
cc_use_stop_once "${CC_USE_EXIT_CODE}" process_exit
exit "${CC_USE_EXIT_CODE}"
"#,
    );

    std::fs::write(script_path, script)
        .map_err(|e| format!("Failed to write managed wrapper script: {}", e))?;
    set_script_permissions(script_path)?;
    Ok(())
}

fn build_managed_launch_command(script_path: &Path) -> String {
    format!("sh {}", shell_quote(script_path.to_string_lossy().as_ref()))
}

fn prepare_managed_launch(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<PreparedManagedLaunch, String> {
    let context =
        resolve_project_launch_context(db, project_id, override_provider_id, override_api_key_id)?;
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    let launched_at = chrono::Utc::now().to_rfc3339();
    let session_token = new_session_token();
    let instance_id = format!("instance-{}", nanoid::nanoid!(16));
    let instance_label = build_instance_label(&session_token);
    let preview = resolve_launch_preview(
        db,
        &context.cli_type,
        &context.api_key_id,
        &session_token,
        settings.proxy_port,
    )?;
    let management_token = resolve_management_token()?;
    let script_path = runtime_script_dir()?.join(format!("{}.sh", instance_id));
    write_managed_launch_script(
        &script_path,
        &preview,
        &instance_id,
        &instance_label,
        &management_token,
        settings.proxy_port,
    )?;

    let session = ProxySession {
        session_token: session_token.clone(),
        provider_id: context.provider_id.clone(),
        api_key_id: context.api_key_id.clone(),
        project_id: Some(context.project_id.clone()),
        created_at: launched_at.clone(),
        cli_type: Some(context.cli_type.clone()),
    };
    if let Err(error) = db.proxy_session_create(&session) {
        let _ = std::fs::remove_file(&script_path);
        return Err(format!("Failed to create proxy session: {}", error));
    }

    let managed_instance = ManagedInstance {
        id: instance_id.clone(),
        session_token,
        project_id: Some(context.project_id.clone()),
        provider_id: Some(context.provider_id.clone()),
        api_key_id: Some(context.api_key_id.clone()),
        cli_type: context.cli_type.clone(),
        terminal_type: context.terminal_type.clone(),
        project_path: context.project_path.clone(),
        shell_pid: None,
        process_pid: None,
        status: "launching".to_string(),
        assignment_source: Some("project_launch".to_string()),
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
        project_name: context.project_name,
        project_path: context.project_path,
        provider_id: context.provider_id,
        api_key_id: context.api_key_id,
        cli_type: context.cli_type,
        terminal_type: context.terminal_type,
        instance_label,
        command: build_managed_launch_command(&script_path),
        env: EnvObject::new(),
        script_path,
    })
}

fn mark_launch_failed(db: &Database, instance_id: &str, stop_reason: &str) {
    let _ = db.managed_instance_mark_stopped(
        instance_id,
        None,
        None,
        "failed",
        Some(stop_reason),
        None,
        &chrono::Utc::now().to_rfc3339(),
    );
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
        let context = resolve_project_launch_context(db, project_id, provider_id, api_key_id)?;
        let settings = db.settings_get().map_err(|e| e.to_string())?;
        return resolve_launch_preview(
            db,
            &context.cli_type,
            &context.api_key_id,
            "preview-session-token",
            settings.proxy_port,
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
    )
}

pub fn launch_terminal(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<(), String> {
    let prepared =
        prepare_managed_launch(db, project_id, override_provider_id, override_api_key_id)?;

    let strategy = get_strategy(&prepared.terminal_type)
        .or_else(|| get_first_available())
        .ok_or("No terminal available")?;

    if let Err(error) = strategy.launch(
        &prepared.project_path,
        &prepared.env,
        &prepared.command,
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
    };
    launch_with_preview(strategy.as_ref(), path, &preview, None)
}
