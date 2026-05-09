mod support;

use cc_use_lib::models::{CreateProviderInput, UpdateProviderInput};
use support::TempDb;

#[test]
fn provider_crud() {
    let fixture = TempDb::new();

    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Test Provider".to_string(),
            base_url: "https://api.test.com".to_string(),
            provider_type: Some("claude".to_string()),
            website: Some("https://test.com".to_string()),
            remark: None,
            token: Some("test-token".to_string()),
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
        .unwrap();

    assert_eq!(provider.name, "Test Provider");
    assert_eq!(provider.base_url, "https://api.test.com");
    assert!(provider.is_active);

    let providers = fixture.db.provider_list().unwrap();
    assert_eq!(providers.len(), 1);

    let fetched = fixture.db.provider_get(&provider.id).unwrap().unwrap();
    assert_eq!(fetched.name, "Test Provider");

    fixture.db.provider_delete(&provider.id).unwrap();
    let providers = fixture.db.provider_list().unwrap();
    assert_eq!(providers.len(), 0);
}

#[test]
fn provider_create_returns_proper_result() {
    let fixture = TempDb::new();
    let result = fixture.db.provider_create(&CreateProviderInput {
        name: "Test".to_string(),
        base_url: "https://api.test.com".to_string(),
        provider_type: None,
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
    });
    assert!(result.is_ok());
}

#[test]
fn provider_get_nonexistent() {
    let fixture = TempDb::new();
    let result = fixture.db.provider_get("nonexistent-id").unwrap();
    assert!(result.is_none());
}

#[test]
fn provider_get_direct_query() {
    let fixture = TempDb::new();
    for index in 0..5 {
        fixture
            .db
            .provider_create(&CreateProviderInput {
                name: format!("Provider {}", index),
                base_url: format!("https://api{}.test.com", index),
                provider_type: None,
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
            .unwrap();
    }

    let all = fixture.db.provider_list().unwrap();
    assert_eq!(all.len(), 5);

    let target = &all[2];
    let fetched = fixture.db.provider_get(&target.id).unwrap().unwrap();
    assert_eq!(fetched.id, target.id);
    assert_eq!(fetched.name, target.name);
}

#[test]
fn provider_update_no_changes() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Test".to_string(),
            base_url: "https://api.test.com".to_string(),
            provider_type: None,
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
        .unwrap();

    let result = fixture.db.provider_update(&UpdateProviderInput {
        id: provider.id.clone(),
        name: None,
        base_url: None,
        provider_type: None,
        website: None,
        remark: None,
        token: None,
        icon: None,
        wallet_balance_type: None,
        wallet_balance_url: None,
        wallet_balance_path: None,
        wallet_balance_headers: None,
        wallet_balance_user_id: None,
        cached_wallet_balance: None,
        last_balance_checked_at: None,
        usage_type: None,
        usage_url: None,
        usage_path: None,
        usage_headers: None,
        cached_usage: None,
        last_usage_checked_at: None,
        cost_multiplier: None,
        is_active: None,
    });

    assert!(result.is_ok());
    assert_eq!(result.unwrap().name, "Test");
}

#[test]
fn provider_reorder_sequence() {
    let fixture = TempDb::new();

    let p1 = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Alpha".to_string(),
            base_url: "https://alpha.test.com".to_string(),
            provider_type: None,
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
        .unwrap();

    let p2 = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Beta".to_string(),
            base_url: "https://beta.test.com".to_string(),
            provider_type: None,
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
        .unwrap();

    let p3 = fixture
        .db
        .provider_create(&CreateProviderInput {
            name: "Gamma".to_string(),
            base_url: "https://gamma.test.com".to_string(),
            provider_type: None,
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
        .unwrap();

    // Initially ordered by creation (p1 < p2 < p3 by sort_order)
    let all = fixture.db.provider_list().unwrap();
    assert_eq!(all[0].id, p1.id);
    assert_eq!(all[1].id, p2.id);
    assert_eq!(all[2].id, p3.id);

    // Reverse order: p3, p2, p1
    fixture
        .db
        .provider_reorder(&[p3.id.clone(), p2.id.clone(), p1.id.clone()])
        .unwrap();

    let all = fixture.db.provider_list().unwrap();
    assert_eq!(all[0].id, p3.id);
    assert_eq!(all[1].id, p2.id);
    assert_eq!(all[2].id, p1.id);

    // Partial reorder: p1, p3, p2
    fixture
        .db
        .provider_reorder(&[p1.id.clone(), p3.id.clone(), p2.id.clone()])
        .unwrap();

    let all = fixture.db.provider_list().unwrap();
    assert_eq!(all[0].id, p1.id);
    assert_eq!(all[1].id, p3.id);
    assert_eq!(all[2].id, p2.id);
}
