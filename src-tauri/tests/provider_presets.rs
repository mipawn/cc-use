//! Provider presets and the key defaults they carry (v3.10.0).

mod support;

use cc_use_lib::models::{
    CreateApiKeyInput, CreateProviderInput, ExportOptions, Provider, UpdateProviderInput,
};
use cc_use_lib::services::import_export::{export_selected, import_all, validate};
use cc_use_lib::shared_runtime::{
    parse_default_key_config, provider_preset, serialize_default_key_config, DefaultKeyConfig,
    PRESET_DEEPSEEK, PRESET_NEWAPI, PRESET_OPENCODE_GO,
};
use support::TempDb;

/// Every optional field is `None`, which for an update means "leave it alone".
fn provider_patch(id: &str) -> UpdateProviderInput {
    UpdateProviderInput {
        id: id.to_string(),
        name: None,
        base_url: None,
        http_proxy: None,
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
        is_active: None,
        cached_wallet_balance: None,
        cached_wallet_balance_currency: None,
        last_balance_checked_at: None,
        cached_usage: None,
        last_usage_checked_at: None,
        preset_id: None,
        default_key_config: None,
    }
}

fn provider_input(name: &str) -> CreateProviderInput {
    CreateProviderInput {
        name: name.to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        http_proxy: None,
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
        preset_id: None,
        default_key_config: None,
    }
}

/// A provider created from the DeepSeek template keeps every default the
/// template supplied, including the ones a first-run form never shows.
#[test]
fn creating_from_a_preset_stores_the_complete_template() {
    let fixture = TempDb::new();
    let preset = provider_preset(PRESET_DEEPSEEK).expect("deepseek preset");

    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            base_url: preset.base_url.clone(),
            wallet_balance_type: Some(preset.wallet_balance_type.clone()),
            wallet_balance_url: preset.wallet_balance_url.clone(),
            usage_type: Some(preset.usage_type.clone()),
            preset_id: Some(preset.id.clone()),
            default_key_config: Some(preset.default_key_config.clone()),
            ..provider_input("deepseek")
        })
        .unwrap();

    let stored = fixture.db.provider_get(&provider.id).unwrap().unwrap();
    assert_eq!(stored.preset_id, PRESET_DEEPSEEK);
    let defaults = stored.default_key_config.expect("key defaults persisted");
    assert_eq!(defaults, preset.default_key_config);
    assert_eq!(defaults.types.len(), 3);
    assert!(defaults.model_mapping.is_some());
    // Nothing in the defaults is an inference credential.
    assert!(!serde_json::to_string(&defaults).unwrap().contains("sk-"));
}

/// A provider created by hand records `custom` rather than inheriting whatever
/// preset happened to be selected last.
#[test]
fn a_hand_made_provider_defaults_to_the_custom_origin() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("plain"))
        .unwrap();

    assert_eq!(provider.preset_id, "custom");
    assert!(provider.default_key_config.is_none());
}

/// The origin label says where an account started; it must not rewrite the
/// endpoints the user saved, and an endpoint change must not be silently
/// reverted to a template.
#[test]
fn editing_an_address_never_reverts_to_the_preset() {
    let fixture = TempDb::new();
    let preset = provider_preset(PRESET_NEWAPI).expect("newapi preset");
    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            base_url: "https://my-gateway.example.com/gateway".to_string(),
            preset_id: Some(preset.id.clone()),
            ..provider_input("gateway")
        })
        .unwrap();

    let updated = fixture
        .db
        .provider_update(&UpdateProviderInput {
            base_url: Some("https://other.example.com/v1".to_string()),
            ..provider_patch(&provider.id)
        })
        .unwrap();

    assert_eq!(updated.base_url, "https://other.example.com/v1");
    assert_eq!(updated.preset_id, PRESET_NEWAPI, "origin is not rewritten");
}

/// Replacing the stored defaults affects future keys only; clearing them is
/// explicit and sticks.
#[test]
fn key_defaults_can_be_replaced_and_cleared() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            default_key_config: Some(DefaultKeyConfig {
                types: vec!["claude_code".to_string()],
                ..DefaultKeyConfig::default()
            }),
            ..provider_input("defaults")
        })
        .unwrap();

    let replacement = DefaultKeyConfig {
        types: vec!["codex".to_string()],
        usage_type: Some("custom".to_string()),
        ..DefaultKeyConfig::default()
    };
    let updated = fixture
        .db
        .provider_update(&UpdateProviderInput {
            default_key_config: Some(replacement.clone()),
            ..provider_patch(&provider.id)
        })
        .unwrap();
    assert_eq!(updated.default_key_config, Some(replacement));

    let cleared = fixture
        .db
        .provider_update(&UpdateProviderInput {
            default_key_config: Some(DefaultKeyConfig::default()),
            ..provider_patch(&provider.id)
        })
        .unwrap();
    assert_eq!(
        cleared.default_key_config,
        Some(DefaultKeyConfig::default())
    );
}

