mod support;

use cc_use_lib::models::{CreateApiKeyInput, CreateProjectInput, UpsertProjectBindingInput};
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
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("test".to_string()),
            value: "sk-test".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: Some(json!({
              "ANTHROPIC_MODEL": "key-model",
              "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4"
            })),
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
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
    assert_eq!(preview.env.get("CLAUDE_CODE_AUTO_MODE_SERVER"), None);
    assert_eq!(preview.env.get("CLAUDE_CODE_AUTO_MODE_MODEL"), None);
}

#[test]
fn claude_preview_injects_local_auto_mode_classifier_env_when_opted_in() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let api_key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("auto-mode".to_string()),
            value: "sk-test".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: Some(
                json!({"version":2,"clients":{"claude_code":{"upstream":{
                    "autoMode":{"enabled":true,"model":"glm-5-air"}
                }}}})
                .to_string(),
            ),
            client_configs: None,
        })
        .unwrap();

    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude")
        .expect("claude preview");

    assert_eq!(
        preview.env.get("CLAUDE_CODE_AUTO_MODE_SERVER"),
        Some(&"0".to_string())
    );
    assert_eq!(
        preview.env.get("CLAUDE_CODE_AUTO_MODE_MODEL"),
        Some(&"glm-5-air".to_string())
    );
}

#[test]
fn grok_preview_uses_custom_model_without_claude_config() {
    let fixture = TempDb::new();
    fixture
        .db
        .settings_update(&json!({
          "claudeConfig": {
            "ANTHROPIC_MODEL": "must-not-leak"
          }
        }))
        .unwrap();

    let provider = create_provider(&fixture.db, "Grok Provider", "grok");
    let api_key = create_api_key(&fixture.db, &provider.id, "grok");
    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "grok")
        .expect("grok preview");

    assert_eq!(preview.command, "grok -m cc-use");
    assert_eq!(
        preview.env.get("CC_USE_GROK_TOKEN"),
        Some(&"preview-session-token".to_string())
    );
    assert_eq!(preview.env.get("GROK_MODELS_BASE_URL"), None);
    assert_eq!(preview.env.get("GROK_XAI_API_BASE_URL"), None);
    assert_eq!(preview.env.get("XAI_API_KEY"), None);
    assert_eq!(preview.env.get("ANTHROPIC_MODEL"), None);
    assert_eq!(preview.env.get("ANTHROPIC_AUTH_TOKEN"), None);
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
fn project_preview_uses_the_requested_clients_own_binding() {
    let fixture = TempDb::new();
    let claude_provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let claude_key = create_api_key(&fixture.db, &claude_provider.id, "claude");
    let grok_provider = create_provider(&fixture.db, "Grok Provider", "grok");
    let grok_key = create_api_key(&fixture.db, &grok_provider.id, "grok");
    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "Shared Project".to_string(),
            path: "/tmp/shared-project".to_string(),
            group_name: None,
            remark: None,
            provider_id: Some(claude_provider.id),
            api_key_id: Some(claude_key.id),
            cli_type: Some("claude_code".to_string()),
            terminal_type: Some("terminal".to_string()),
            prelaunch_command: Some("claude-init".to_string()),
        })
        .unwrap();
    fixture
        .db
        .project_binding_upsert(
            &project.id,
            &UpsertProjectBindingInput {
                cli_type: "grok".to_string(),
                provider_id: Some(grok_provider.id),
                api_key_id: Some(grok_key.id),
                client_profile_id: None,
                terminal_type: Some("iterm2".to_string()),
                prelaunch_command: Some("grok-init".to_string()),
            },
        )
        .unwrap();

    let claude =
        get_launch_preview(&fixture.db, Some(&project.id), None, None, "claude_code").unwrap();
    let grok = get_launch_preview(&fixture.db, Some(&project.id), None, None, "grok").unwrap();

    assert_eq!(claude.command, "claude");
    assert_eq!(claude.prelaunch_command.as_deref(), Some("claude-init"));
    assert_eq!(grok.command, "grok -m cc-use");
    assert_eq!(grok.prelaunch_command.as_deref(), Some("grok-init"));
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
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("test".to_string()),
            value: "sk-test".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: Some(json!({
              "ANTHROPIC_API_KEY": null,
              "FEATURE_FLAG": false,
              "RETRY_COUNT": 5,
              "JSON_VALUE": { "mode": "relaxed" }
            })),
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
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

