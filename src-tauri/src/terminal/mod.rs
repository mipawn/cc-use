use crate::db::Database;
use crate::models::{ProxySession, TerminalLaunchPreview};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub mod cmd;
pub mod iterm2;
pub mod mac_terminal;
pub mod windows_terminal;

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

fn merge_json_objects(base: Option<&Value>, overlay: Option<&Value>) -> Map<String, Value> {
    let mut merged = Map::new();

    if let Some(Value::Object(base_obj)) = base {
        for (key, value) in base_obj {
            merged.insert(key.clone(), value.clone());
        }
    }

    if let Some(Value::Object(overlay_obj)) = overlay {
        for (key, value) in overlay_obj {
            merged.insert(key.clone(), value.clone());
        }
    }

    merged
}

fn json_value_to_env_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true".to_string() } else { "false".to_string() }),
        Value::Number(n) => Some(n.to_string()),
        _ => Some(value.to_string()),
    }
}

fn write_codex_auth(session_token: &str) {
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
}

fn build_cli_command(cli_type: &str, env: &EnvObject) -> String {
    if cli_type == "codex" {
        let base_url = env
            .get("OPENAI_BASE_URL")
            .cloned()
            .unwrap_or_else(|| "http://localhost:12345/v1".to_string())
            .replace('"', "\\\"");
        format!("codex -c 'openai_base_url=\"{}\"'", base_url)
    } else {
        "claude".to_string()
    }
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

    let merged_config = merge_json_objects(global_config, api_key.config.as_ref());
    let mut env = EnvObject::new();

    for (key, value) in merged_config.iter() {
        if let Some(env_value) = json_value_to_env_string(value) {
            env.insert(key.clone(), env_value);
        }
    }

    if cli_type == "codex" {
        env.insert("OPENAI_API_KEY".to_string(), session_token.to_string());
        env.insert(
            "OPENAI_BASE_URL".to_string(),
            format!("http://localhost:{}/v1", proxy_port),
        );
    } else {
        env.entry("API_TIMEOUT_MS".to_string())
            .or_insert_with(|| "3000000".to_string());
        env.entry("CLAUDE_CODE_ATTRIBUTION_HEADER".to_string())
            .or_insert_with(|| "0".to_string());
        env.entry("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string())
            .or_insert_with(|| "1".to_string());
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            format!("http://localhost:{}", proxy_port),
        );
        env.remove("ANTHROPIC_API_KEY");
        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), session_token.to_string());
    }

    Ok(TerminalLaunchPreview {
        cli_type: cli_type.to_string(),
        command: build_cli_command(cli_type, &env),
        env,
    })
}

