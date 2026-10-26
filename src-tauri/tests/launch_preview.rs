use cc_use_lib::shared_runtime::{
    apply_auto_mode_launch_env, resolve_launch_preview_from_configs, EnvObject,
};
use serde_json::json;

#[test]
fn auto_mode_env_is_opt_in_and_requires_a_model() {
    let mut env = EnvObject::new();
    apply_auto_mode_launch_env(&mut env, None);
    assert!(env.is_empty());

    let disabled = json!({"version":2,"clients":{"claude_code":{"upstream":{
        "autoMode":{"enabled":false,"model":"glm-5-air"}
    }}}})
    .to_string();
    apply_auto_mode_launch_env(&mut env, Some(&disabled));
    assert!(env.is_empty());

    for empty_model in ["", "   "] {
        let mapping = json!({"autoMode":{"enabled":true,"model":empty_model}}).to_string();
        apply_auto_mode_launch_env(&mut env, Some(&mapping));
        assert!(env.is_empty(), "model {empty_model:?} must not inject");
    }
}

#[test]
fn auto_mode_env_reads_only_the_claude_code_scope_and_trims_the_model() {
    let mapping = json!({"version":2,"clients":{
        "claude_code":{"upstream":{"autoMode":{"enabled":true,"model":"  glm-5-air  "}}},
        "claude_desktop":{"upstream":{"autoMode":{"enabled":true,"model":"desktop-model"}}}
    }})
    .to_string();
    let mut env = EnvObject::new();
    apply_auto_mode_launch_env(&mut env, Some(&mapping));

    assert_eq!(
        env.get("CLAUDE_CODE_AUTO_MODE_SERVER").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        env.get("CLAUDE_CODE_AUTO_MODE_MODEL").map(String::as_str),
        Some("glm-5-air")
    );
}

#[test]
fn auto_mode_env_keeps_explicit_user_values() {
    let mapping = json!({"autoMode":{"enabled":true,"model":"glm-5-air"}}).to_string();
    let mut env = EnvObject::from([
        ("CLAUDE_CODE_AUTO_MODE_SERVER".to_string(), "1".to_string()),
        (
            "CLAUDE_CODE_AUTO_MODE_MODEL".to_string(),
            "user-model".to_string(),
        ),
    ]);
    apply_auto_mode_launch_env(&mut env, Some(&mapping));

    assert_eq!(
        env.get("CLAUDE_CODE_AUTO_MODE_SERVER").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        env.get("CLAUDE_CODE_AUTO_MODE_MODEL").map(String::as_str),
        Some("user-model")
    );
}

#[test]
fn resolve_launch_preview_merges_global_and_key_config_for_claude() {
    let preview = resolve_launch_preview_from_configs(
        "claude",
        Some(&json!({
            "ANTHROPIC_MODEL": "global-model",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "global-sonnet",
            "API_TIMEOUT_MS": "1000"
        })),
        Some(&json!({
            "ANTHROPIC_MODEL": "key-model",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4"
        })),
        "session-abc",
        12345,
    );

    // Key-level overrides win over global
    assert_eq!(
        preview.env.get("ANTHROPIC_MODEL"),
        Some(&"key-model".to_string())
    );
    // Global-only values survive
    assert_eq!(
        preview.env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        Some(&"global-sonnet".to_string())
    );
    // Key-only additions survive
    assert_eq!(
        preview.env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
        Some(&"gpt-5.4".to_string())
    );
    // User-provided API_TIMEOUT_MS overrides runtime default
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
fn resolve_launch_preview_key_config_null_unsets_and_stringifies_values() {
    let preview = resolve_launch_preview_from_configs(
        "claude",
        Some(&json!({
            "ANTHROPIC_MODEL": "global-model",
            "ANTHROPIC_API_KEY": "global-secret",
            "FEATURE_FLAG": true,
            "RETRY_COUNT": 3,
            "JSON_VALUE": { "mode": "strict" }
        })),
        Some(&json!({
            "ANTHROPIC_API_KEY": null,
            "FEATURE_FLAG": false,
            "RETRY_COUNT": 5,
            "JSON_VALUE": { "mode": "relaxed" }
        })),
        "session-abc",
        12345,
    );

    // ANTHROPIC_API_KEY is unset by the null overlay (and also removed by runtime)
    assert_eq!(preview.env.get("ANTHROPIC_API_KEY"), None);
    // Key-level overrides of primitives
    assert_eq!(preview.env.get("FEATURE_FLAG"), Some(&"false".to_string()));
    assert_eq!(preview.env.get("RETRY_COUNT"), Some(&"5".to_string()));
    assert_eq!(
        preview.env.get("JSON_VALUE"),
        Some(&"{\"mode\":\"relaxed\"}".to_string())
    );
    // Global-only value flows through
    assert_eq!(
        preview.env.get("ANTHROPIC_MODEL"),
        Some(&"global-model".to_string())
    );
}

#[test]
fn resolve_launch_preview_filters_prelaunch_command_without_exporting_it() {
    let preview = resolve_launch_preview_from_configs(
        "claude",
        Some(&json!({
            "prelaunchCommand": "source .venv/bin/activate",
            "ANTHROPIC_MODEL": "global-model"
        })),
        Some(&json!({
            "prelaunchCommand": "mise exec -- claude-ready"
        })),
        "session-abc",
        12345,
    );

    assert_eq!(preview.prelaunch_command, None);
    assert_eq!(preview.env.get("prelaunchCommand"), None);
    assert_eq!(
        preview.env.get("ANTHROPIC_MODEL"),
        Some(&"global-model".to_string())
    );
}

#[test]
fn resolve_launch_preview_ignores_legacy_prelaunch_command_values() {
    let preview = resolve_launch_preview_from_configs(
        "claude",
        Some(&json!({
            "prelaunchCommand": "source .venv/bin/activate"
        })),
        Some(&json!({
            "prelaunchCommand": ""
        })),
        "session-abc",
        12345,
    );

    assert_eq!(preview.prelaunch_command, None);
    assert_eq!(preview.env.get("prelaunchCommand"), None);
}