#[test]
fn project_preview_returns_project_prelaunch_command_and_keeps_it_out_of_env() {
    let fixture = TempDb::new();
    fixture
        .db
        .settings_update(&json!({
          "claudeConfig": {
            "prelaunchCommand": "source .venv/bin/activate",
            "ANTHROPIC_MODEL": "global-model"
          }
        }))
        .unwrap();

    let provider = create_provider(&fixture.db, "Claude Provider", "claude");
    let api_key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("test".to_string()),
            value: "sk-test".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: Some(json!({
              "prelaunchCommand": "direnv allow",
              "ANTHROPIC_MODEL": "key-model"
            })),
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    let project = fixture
        .db
        .project_create(&CreateProjectInput {
            name: "prelaunch project".to_string(),
            path: "/tmp/prelaunch-project".to_string(),
            group_name: None,
            remark: None,
            provider_id: Some(provider.id),
            api_key_id: Some(api_key.id),
            cli_type: Some("claude".to_string()),
            terminal_type: Some("terminal".to_string()),
            prelaunch_command: Some("mise exec -- claude-ready".to_string()),
        })
        .unwrap();

    let preview = get_launch_preview(&fixture.db, Some(&project.id), None, None, "claude").unwrap();

    assert_eq!(
        preview.prelaunch_command.as_deref(),
        Some("mise exec -- claude-ready")
    );
    assert_eq!(preview.env.get("prelaunchCommand"), None);
    assert_eq!(
        preview.env.get("ANTHROPIC_MODEL"),
        Some(&"key-model".to_string())
    );
}

#[test]
fn claude_preview_sets_gateway_discovery_based_on_extra_provider_catalog_models() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Catalog Provider", "claude");
    let api_key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("k".to_string()),
            value: "sk-test".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: Some(json!({
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4.1-flash[1m]",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4.1-flash[1m]",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash[1m]",
                "ANTHROPIC_DEFAULT_FABLE_MODEL": "hy4-flash-free",
            })),
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    // 1) Empty provider catalog → gateway discovery defaults to "0" (prevents stale cache pollution).
    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();
    assert_eq!(
        preview
            .env
            .get("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
        Some(&"0".to_string())
    );

    // 2) Provider catalog whose models are all covered by the 4 tiers → still "0".
    fixture
        .db
        .provider_model_catalog_save(
            &provider.id,
            &[
                cc_use_lib::shared_runtime::model_mapping::ClientModel {
                    id: "deepseek-v4.1-flash".to_string(),
                    display_name: "DeepSeek V4.1 Flash".to_string(),
                    supports1m: true,
                    context_window: None,
                    max_output_tokens: None,
                },
                cc_use_lib::shared_runtime::model_mapping::ClientModel {
                    id: "hy4-flash-free".to_string(),
                    display_name: "Hy4 Flash Free".to_string(),
                    supports1m: false,
                    context_window: None,
                    max_output_tokens: None,
                },
            ],
            0,
        )
        .unwrap();
    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();
    assert_eq!(
        preview
            .env
            .get("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
        Some(&"0".to_string())
    );

    // 3) Provider catalog has an extra model beyond the 4 tiers → enables discovery ("1").
    fixture
        .db
        .provider_model_catalog_save(
            &provider.id,
            &[
                cc_use_lib::shared_runtime::model_mapping::ClientModel {
                    id: "deepseek-v4.1-flash".to_string(),
                    display_name: "DeepSeek V4.1 Flash".to_string(),
                    supports1m: true,
                    context_window: None,
                    max_output_tokens: None,
                },
                cc_use_lib::shared_runtime::model_mapping::ClientModel {
                    id: "hy4-flash-free".to_string(),
                    display_name: "Hy4 Flash Free".to_string(),
                    supports1m: false,
                    context_window: None,
                    max_output_tokens: None,
                },
                cc_use_lib::shared_runtime::model_mapping::ClientModel {
                    id: "glm-5.3".to_string(),
                    display_name: "GLM 5.3".to_string(),
                    supports1m: false,
                    context_window: None,
                    max_output_tokens: None,
                },
            ],
            1,
        )
        .unwrap();
    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();
    assert_eq!(
        preview
            .env
            .get("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
        Some(&"1".to_string())
    );

    // 4) Explicit global/local "0" wins even when extra catalog models exist.
    fixture
        .db
        .settings_update(&json!({
            "claudeConfig": {
                "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "0"
            }
        }))
        .unwrap();
    let preview = get_launch_preview(&fixture.db, None, None, Some(&api_key.id), "claude").unwrap();
    assert_eq!(
        preview
            .env
            .get("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
        Some(&"0".to_string())
    );
}
