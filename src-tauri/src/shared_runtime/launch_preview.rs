use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub type EnvObject = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalLaunchPreview {
    pub cli_type: String,
    pub env: EnvObject,
    pub command: String,
    pub prelaunch_command: Option<String>,
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
        Value::Bool(b) => Some(if *b {
            "true".to_string()
        } else {
            "false".to_string()
        }),
        Value::Number(n) => Some(n.to_string()),
        _ => Some(value.to_string()),
    }
}

fn build_cli_command(_cli_type: &str, _env: &EnvObject) -> String {
    // 终端启动仅用于 Claude Code(Codex 走 Codex Desktop 配置接管,不经终端)。
    "claude".to_string()
}

pub fn resolve_launch_preview_from_configs(
    cli_type: &str,
    global_config: Option<&Value>,
    api_key_config: Option<&Value>,
    session_token: &str,
    proxy_port: i32,
) -> TerminalLaunchPreview {
    // global_config = defaults shared across all keys of this CLI type;
    // api_key_config = per-key overrides. Both are injected as env vars at
    // launch time so the CLI's own settings files stay untouched.
    let merged = merge_json_objects(global_config, api_key_config);
    let mut env = EnvObject::new();

    for (key, value) in merged.iter() {
        if key == "prelaunchCommand" {
            continue;
        }
        if let Some(env_value) = json_value_to_env_string(value) {
            env.insert(key.clone(), env_value);
        } else {
            env.remove(key);
        }
    }

    // Claude Code only. 注入 Anthropic 代理 env;显式移除 ANTHROPIC_API_KEY。
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
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        session_token.to_string(),
    );

    TerminalLaunchPreview {
        cli_type: cli_type.to_string(),
        command: build_cli_command(cli_type, &env),
        env,
        prelaunch_command: None,
    }
}
