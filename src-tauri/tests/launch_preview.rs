use cc_use_lib::shared_runtime::resolve_launch_preview_from_configs;
use serde_json::json;

#[test]
fn resolve_launch_preview_merges_global_key_and_runtime_for_claude() {
    let preview = resolve_launch_preview_from_configs(
        "claude",
        Some(&json!({
            "ANTHROPIC_MODEL": "global-model",
            "API_TIMEOUT_MS": "1000"
        })),
        Some(&json!({
            "ANTHROPIC_MODEL": "key-model",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4"
        })),
        "session-abc",
        12345,
    );

    assert_eq!(
        preview.env.get("ANTHROPIC_MODEL"),
        Some(&"key-model".to_string())
    );
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
    let preview = resolve_launch_preview_from_configs(
        "codex",
        Some(&json!({
            "OPENAI_BASE_URL": "https://upstream.example/v1",
            "OPENAI_API_KEY": "global-key",
            "OPENAI_MODEL": "global-model"
        })),
        Some(&json!({
            "OPENAI_API_KEY": "key-value",
            "OPENAI_MODEL": "key-model"
        })),
        "session-codex",
        22345,
    );

    assert_eq!(
        preview.env.get("OPENAI_MODEL"),
        Some(&"key-model".to_string())
    );
    assert_eq!(
        preview.env.get("OPENAI_API_KEY"),
        Some(&"session-codex".to_string())
    );
    assert_eq!(
        preview.env.get("OPENAI_BASE_URL"),
        Some(&"http://localhost:22345/v1".to_string())
    );
    assert!(preview
        .command
        .contains("openai_base_url=\"http://localhost:22345/v1\""));
}

#[test]
fn resolve_launch_preview_overlay_null_unsets_inherited_env_and_stringifies_values() {
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

    assert_eq!(preview.env.get("ANTHROPIC_API_KEY"), None);
    assert_eq!(preview.env.get("FEATURE_FLAG"), Some(&"false".to_string()));
    assert_eq!(preview.env.get("RETRY_COUNT"), Some(&"5".to_string()));
    assert_eq!(
        preview.env.get("JSON_VALUE"),
        Some(&"{\"mode\":\"relaxed\"}".to_string())
    );
}
