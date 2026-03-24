use crate::db::Database;
use crate::models::ProxySession;
use std::collections::HashMap;

pub mod iterm2;
pub mod mac_terminal;
pub mod windows_terminal;
pub mod cmd;

/// Environment variables to inject into the terminal
pub type EnvObject = HashMap<String, String>;

/// Terminal launch strategy
pub trait TerminalStrategy: Send + Sync {
    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn launch(&self, path: &str, env: &EnvObject, cli_command: &str) -> Result<(), String>;
}

/// Get the appropriate terminal strategy
pub fn get_strategy(terminal_type: &str) -> Option<Box<dyn TerminalStrategy>> {
    let strategy: Box<dyn TerminalStrategy> = match terminal_type {
        "iterm2" => Box::new(iterm2::ITerm2Strategy),
        "terminal" => Box::new(mac_terminal::MacTerminalStrategy),
        "wt" => Box::new(windows_terminal::WindowsTerminalStrategy),
        "cmd" => Box::new(cmd::CmdStrategy),
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
        Box::new(windows_terminal::WindowsTerminalStrategy),
        Box::new(cmd::CmdStrategy),
    ];

    strategies.into_iter().find(|s| s.is_available())
}

/// Build environment variables for a project launch
pub fn build_env_for_project(
    _db: &Database,
    _provider_id: &str,
    _api_key_id: &str,
    cli_type: &str,
    session_token: &str,
    proxy_port: i32,
) -> EnvObject {
    let mut env = EnvObject::new();

    if cli_type == "codex" {
        // Only set API key env var; base URL is passed via -c flag to avoid
        // the "OPENAI_BASE_URL is deprecated" warning.
        env.insert("OPENAI_API_KEY".to_string(), session_token.to_string());

        // Write auth.json so Codex CLI credential cache uses the session token
        if let Some(home) = dirs::home_dir() {
            let codex_dir = home.join(".codex");
            let _ = std::fs::create_dir_all(&codex_dir);
            let auth_json = serde_json::json!({
                "OPENAI_API_KEY": session_token,
            });
            let _ = std::fs::write(
                codex_dir.join("auth.json"),
                serde_json::to_string(&auth_json).unwrap_or_default(),
            );
        }
    } else {
        env.insert("ANTHROPIC_BASE_URL".to_string(), format!("http://localhost:{}", proxy_port));
        env.insert("ANTHROPIC_API_KEY".to_string(), session_token.to_string());
    }

    env
}

/// Launch a terminal for a project
pub fn launch_terminal(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<(), String> {
    let project = db.project_get(project_id)
        .map_err(|e| e.to_string())?
        .ok_or("Project not found")?;

    let provider_id = override_provider_id
        .map(|s| s.to_string())
        .or(project.provider_id.clone())
        .ok_or("No provider configured for this project")?;

    let api_key_id = override_api_key_id
        .map(|s| s.to_string())
        .or(project.api_key_id.clone())
        .ok_or("No API key configured for this project")?;

    let cli_type = &project.cli_type;
    let terminal_type = &project.terminal_type;

    // Get settings for proxy port
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    let proxy_port = settings.proxy_port;

    // Reuse existing session for the same project/provider/key, otherwise create one.
    let existing_session = db
        .proxy_session_list()
        .ok()
        .and_then(|sessions| {
            sessions
                .into_iter()
                .find(|s| {
                    s.project_id.as_deref() == Some(project_id)
                        && s.provider_id == provider_id
                        && s.api_key_id == api_key_id
                })
        });

    let session_token = if let Some(existing) = existing_session {
        existing.session_token
    } else {
        let token = format!("session-{}", nanoid::nanoid!(16));
        let session = ProxySession {
            session_token: token.clone(),
            provider_id: provider_id.clone(),
            api_key_id: api_key_id.clone(),
            project_id: Some(project_id.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        db.proxy_session_create(&session).map_err(|e| e.to_string())?;
        token
    };

    // Build env
    let env = build_env_for_project(db, &provider_id, &api_key_id, cli_type, &session_token, proxy_port);

    // Get terminal strategy
    let strategy = get_strategy(terminal_type)
        .or_else(|| get_first_available())
        .ok_or("No terminal available")?;

    let cli_command = if cli_type == "codex" {
        // Pass openai_base_url via -c flag (highest precedence, no file writes,
        // no "OPENAI_BASE_URL is deprecated" warning).
        format!(
            "codex -c 'openai_base_url=\"http://localhost:{}/v1\"'",
            proxy_port
        )
    } else {
        "claude".to_string()
    };
    strategy.launch(&project.path, &env, &cli_command)?;

    // Update last opened
    let _ = db.project_update_last_opened(project_id);

    // Create usage log
    let provider = db.provider_get(&provider_id).ok().flatten();
    let api_key = db.api_key_get(&api_key_id).ok().flatten();
    let usage_log = crate::models::UsageLog {
        id: nanoid::nanoid!(),
        project_id: Some(project_id.to_string()),
        project_name: project.name.clone(),
        provider_id: Some(provider_id.clone()),
        provider_name: provider.map(|p| p.name),
        api_key_id: Some(api_key_id.clone()),
        api_key_alias: api_key.and_then(|k| k.alias),
        key_type: Some(cli_type.to_string()),
        launched_at: chrono::Utc::now().to_rfc3339(),
        duration: None,
    };
    let _ = db.usage_log_create(&usage_log);

    Ok(())
}
