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

    let (stored_value, secret_ref): (String, Option<String>) = fixture
        .db
        .conn
        .query_row(
            "SELECT value, secret_ref FROM api_keys WHERE id = ?1",
            [&key.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(
        stored_value.is_empty(),
        "SQLite must not retain API key plaintext"
    );
    assert!(secret_ref.is_some());

    let keys = fixture.db.api_key_list(&provider.id).unwrap();
    assert_eq!(keys.len(), 1);

    let updated = fixture
        .db
        .api_key_update(&UpdateApiKeyInput {
            id: key.id.clone(),
            value: Some("sk-updated-456".to_string()),
            alias: None,
            types: None,
            priority: None,
            is_exhausted: None,
            is_active: None,
            config: None,
            cached_usage: None,
            last_usage_checked_at: None,
            cost_multiplier: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();
    assert_eq!(updated.value, "sk-updated-456");

    fixture.db.api_key_delete(&key.id).unwrap();
    let keys = fixture.db.api_key_list(&provider.id).unwrap();
    assert_eq!(keys.len(), 0);
}

#[test]
fn legacy_plaintext_is_migrated_out_of_sqlite_on_open() {
    let path = std::env::temp_dir().join(format!(
        "cc-use-keychain-migration-{}.db",
        nanoid::nanoid!(8)
    ));
    let key_id = {
        let db = cc_use_lib::db::Database::open_at(&path).unwrap();
        let provider = create_provider(&db, "Legacy", "claude");
        let key = db
            .api_key_create(&CreateApiKeyInput {
                provider_id: provider.id,
                alias: None,
                value: "temporary".to_string(),
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
        db.conn
            .execute(
                "UPDATE api_keys SET value = 'sk-legacy-plaintext', secret_ref = NULL WHERE id = ?1",
                [&key.id],
            )
            .unwrap();
        key.id
    };

    let reopened = cc_use_lib::db::Database::open_at(&path).unwrap();
    let key = reopened.api_key_get(&key_id).unwrap().unwrap();
    let (stored_value, secret_ref): (String, Option<String>) = reopened
        .conn
        .query_row(
            "SELECT value, secret_ref FROM api_keys WHERE id = ?1",
            [&key_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(key.value, "sk-legacy-plaintext");
    assert!(stored_value.is_empty());
    assert!(secret_ref.is_some());

    drop(reopened);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
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

#[test]
fn api_key_client_configs_round_trip() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Test", "claude");
    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            provider_id: provider.id,
            alias: Some("Company account".to_string()),
            value: "employee-id".to_string(),
            types: Some(vec!["claude_code".to_string()]),
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

    let client_configs = serde_json::json!({
        "claude_code": {
            "baseUrl": "https://gateway.example.com",
            "authScheme": "bearer"
        }
    });
    let updated = fixture
        .db
        .api_key_update(&UpdateApiKeyInput {
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
            client_configs: Some(client_configs.clone()),
        })
        .unwrap();

    assert_eq!(updated.client_configs, Some(client_configs.clone()));
    assert_eq!(
        fixture
            .db
            .api_key_get(&key.id)
            .unwrap()
            .unwrap()
            .client_configs,
        Some(client_configs)
    );
}
