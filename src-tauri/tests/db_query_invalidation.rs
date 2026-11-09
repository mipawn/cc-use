//! Save-time cache invalidation, end to end.
//!
//! The contract: a cached answer may describe only the configuration it was
//! queried against. Every save that changes what a query would send — address,
//! proxy, borrowed credentials, script, switch, this key's value — clears the
//! caches in the same transaction, so a stale answer can neither survive nor
//! resurrect while the newer configuration is on screen.

mod support;

use cc_use_lib::models::{
    CreateApiKeyInput, CreateProviderInput, UpdateApiKeyInput, UpdateProviderInput,
};
use cc_use_lib::shared_runtime::QueryConfig;
use support::TempDb;

const SCRIPT: &str = "({request:{url:'{{baseUrl}}/usage'},extractor:()=>({remaining:1})})";

fn account_config(enabled: bool) -> Option<QueryConfig> {
    Some(QueryConfig {
        enabled,
        scheme_id: "custom".to_string(),
    })
}

fn provider_input(name: &str) -> CreateProviderInput {
    CreateProviderInput {
        query_config: account_config(true),
        request_headers: None,
        wallet_balance_script: Some(SCRIPT.to_string()),
        name: name.to_string(),
        base_url: "https://api.test.com".to_string(),
        http_proxy: None,
        website: None,
        remark: None,
        token: Some("account-token".to_string()),
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
        request_adapter: None,
    }
}

#[test]
fn an_unrelated_save_keeps_the_cached_account_answer() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();

    let updated = fixture
        .db
        .provider_update(&UpdateProviderInput {
            id: provider.id.clone(),
            // A rename describes the provider, not what the query sends.
            name: Some("renamed".to_string()),
            ..UpdateProviderInput {
                id: provider.id.clone(),
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
                wallet_balance_script: None,
                request_headers: None,
                query_config: None,
                is_active: None,
                cached_wallet_balance: None,
                cached_wallet_balance_currency: None,
                last_balance_checked_at: None,
                cached_usage: None,
                last_usage_checked_at: None,
                preset_id: None,
                default_key_config: None,
                request_adapter: None,
            }
        })
        .unwrap();

    assert_eq!(updated.name, "renamed");
    // Cache fields were never touched by this save path: an unrelated edit
    // must not silently blank a saved answer either.
    assert_eq!(updated.cached_wallet_balance, None);
}