/// Export and import carry the origin and the key defaults, and an old file
/// without them still imports.
#[test]
fn export_and_import_round_trip_preset_data() {
    let source = TempDb::new();
    let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");
    let provider = source
        .db
        .provider_create(&CreateProviderInput {
            base_url: preset.base_url.clone(),
            usage_type: Some(preset.usage_type.clone()),
            preset_id: Some(preset.id.clone()),
            default_key_config: Some(preset.default_key_config.clone()),
            ..provider_input("go")
        })
        .unwrap();
    source
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("main".to_string()),
            value: "sk-exported".to_string(),
            types: Some(vec!["claude_code".to_string()]),
            priority: None,
            is_active: None,
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: Some(r#"{"haiku":"exported-model"}"#.to_string()),
            client_configs: Some(serde_json::json!({
                "claude_code": { "baseUrl": "https://exported.example.com", "authScheme": "bearer" }
            })),
        })
        .unwrap();

    let export = export_selected(&source.db, &ExportOptions::default()).unwrap();
    assert_eq!(
        export.providers[0].preset_id.as_deref(),
        Some(PRESET_OPENCODE_GO)
    );
    assert!(export.providers[0].default_key_config.is_some());
    // The configuration half of a key survives; its secret does not, by default.
    assert!(export.providers[0].api_keys[0].value.is_empty());
    assert_eq!(
        export.providers[0].api_keys[0].model_mapping.as_deref(),
        Some(r#"{"haiku":"exported-model"}"#)
    );
    assert!(export.providers[0].api_keys[0].client_configs.is_some());

    let target = TempDb::new();
    let result = import_all(
        &target.db,
        &export,
        &cc_use_lib::models::ImportOptions { overwrite: false },
    )
    .unwrap();
    assert!(
        result.errors.is_empty(),
        "import errors: {:?}",
        result.errors
    );

    let restored = target.db.provider_list().unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].preset_id, PRESET_OPENCODE_GO);
    assert_eq!(
        restored[0].default_key_config,
        Some(preset.default_key_config)
    );
}

/// A file written before v3.10.0 has neither field, and must still import.
#[test]
fn an_older_export_without_preset_fields_still_imports() {
    let payload = serde_json::json!({
        "version": "3.9.0",
        "exportedAt": "2026-09-01T00:00:00Z",
        "providers": [{
            "id": "legacy-provider",
            "name": "Legacy",
            "type": "custom",
            "baseUrl": "https://legacy.example.com"
        }],
        "usageLogs": [],
        "requestLogs": []
    });
    assert!(validate(&payload));

    let data: cc_use_lib::models::ExportData = serde_json::from_value(payload).unwrap();
    let target = TempDb::new();
    let result = import_all(
        &target.db,
        &data,
        &cc_use_lib::models::ImportOptions { overwrite: false },
    )
    .unwrap();

    assert!(
        result.errors.is_empty(),
        "importing an older file must not fail: {:?}",
        result.errors
    );
    let providers = target.db.provider_list().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].preset_id, "custom");
    assert!(providers[0].default_key_config.is_none());
}

/// A preset id this build does not know is kept as origin information instead
/// of being rewritten or rejected.
#[test]
fn an_unknown_preset_id_is_preserved() {
    let fixture = TempDb::new();
    let provider: Provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            preset_id: Some("from-a-newer-build".to_string()),
            ..provider_input("future")
        })
        .unwrap();

    assert_eq!(provider.preset_id, "from-a-newer-build");
    assert!(provider_preset(&provider.preset_id).is_none());
}

#[test]
fn stored_key_defaults_that_are_unreadable_do_not_become_a_guess() {
    assert!(parse_default_key_config(Some("{ not json")).is_none());
    let config = DefaultKeyConfig {
        types: vec!["claude_code".to_string()],
        ..DefaultKeyConfig::default()
    };
    let raw = serialize_default_key_config(&config).expect("serialize");
    assert_eq!(parse_default_key_config(Some(&raw)), Some(config));
}
