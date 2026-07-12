mod support;

use cc_use_lib::models::{CreateProviderInput, ExportOptions};
use cc_use_lib::services::import_export::export_selected;
use support::{create_api_key, create_provider, TempDb};

#[test]
fn export_excludes_api_key_secrets_by_default() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Secure export".to_string(),
            base_url: "https://example.com".to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: None,
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: Some(r#"{"Authorization":"Bearer wallet-secret"}"#.to_string()),
            wallet_balance_user_id: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: Some(r#"{"Authorization":"Bearer usage-secret"}"#.to_string()),
        })
        .unwrap();
    create_api_key(&fixture.db, &provider.id, "claude_code");

    let export = export_selected(&fixture.db, &ExportOptions::default()).unwrap();

    assert_eq!(export.providers[0].api_keys.len(), 1);
    assert!(export.providers[0].api_keys[0].value.is_empty());
    assert!(export.providers[0].wallet_balance_headers.is_none());
    assert!(export.providers[0].usage_headers.is_none());
}

#[test]
fn export_includes_api_key_secrets_only_when_explicitly_enabled() {
    let fixture = TempDb::new();
    let provider = create_provider(&fixture.db, "Full export", "claude_code");
    create_api_key(&fixture.db, &provider.id, "claude_code");
    let options = ExportOptions {
        include_api_keys: true,
        ..ExportOptions::default()
    };

    let export = export_selected(&fixture.db, &options).unwrap();

    assert_eq!(export.providers[0].api_keys[0].value, "sk-claude_code");
}