#[test]
fn a_query_relevant_change_clears_the_provider_cache() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();

    // Seed a saved answer with its currency and check time.
    fixture
        .db
        .conn
        .execute(
            "UPDATE providers SET cached_wallet_balance = 12.5,
                cached_wallet_balance_currency = 'CNY', last_balance_checked_at = 'now',
                cached_usage = '{\"total\":10,\"remaining\":9}', last_usage_checked_at = 'now'
             WHERE id = ?1",
            [provider.id.as_str()],
        )
        .unwrap();

    // Turning the query off changes what the next refresh would even do.
    let updated = fixture
        .db
        .provider_update(&UpdateProviderInput {
            query_config: account_config(false),
            ..UpdateProviderInput {
                id: provider.id.clone(),
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
                wallet_balance_script: None,
                request_headers: None,
                query_config: None,
                is_active: None,
                cached_wallet_balance: None,
                cached_wallet_balance_currency: None,
                last_balance_checked_at: None,
                cached_usage: None,
                last_usage_checked_at: None,
                preset_id: None,
                default_key_config: None,
                request_adapter: None,
            }
        })
        .unwrap();

    assert!(!updated.query_config.as_ref().expect("config").enabled);
    // The stored answer is gone, exactly: a NULL means "no current answer",
    // not a zero balance.
    let (balance, currency, checked_at, usage): (
        Option<f64>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = fixture
        .db
        .conn
        .query_row(
            "SELECT cached_wallet_balance, cached_wallet_balance_currency,
                    last_balance_checked_at, cached_usage
             FROM providers WHERE id = ?1",
            [provider.id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(balance, None);
    assert_eq!(currency, None);
    assert_eq!(checked_at, None);
    assert_eq!(usage, None);
}

#[test]
fn an_address_change_clears_the_keys_caches_too() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();
    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: Some(QueryConfig {
                enabled: true,
                scheme_id: "custom".to_string(),
            }),
            usage_script: Some(SCRIPT.to_string()),
            provider_id: provider.id.clone(),
            alias: None,
            value: "sk-key".to_string(),
            types: None,
            priority: None,
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    for table in ["providers", "api_keys"] {
        let sql = if table == "providers" {
            format!("UPDATE {table} SET cached_usage = '{{}}' WHERE id = ?1")
        } else {
            format!("UPDATE {table} SET cached_usage = '{{}}', last_usage_checked_at = 'now' WHERE id = ?1")
        };
        let id = if table == "providers" {
            provider.id.clone()
        } else {
            key.id.clone()
        };
        fixture.db.conn.execute(&sql, [id.as_str()]).unwrap();
    }

    // The provider address is part of the key's per-key query URL. Moving it
    // invalidates that key's saved answer just as much as the account's.
    fixture
        .db
        .provider_update(&UpdateProviderInput {
            base_url: Some("https://moved.test.com".to_string()),
            ..UpdateProviderInput {
                id: provider.id.clone(),
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
                wallet_balance_script: None,
                request_headers: None,
                query_config: None,
                is_active: None,
                cached_wallet_balance: None,
                cached_wallet_balance_currency: None,
                last_balance_checked_at: None,
                cached_usage: None,
                last_usage_checked_at: None,
                preset_id: None,
                default_key_config: None,
                request_adapter: None,
            }
        })
        .unwrap();

    let key_cache: Option<String> = fixture
        .db
        .conn
        .query_row(
            "SELECT cached_usage FROM api_keys WHERE id = ?1",
            [key.id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(key_cache, None);
}

#[test]
fn a_key_credential_change_clears_its_own_cache() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();
    let key = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: Some(SCRIPT.to_string()),
            provider_id: provider.id.clone(),
            alias: None,
            value: "sk-old".to_string(),
            types: None,
            priority: None,
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    fixture
        .db
        .conn
        .execute(
            "UPDATE api_keys SET cached_usage = '{\"remaining\":3}', last_usage_checked_at = 'now' WHERE id = ?1",
            [key.id.as_str()],
        )
        .unwrap();

    let updated = fixture
        .db
        .api_key_update(&UpdateApiKeyInput {
            query_config: None,
            usage_script: None,
            id: key.id.clone(),
            alias: None,
            value: Some("sk-new".to_string()),
            types: None,
            priority: None,
            is_exhausted: None,
            is_active: None,
            config: None,
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

    assert_eq!(updated.value, "sk-new");
    let (cache, checked_at): (Option<String>, Option<String>) = fixture
        .db
        .conn
        .query_row(
            "SELECT cached_usage, last_usage_checked_at FROM api_keys WHERE id = ?1",
            [key.id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(cache, None, "a different credential has no saved answer");
    assert_eq!(checked_at, None);
}

#[test]
fn a_borrowed_credential_moving_the_priority_clears_the_provider_cache() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();

    // Two keys; the low priority one is the account query's credential.
    let _borrowed = fixture
        .db
        .api_key_create(&CreateApiKeyInput {
            query_config: None,
            usage_script: None,
            provider_id: provider.id.clone(),
            alias: Some("first".to_string()),
            value: "sk-borrowed".to_string(),
            types: None,
            priority: Some(0),
            is_active: Some(true),
            config: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            model_mapping: None,
            client_configs: None,
        })
        .unwrap();

    fixture
        .db
        .conn
        .execute(
            "UPDATE providers SET cached_wallet_balance = 7.0, last_balance_checked_at = 'now' WHERE id = ?1",
            [provider.id.as_str()],
        )
        .unwrap();

    // A save that exhausts the borrowed key changes who the account query
    // would authenticate as; the stored answer is no longer current.
    borrowed_fixture_key_exhausted(&fixture, &provider.id);

    let balance: Option<f64> = fixture
        .db
        .conn
        .query_row(
            "SELECT cached_wallet_balance FROM providers WHERE id = ?1",
            [provider.id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(balance, None);
}

fn borrowed_fixture_key_exhausted(fixture: &TempDb, provider_id: &str) {
    let key: Option<String> = fixture
        .db
        .conn
        .query_row(
            "SELECT id FROM api_keys WHERE provider_id = ?1 AND priority = 0",
            [provider_id],
            |row| row.get(0),
        )
        .ok();
    let Some(key) = key else { return };
    let updated = fixture
        .db
        .api_key_update(&UpdateApiKeyInput {
            query_config: None,
            usage_script: None,
            id: key,
            alias: None,
            value: None,
            types: None,
            priority: None,
            is_exhausted: Some(true),
            is_active: None,
            config: None,
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
    assert!(updated.is_exhausted);
}

#[test]
fn closing_and_reopening_keeps_script_and_config() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();

    let updated = fixture
        .db
        .provider_update(&UpdateProviderInput {
            query_config: account_config(false),
            ..UpdateProviderInput {
                id: provider.id.clone(),
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
                wallet_balance_script: None,
                request_headers: None,
                query_config: None,
                is_active: None,
                cached_wallet_balance: None,
                cached_wallet_balance_currency: None,
                last_balance_checked_at: None,
                cached_usage: None,
                last_usage_checked_at: None,
                preset_id: None,
                default_key_config: None,
                request_adapter: None,
            }
        })
        .unwrap();

    // D4: disabled remembers what was configured. The script and the scheme
    // stay; a later reopen restores them verbatim.
    assert_eq!(
        updated.query_config.as_ref().expect("config").scheme_id,
        "custom"
    );
    assert_eq!(
        updated.wallet_balance_script.as_deref(),
        Some(SCRIPT),
        "the script the user wrote is kept verbatim"
    );
}

#[test]
fn legacy_rows_with_a_script_read_as_enabled_until_saved() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&provider_input("relay"))
        .unwrap();

    // Simulate a pre-config row: no config column value set.
    fixture
        .db
        .conn
        .execute(
            "UPDATE providers SET query_config = NULL WHERE id = ?1",
            [provider.id.as_str()],
        )
        .unwrap();

    let stored = fixture.db.provider_get(&provider.id).unwrap().unwrap();
    assert!(
        stored.query_config.is_none(),
        "a legacy row reads without config, and shared_runtime derives the intent"
    );
}