fn resolve_launch_preview_for_project(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<(String, String, String, String, TerminalLaunchPreview), String> {
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

    let cli_type = project.cli_type.clone();
    let terminal_type = project.terminal_type.clone();
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    let proxy_port = settings.proxy_port;

    let existing_session = db.proxy_session_list().ok().and_then(|sessions| {
        sessions.into_iter().find(|s| {
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

    let preview = resolve_launch_preview(db, &cli_type, &api_key_id, &session_token, proxy_port)?;
    Ok((project.path, provider_id, api_key_id, terminal_type, preview))
}

pub fn get_launch_preview(
    db: &Database,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    api_key_id: Option<&str>,
    cli_type: &str,
) -> Result<TerminalLaunchPreview, String> {
    if let Some(project_id) = project_id {
        let (_, _, _, _, preview) =
            resolve_launch_preview_for_project(db, project_id, provider_id, api_key_id)?;
        return Ok(preview);
    }

    let api_key_id = api_key_id.ok_or("API key is required")?;
    let settings = db.settings_get().map_err(|e| e.to_string())?;
    resolve_launch_preview(db, cli_type, api_key_id, "preview-session-token", settings.proxy_port)
}

fn launch_with_preview(
    strategy: &dyn TerminalStrategy,
    path: &str,
    preview: &TerminalLaunchPreview,
) -> Result<(), String> {
    if preview.cli_type == "codex" {
        if let Some(session_token) = preview.env.get("OPENAI_API_KEY") {
            write_codex_auth(session_token);
        }
    }
    strategy.launch(path, &preview.env, &preview.command)
}

pub fn launch_terminal(
    db: &Database,
    project_id: &str,
    override_provider_id: Option<&str>,
    override_api_key_id: Option<&str>,
) -> Result<(), String> {
    let project = db.project_get(project_id)
        .map_err(|e| e.to_string())?
        .ok_or("Project not found")?;
    let cli_type = project.cli_type.clone();
    let project_name = project.name.clone();

    let (project_path, provider_id, api_key_id, terminal_type, preview) =
        resolve_launch_preview_for_project(db, project_id, override_provider_id, override_api_key_id)?;

    let strategy = get_strategy(&terminal_type)
        .or_else(|| get_first_available())
        .ok_or("No terminal available")?;
    launch_with_preview(strategy.as_ref(), &project_path, &preview)?;

    let _ = db.project_update_last_opened(project_id);

    let provider = db.provider_get(&provider_id).ok().flatten();
    let api_key = db.api_key_get(&api_key_id).ok().flatten();
    let usage_log = crate::models::UsageLog {
        id: nanoid::nanoid!(),
        project_id: Some(project_id.to_string()),
        project_name,
        provider_id: Some(provider_id.clone()),
        provider_name: provider.map(|p| p.name),
        api_key_id: Some(api_key_id.clone()),
        api_key_alias: api_key.and_then(|k| k.alias),
        key_type: Some(cli_type),
        launched_at: chrono::Utc::now().to_rfc3339(),
        duration: None,
    };
    let _ = db.usage_log_create(&usage_log);

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
    launch_with_preview(strategy.as_ref(), path, &preview)
}

#[cfg(test)]
mod tests {
    use super::resolve_launch_preview;
    use crate::db::Database;
    use crate::models::{CreateApiKeyInput, CreateProviderInput};
    use serde_json::json;

    fn create_test_provider(db: &Database) -> String {
        db.provider_create(&CreateProviderInput {
            name: "Test Provider".to_string(),
            base_url: "https://example.com".to_string(),
            provider_type: Some("claude".to_string()),
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: None,
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
        })
        .unwrap()
        .id
    }

    #[test]
    fn resolve_launch_preview_merges_global_key_and_runtime_for_claude() {
        let db = Database::new_in_memory().unwrap();
        db.settings_update(&json!({
            "claudeConfig": {
                "ANTHROPIC_MODEL": "global-model",
                "API_TIMEOUT_MS": "1000"
            }
        }))
        .unwrap();

        let provider_id = create_test_provider(&db);
        let api_key = db
            .api_key_create(&CreateApiKeyInput {
                provider_id,
                alias: Some("test".to_string()),
                value: "sk-test".to_string(),
                types: Some(vec!["claude".to_string()]),
                priority: Some(0),
                is_active: Some(true),
                config: Some(json!({
                    "ANTHROPIC_MODEL": "key-model",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4"
                })),
                cost_multiplier: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
            })
            .unwrap();

        let preview = resolve_launch_preview(&db, "claude", &api_key.id, "session-abc", 12345).unwrap();
        assert_eq!(preview.env.get("ANTHROPIC_MODEL"), Some(&"key-model".to_string()));
        assert_eq!(
            preview.env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
            Some(&"gpt-5.4".to_string())
        );
        assert_eq!(preview.env.get("API_TIMEOUT_MS"), Some(&"1000".to_string()));
        assert_eq!(
            preview.env.get("ANTHROPIC_BASE_URL"),
            Some(&"http://localhost:12345".to_string())
        );
        assert_eq!(
            preview.env.get("ANTHROPIC_AUTH_TOKEN"),
            Some(&"session-abc".to_string())
        );
        assert_eq!(preview.env.get("ANTHROPIC_API_KEY"), None);
    }

    #[test]
    fn resolve_launch_preview_overrides_codex_runtime_fields() {
        let db = Database::new_in_memory().unwrap();
        db.settings_update(&json!({
            "codexConfig": {
                "OPENAI_BASE_URL": "https://upstream.example/v1",
                "OPENAI_API_KEY": "global-key",
                "OPENAI_MODEL": "global-model"
            }
        }))
        .unwrap();

        let provider_id = create_test_provider(&db);
        let api_key = db
            .api_key_create(&CreateApiKeyInput {
                provider_id,
                alias: Some("test".to_string()),
                value: "sk-test".to_string(),
                types: Some(vec!["codex".to_string()]),
                priority: Some(0),
                is_active: Some(true),
                config: Some(json!({
                    "OPENAI_API_KEY": "key-value",
                    "OPENAI_MODEL": "key-model"
                })),
                cost_multiplier: None,
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
            })
            .unwrap();

        let preview = resolve_launch_preview(&db, "codex", &api_key.id, "session-codex", 22345).unwrap();
        assert_eq!(preview.env.get("OPENAI_MODEL"), Some(&"key-model".to_string()));
        assert_eq!(
            preview.env.get("OPENAI_API_KEY"),
            Some(&"session-codex".to_string())
        );
        assert_eq!(
            preview.env.get("OPENAI_BASE_URL"),
            Some(&"http://localhost:22345/v1".to_string())
        );
        assert!(preview.command.contains("openai_base_url=\"http://localhost:22345/v1\""));
    }
}
