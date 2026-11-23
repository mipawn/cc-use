mod support;

use cc_use_lib::commands::client_profiles::{
    client_profile_create_inner, client_profile_delete_inner, client_profile_list_inner,
    client_profile_reorder_inner, client_profile_update_inner,
};
use cc_use_lib::db::Database;
use cc_use_lib::models::{
    ClientProfileConnectionConfig, CreateClientProfileInput, ManagedInstance, ProxySession,
    UpdateClientProfileInput,
};
use cc_use_lib::shared_runtime::model_mapping;
use serde_json::json;

#[test]
fn client_profile_crud_validation_and_key_rotation() {
    let tmp = support::TempDb::new();
    let db = &tmp.db;

    let p1 = support::create_provider(db, "OpenCode Go", "claude_code");
    let p2 = support::create_provider(db, "Other", "claude_code");
    let k1 = support::create_api_key(db, &p1.id, "claude_code");
    let k2 = support::create_api_key(db, &p1.id, "codex");
    let k_other = support::create_api_key(db, &p2.id, "claude_code");

    // Reject cross-provider binding
    let err = client_profile_create_inner(
        db,
        &CreateClientProfileInput {
            name: "Bad".into(),
            client_kind: "claude_code".into(),
            provider_id: p1.id.clone(),
            api_key_id: k_other.id.clone(),
            model_config: None,
            connection_config: None,
            launch_env: None,
            is_default: None,
        },
    )
    .unwrap_err();
    assert!(err.contains("does not belong"));

    // Reject invalid URL & CR/LF UA
    assert!(client_profile_create_inner(
        db,
        &CreateClientProfileInput {
            name: "BadUrl".into(),
            client_kind: "claude_code".into(),
            provider_id: p1.id.clone(),
            api_key_id: k1.id.clone(),
            model_config: None,
            connection_config: Some(ClientProfileConnectionConfig {
                base_url: Some("ftp://bad".into()),
                auth_scheme: None,
                user_agent: None,
            }),
            launch_env: None,
            is_default: None,
        },
    )
    .is_err());

    assert!(client_profile_create_inner(
        db,
        &CreateClientProfileInput {
            name: "BadUa".into(),
            client_kind: "claude_code".into(),
            provider_id: p1.id.clone(),
            api_key_id: k1.id.clone(),
            model_config: None,
            connection_config: Some(ClientProfileConnectionConfig {
                base_url: None,
                auth_scheme: None,
                user_agent: Some("bad\r\nheader".into()),
            }),
            launch_env: None,
            is_default: None,
        },
    )
    .is_err());

    // Create two distinct Claude Code profiles bound to the SAME key (k1)
    let prof_sonnet = client_profile_create_inner(
        db,
        &CreateClientProfileInput {
            name: "OpenCode - Sonnet".into(),
            client_kind: "claude_code".into(),
            provider_id: p1.id.clone(),
            api_key_id: k1.id.clone(),
            model_config: Some(
                json!({
                    "version": 2,
                    "clients": {
                        "claude_code": {
                            "catalog": { "mode": "provider" },
                            "upstream": { "mode": "follow" }
                        }
                    }
                })
                .to_string(),
            ),
            connection_config: Some(ClientProfileConnectionConfig {
                base_url: Some("https://api.opencode.example/anthropic".into()),
                auth_scheme: Some("bearer".into()),
                user_agent: None,
            }),
            launch_env: Some(json!({ "ANTHROPIC_MODEL": "claude-sonnet-4-6" })),
            is_default: Some(true),
        },
    )
    .unwrap();

    let prof_cheap = client_profile_create_inner(
        db,
        &CreateClientProfileInput {
            name: "OpenCode - DeepSeek".into(),
            client_kind: "claude_code".into(),
            provider_id: p1.id.clone(),
            api_key_id: k1.id.clone(),
            model_config: Some(
                json!({
                    "version": 2,
                    "clients": {
                        "claude_code": {
                            "catalog": { "mode": "provider" },
                            "upstream": { "mode": "fixed", "model": "deepseek-chat" }
                        }
                    }
                })
                .to_string(),
            ),
            connection_config: None,
            launch_env: Some(json!({ "ANTHROPIC_MODEL": "deepseek-chat" })),
            is_default: Some(false),
        },
    )
    .unwrap();

    // Launch previews are completely isolated per profile even on the same key!
    let preview_sonnet = cc_use_lib::terminal::get_launch_preview_with_profile(
        db,
        None,
        Some(&p1.id),
        Some(&k1.id),
        Some(&prof_sonnet.id),
        "claude_code",
    )
    .unwrap();
    let preview_cheap = cc_use_lib::terminal::get_launch_preview_with_profile(
        db,
        None,
        Some(&p1.id),
        Some(&k1.id),
        Some(&prof_cheap.id),
        "claude_code",
    )
    .unwrap();
    assert_eq!(
        preview_sonnet
            .env
            .get("ANTHROPIC_MODEL")
            .map(String::as_str),
        Some("claude-sonnet-4-6")
    );
    assert_eq!(
        preview_cheap.env.get("ANTHROPIC_MODEL").map(String::as_str),
        Some("deepseek-chat")
    );

    // Attach an active session + managed instance to prof_sonnet, then rotate k1 -> k2
    let now = chrono::Utc::now().to_rfc3339();
    let token = "session-profile-rotate-test".to_string();
    db.proxy_session_create(&ProxySession {
        session_token: token.clone(),
        provider_id: p1.id.clone(),
        api_key_id: k1.id.clone(),
        client_profile_id: Some(prof_sonnet.id.clone()),
        project_id: None,
        created_at: now.clone(),
        session_kind: "managed".into(),
        last_seen_at: now.clone(),
        expires_at: None,
        revoked_at: None,
        revoked_reason: None,
        cli_type: Some("claude_code".into()),
        display_name: None,
        is_active: true,
        connection_config: None,
    })
    .unwrap();
    db.managed_instance_create(&ManagedInstance {
        id: "inst-rotate-1".into(),
        session_token: token.clone(),
        project_id: None,
        provider_id: Some(p1.id.clone()),
        api_key_id: Some(k1.id.clone()),
        client_profile_id: Some(prof_sonnet.id.clone()),
        cli_type: "claude_code".into(),
        terminal_type: "cli".into(),
        project_path: "/tmp/demo".into(),
        shell_pid: None,
        process_pid: None,
        status: "running".into(),
        assignment_source: Some("cli_launch".into()),
        last_seen_at: now.clone(),
        launched_at: now,
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
    })
    .unwrap();

    // Rotate bound key from Alice (k1) to Bob (k2) — keeps launch_env, model_config, connection_config!
    let rotated = client_profile_update_inner(
        db,
        &UpdateClientProfileInput {
            id: prof_sonnet.id.clone(),
            name: None,
            provider_id: None,
            api_key_id: Some(k2.id.clone()),
            model_config: None,
            connection_config: None,
            launch_env: None,
            is_default: None,
        },
    )
    .unwrap();
    assert_eq!(rotated.api_key_id, k2.id);
    assert_eq!(rotated.launch_env, prof_sonnet.launch_env);
    assert_eq!(rotated.connection_config, prof_sonnet.connection_config);
    assert_eq!(
        db.proxy_session_get(&token).unwrap().unwrap().api_key_id,
        k2.id
    );
    assert_eq!(
        db.managed_instance_get("inst-rotate-1")
            .unwrap()
            .unwrap()
            .api_key_id
            .as_deref(),
        Some(k2.id.as_str())
    );

    // Reorder profiles
    client_profile_reorder_inner(
        db,
        "claude_code",
        &[prof_cheap.id.clone(), prof_sonnet.id.clone()],
    )
    .unwrap();
    let listed = client_profile_list_inner(db, Some("claude_code")).unwrap();
    assert_eq!(listed[0].id, prof_cheap.id);
    assert_eq!(listed[1].id, prof_sonnet.id);

    // Delete cleans up profile alias table and detaches sessions
    db.settings_set_value(
        &model_mapping::alias_table_key_for_profile(&prof_sonnet.id),
        "{}",
    )
    .unwrap();
    assert!(client_profile_delete_inner(db, &prof_sonnet.id).unwrap());
    assert!(db
        .settings_get_value(&model_mapping::alias_table_key_for_profile(&prof_sonnet.id))
        .unwrap()
        .is_none());
    assert!(db
        .proxy_session_get(&token)
        .unwrap()
        .unwrap()
        .client_profile_id
        .is_none());
}

