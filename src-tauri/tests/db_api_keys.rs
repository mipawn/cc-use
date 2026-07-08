mod support;

use cc_use_lib::models::{CreateApiKeyInput, UpdateApiKeyInput};
use support::{create_provider, TempDb};

#[test]
fn api_key_crud() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");

    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("Test Key".to_string()),
            value: "sk-test-123".to_string(),
            types: None,
            priority: Some(0),
            is_active: None,
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    assert_eq!(key.alias, Some("Test Key".to_string()));
    assert_eq!(key.value, "sk-test-123");
    assert!(key.is_active);

    let keys = fixture.db.api_key_list(&provider.id).unwrap();
    assert_eq!(keys.len(), 1);

    fixture.db.api_key_delete(&key.id).unwrap();
    let keys = fixture.db.api_key_list(&provider.id).unwrap();
    assert_eq!(keys.len(), 0);
}

#[test]
fn cascade_delete_removes_api_keys() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");

    fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: None,
            value: "sk-test".to_string(),
            types: None,
            priority: None,
            is_active: None,
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    fixture.db.provider_delete(&provider.id).unwrap();
    let mut statement = fixture
        .db
        .conn
        .prepare("SELECT COUNT(*) FROM api_keys")
        .unwrap();
    let count: i32 = statement.query_row([], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn api_key_create_returns_proper_result() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");
    let result = fixture.db.api_key_create(&CreateApiKeyInput {
        provider_id: provider.id,
        alias: Some("Test".to_string()),
        value: "sk-test-456".to_string(),
        types: None,
        priority: None,
        is_active: None,
        config: None,
        cost_multiplier: None,
        usage_type: None,
        usage_url: None,
        usage_path: None,
        usage_headers: None,
        model_mapping: None,
        client_configs: None,
    });

    assert!(result.is_ok());
}

#[test]
fn api_key_update_no_changes() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");
    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id,
            alias: Some("Test".to_string()),
            value: "sk-test-789".to_string(),
            types: None,
            priority: None,
            is_active: None,
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    let result = fixture.db.api_key_update(&UpdateApiKeyInput {
        id: key.id.clone(),
        alias: None,
        value: None,
        types: None,
        priority: None,
        is_exhausted: None,
        is_active: None,
        config: None,
        cost_multiplier: None,
        usage_type: None,
        usage_url: None,
        usage_path: None,
        usage_headers: None,
        cached_usage: None,
        last_usage_checked_at: None,
        model_mapping: None,
        client_configs: None,
    });

    assert!(result.is_ok());
    assert_eq!(result.unwrap().value, "sk-test-789");
}

#[test]
fn api_key_types_round_trip() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");
    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id.clone(),
            alias: Some("Multi client".to_string()),
            value: "sk-test-types".to_string(),
            types: Some(vec![
                "claude_code".to_string(),
                "codex".to_string(),
                "claude_desktop".to_string(),
            ]),
            priority: None,
            is_active: None,
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    assert_eq!(
        key.types,
        vec![
            "claude_code".to_string(),
            "codex".to_string(),
            "claude_desktop".to_string()
        ]
    );

    let updated = fixture
        .db
        .api_key_update(&UpdateApiKeyInput {
            id: key.id,
            alias: None,
            value: None,
            types: Some(vec!["claude_desktop".to_string()]),
            priority: None,
            is_exhausted: None,
            is_active: None,
            config: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    assert_eq!(updated.types, vec!["claude_desktop".to_string()]);
}
