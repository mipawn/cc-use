mod support;

use cc_use_lib::models::CreateApiKeyInput;
use cc_use_lib::terminal::get_launch_preview;
use serde_json::json;
use support::{create_api_key, create_project, create_provider, TempDb};

#[test]
fn merges_global_key_and_runtime_for_claude_preview() {
    let fixture = TempDb::new();
    fixture
        .db
        .settings_update(&json!({
          "claudeConfig": {
            "ANTHROPIC_MODEL": "global-model",
            "API_TIMEOUT_MS": "1000"
          }
        }))
        .unwrap();

    let provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let api_key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id,
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
            model_mapping: None,
        })
        .unwrap();

    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();

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
        Some(&"http://localhost:12345".to_string()),
    );
    assert_eq!(
        preview.env.get("ANTHROPIC_AUTH_TOKEN"),
        Some(&"preview-session-token".to_string()),
    );
    assert_eq!(preview.env.get("ANTHROPIC_API_KEY"), None);
}

#[test]
fn project_preview_uses_placeholder_token_and_does_not_create_session() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let api_key = create_api_key(&fixture.db, &provider.id, "claude");
    let project = create_project(
        &fixture.db,
        Some(provider.id.clone()),
        Some(api_key.id.clone()),
        "claude",
    );

    let preview = get_launch_preview(&fixture.db, Some(&project.id), None, None, "claude")
        .expect("project preview");
    let token = preview.env.get("ANTHROPIC_AUTH_TOKEN").cloned().unwrap();

    assert_eq!(token, "preview-session-token");
    assert!(fixture.db.proxy_session_list().unwrap().is_empty());
}

#[test]
fn project_preview_applies_overrides_without_creating_session() {
    let fixture = TempDb::new();
    let default_provider = create_provider(&fixture.db, "Default Provider", "claude");
    let default_api_key = create_api_key(&fixture.db, &default_provider.id, "claude");
    let project = create_project(
        &fixture.db,
        Some(default_provider.id),
        Some(default_api_key.id),
        "claude",
    );

    let override_provider = create_provider(&fixture.db, "Override Provider", "claude");
    let override_api_key = create_api_key(&fixture.db, &override_provider.id, "claude");

    let preview = get_launch_preview(
        &fixture.db,
        Some(&project.id),
        Some(&override_provider.id),
        Some(&override_api_key.id),
        "claude",
    )
    .unwrap();

    assert_eq!(
        preview.env.get("ANTHROPIC_AUTH_TOKEN"),
        Some(&"preview-session-token".to_string())
    );
    assert!(fixture.db.proxy_session_list().unwrap().is_empty());
}

#[test]
fn overlay_null_unsets_inherited_env_and_stringifies_values() {
    let fixture = TempDb::new();
    fixture
        .db
        .settings_update(&json!({
          "claudeConfig": {
            "ANTHROPIC_MODEL": "global-model",
            "ANTHROPIC_API_KEY": "global-secret",
            "FEATURE_FLAG": true,
            "RETRY_COUNT": 3,
            "JSON_VALUE": { "mode": "strict" }
          }
        }))
        .unwrap();

    let provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let api_key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id,
            alias: Some("test".to_string()),
            value: "sk-test".to_string(),
            types: Some(vec!["claude".to_string()]),
            priority: Some(0),
            is_active: Some(true),
            config: Some(json!({
              "ANTHROPIC_API_KEY": null,
              "FEATURE_FLAG": false,
              "RETRY_COUNT": 5,
              "JSON_VALUE": { "mode": "relaxed" }
            })),
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
        })
        .unwrap();

    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();

    assert_eq!(preview.env.get("ANTHROPIC_API_KEY"), None);
    assert_eq!(preview.env.get("FEATURE_FLAG"), Some(&"false".to_string()));
    assert_eq!(preview.env.get("RETRY_COUNT"), Some(&"5".to_string()));
    assert_eq!(
        preview.env.get("JSON_VALUE"),
        Some(&"{\"mode\":\"relaxed\"}".to_string()),
    );
}