#[test]
fn lossless_migration_converts_legacy_keys_into_client_profiles_once() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("legacy.db");

    {
        let db = Database::open_at(&db_path).unwrap();
        let p = db
            .provider_create(&cc_use_lib::models::CreateProviderInput {
                name: "DeepSeek".into(),
                base_url: "https://api.deepseek.com".into(),
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
                preset_id: Some("deepseek".into()),
                default_key_config: None,
                request_adapter: None,
                responses_rectifier: None,
            })
            .unwrap();
        let k = db
            .api_key_create(&cc_use_lib::models::CreateApiKeyInput {
                provider_id: p.id.clone(),
                alias: Some("Main".into()),
                value: "sk-legacy".into(),
                types: Some(vec!["claude_code".into(), "codex".into(), "grok".into()]),
                priority: Some(0),
                is_active: Some(true),
                config: Some(json!({ "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]" })),
                usage_type: None,
                usage_url: None,
                usage_path: None,
                usage_headers: None,
                usage_script: None,
                query_config: None,
                model_mapping: Some(
                    json!({
                        "version": 2,
                        "clients": {
                            "claude_code": {
                                "catalog": { "mode": "provider" },
                                "upstream": { "mode": "family", "sonnet": "deepseek-v4-pro" }
                            },
                            "codex": {
                                "catalog": { "mode": "provider", "defaultModel": "deepseek-v4-flash" },
                                "upstream": { "mode": "follow" }
                            }
                        }
                    })
                    .to_string(),
                ),
                client_configs: Some(json!({
                    "claude_code": { "baseUrl": "https://api.deepseek.com/anthropic", "authScheme": "bearer" },
                    "codex": { "baseUrl": "https://api.deepseek.com", "authScheme": "bearer" }
                })),
            })
            .unwrap();

        // Simulate a pre-migration database by clearing the marker and client_profiles.
        db.settings_delete_value("migration.clientProfiles.v1")
            .unwrap();
        db.conn.execute("DELETE FROM client_profiles", []).unwrap();

        // Create a legacy desktop session for codex
        let now = chrono::Utc::now().to_rfc3339();
        db.proxy_session_create(&ProxySession {
            session_token: "session-legacy-codex".into(),
            provider_id: p.id.clone(),
            api_key_id: k.id.clone(),
            client_profile_id: None,
            project_id: None,
            created_at: now.clone(),
            session_kind: "desktop".into(),
            last_seen_at: now,
            expires_at: None,
            revoked_at: None,
            revoked_reason: None,
            cli_type: Some("codex-app".into()),
            display_name: None,
            is_active: true,
            connection_config: None,
        })
        .unwrap();
    }

    // Reopen triggers one-shot migration
    let db = Database::open_at(&db_path).unwrap();
    let profiles = db.client_profile_list(None).unwrap();
    // Official DeepSeek excludes grok → exactly 2 profiles (claude_code + codex)
    assert_eq!(profiles.len(), 2);

    let cc = profiles
        .iter()
        .find(|p| p.client_kind == "claude_code")
        .unwrap();
    assert_eq!(cc.name, "DeepSeek");
    assert_eq!(
        cc.connection_config
            .as_ref()
            .and_then(|c| c.base_url.as_deref()),
        Some("https://api.deepseek.com/anthropic")
    );
    assert_eq!(
        cc.launch_env
            .as_ref()
            .and_then(|v| v.get("ANTHROPIC_MODEL"))
            .and_then(|v| v.as_str()),
        Some("deepseek-v4-pro[1m]")
    );

    let codex = profiles.iter().find(|p| p.client_kind == "codex").unwrap();
    assert_eq!(
        model_mapping::client_default_model(codex.model_config.as_deref(), "codex").as_deref(),
        Some("deepseek-v4-flash")
    );

    // Legacy codex desktop session was backfilled with the migrated codex profile id!
    let sess = db
        .proxy_session_get("session-legacy-codex")
        .unwrap()
        .unwrap();
    assert_eq!(sess.client_profile_id.as_deref(), Some(codex.id.as_str()));

    // Reopening again is idempotent
    drop(db);
    let db2 = Database::open_at(&db_path).unwrap();
    assert_eq!(db2.client_profile_list(None).unwrap().len(), 2);
}
