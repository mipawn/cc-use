use super::*;
use serde_json::json;
use std::cell::Cell;
use std::path::Path;
use tempfile::TempDir;

fn fixture(client: DesktopClientKind) -> (Database, String, String, String) {
    let db = Database::new_in_memory().unwrap();
    let provider = db
        .provider_create(
            &serde_json::from_value(json!({
                "name": "Fixture provider", "baseUrl": "http://127.0.0.1:1"
            }))
            .unwrap(),
        )
        .unwrap();
    let mut keys = Vec::new();
    for alias in ["one", "two"] {
        let key = db.api_key_create(&serde_json::from_value(json!({
            "providerId": provider.id, "value": "synthetic-key-not-a-credential", "alias": alias,
            "types": [client.as_str()], "isActive": true
        })).unwrap()).unwrap();
        keys.push(key.id);
    }
    (db, provider.id, keys[0].clone(), keys[1].clone())
}

struct TestConfig {
    path: PathBuf,
    fail_read: Cell<bool>,
}
impl TestConfig {
    fn new(root: &Path) -> Self {
        Self {
            path: root.join("configuration.json"),
            fail_read: Cell::new(false),
        }
    }
    fn write(&self, token: &str) -> Result<(), String> {
        fs::write(
            &self.path,
            serde_json::to_vec(&json!({"token":token})).unwrap(),
        )
        .map_err(|_| "Fixture write failed.".into())
    }
}
impl DesktopConfigFiles for TestConfig {
    fn files(&self) -> Vec<PathBuf> {
        vec![self.path.clone()]
    }
    fn inspect(&self) -> Result<ConfigFacts, String> {
        if self.fail_read.get() {
            return Err("Fixture state read failed.".into());
        }
        match fs::read_to_string(&self.path) {
            Ok(raw) => {
                let value: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|_| "Invalid fixture configuration.".to_string())?;
                Ok(ConfigFacts {
                    status: DesktopConnectionStatus::TakenOver,
                    token: value["token"].as_str().map(str::to_owned),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFacts {
                status: DesktopConnectionStatus::NotFound,
                token: None,
            }),
            Err(_) => Err("Fixture configuration cannot be read.".into()),
        }
    }
}
fn apply(db: &Database, config: &TestConfig, provider: &str, key: &str) -> DesktopOperationResult {
    apply_with_config(
        db,
        DesktopClientKind::Codex,
        provider,
        key,
        DesktopChangeSource::User,
        config,
        Some(1),
        |token, _| config.write(token),
    )
    .unwrap()
}

#[test]
fn desktop_contract_uses_frozen_names_and_never_serializes_token() {
    let temp = TempDir::new().unwrap();
    let (db, provider, key, _) = fixture(DesktopClientKind::Codex);
    let config = TestConfig::new(temp.path());
    let result = apply(&db, &config, &provider, &key);
    let token = db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .unwrap()
        .unwrap();
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["clientKind"], "codex");
    assert_eq!(value["action"], "takeover");
    assert_eq!(value["completion"], "complete");
    assert_eq!(value["nextAction"], "reopen_client");
    assert_eq!(value["state"]["status"], "taken_over");
    assert_eq!(value["state"]["lastConfigChange"]["source"], "user");
    assert_eq!(value["state"]["route"]["apiKeyId"], key);
    assert!(value["state"]["syncFailure"].is_null());
    assert!(value["warning"].is_null());
    assert!(!value.to_string().contains(&token));
    assert!(!value.to_string().contains("synthetic-key-not-a-credential"));
    assert!(serde_json::from_value::<DesktopClientKind>(json!("claude_code")).is_err());
}

#[test]
fn codex_write_switch_reopen_and_restore_keep_real_configuration_notice() {
    let temp = TempDir::new().unwrap();
    let manager = codex_config::CodexConfigManager::for_test(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
    let catalog = r#"{"models":[{"slug":"fixture-model","display_name":"Fixture"}]}"#;
    let first = codex_config::codex_apply_with_catalog(
        &db,
        &manager,
        &provider,
        &key,
        "fixture-model",
        catalog,
        1,
    )
    .unwrap();
    assert_eq!(first.completion, DesktopCompletion::Complete);
    assert!(first.config_changed);
    let notice = first.state.last_config_change.unwrap();
    let second = codex_config::codex_apply_with_catalog(
        &db,
        &manager,
        &provider,
        &second,
        "fixture-model",
        catalog,
        1,
    )
    .unwrap();
    assert_eq!(second.action, DesktopAction::SwitchRoute);
    assert!(second.route_changed);
    assert!(!second.config_changed);
    assert_eq!(second.next_action, DesktopNextAction::None);
    assert_eq!(second.state.last_config_change.as_ref(), Some(&notice));
    // A new manager represents reopening the GUI: no renderer cache involved.
    let reopened = codex_config::CodexConfigManager::for_test(temp.path());
    assert_eq!(
        read_state(
            &db,
            DesktopClientKind::Codex,
            &reopened,
            DesktopConnectionStatus::Error
        )
        .last_config_change,
        Some(notice)
    );
    let token = db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .unwrap()
        .unwrap();
    let mut foreign_session = db.proxy_session_get(&token).unwrap().unwrap();
    foreign_session.session_token = "session-foreign-client".into();
    foreign_session.cli_type = Some("claude_desktop".into());
    db.proxy_session_create(&foreign_session).unwrap();
    db.settings_set_value(
        CODEX_SESSION_TOKEN_SETTING_KEY,
        &foreign_session.session_token,
    )
    .unwrap();
    let restore = restore_with_config(&db, DesktopClientKind::Codex, &manager, || {
        manager
            .restore(None)
            .map_err(|_| "Cannot restore fixture.".into())
    })
    .unwrap();
    assert_eq!(restore.state.status, DesktopConnectionStatus::Official);
    assert_eq!(
        restore.state.last_config_change.as_ref().unwrap().action,
        DesktopConfigAction::Restore
    );
    assert_eq!(restore.next_action, DesktopNextAction::ReopenClient);
    assert!(restore.state.route.is_none());
    assert!(db
        .proxy_session_get(&foreign_session.session_token)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none());
    assert!(db
        .proxy_session_get(&token)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_some());
    assert_eq!(
        read_state(
            &db,
            DesktopClientKind::Codex,
            &reopened,
            DesktopConnectionStatus::Error
        )
        .last_config_change,
        restore.state.last_config_change
    );
}

#[test]
fn claude_compares_profile_deployment_and_meta_and_sync_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let manager = claude_desktop_config::ClaudeDesktopConfigManager::for_test(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::ClaudeDesktop);
    let first = claude_desktop_config::claude_apply_with_manager(
        &db,
        &provider,
        &key,
        &manager,
        DesktopChangeSource::User,
    )
    .unwrap();
    let notice = first.state.last_config_change.clone().unwrap();
    let switch = claude_desktop_config::claude_apply_with_manager(
        &db,
        &provider,
        &second,
        &manager,
        DesktopChangeSource::User,
    )
    .unwrap();
    assert_eq!(switch.action, DesktopAction::SwitchRoute);
    assert!(!switch.config_changed);
    assert_eq!(switch.state.last_config_change, Some(notice.clone()));
    assert!(!claude_desktop_config::refresh_profile_with_manager(
        &db,
        &manager,
        DesktopChangeSource::Startup
    )
    .unwrap());
    assert_eq!(
        read_record(&db, DesktopClientKind::ClaudeDesktop)
            .unwrap()
            .last_config_change,
        Some(notice)
    );
    let normal = &manager.files()[0];
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(normal).unwrap()).unwrap();
    value["deploymentMode"] = json!("1p");
    fs::write(normal, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(claude_desktop_config::refresh_profile_with_manager(
        &db,
        &manager,
        DesktopChangeSource::Startup
    )
    .unwrap());
    let changed = read_record(&db, DesktopClientKind::ClaudeDesktop)
        .unwrap()
        .last_config_change
        .unwrap();
    assert_eq!(changed.version, 2);
    assert_eq!(changed.source, DesktopChangeSource::Startup);
    assert_eq!(changed.action, DesktopConfigAction::Sync);
    // The applied profile entry also participates in the comparison.
    let meta_path = &manager.files()[3];
    let mut meta: serde_json::Value =
        serde_json::from_slice(&fs::read(meta_path).unwrap()).unwrap();
    meta["entries"][0]["name"] = json!("old label");
    fs::write(meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    assert!(claude_desktop_config::refresh_profile_with_manager(
        &db,
        &manager,
        DesktopChangeSource::KeyEdit
    )
    .unwrap());
    assert_eq!(
        read_record(&db, DesktopClientKind::ClaudeDesktop)
            .unwrap()
            .last_config_change
            .unwrap()
            .version,
        3
    );
    assert!(!claude_desktop_config::refresh_profile_with_manager(
        &db,
        &manager,
        DesktopChangeSource::Startup
    )
    .unwrap());
}

#[test]
fn file_failure_rolls_back_session_and_files_and_does_not_claim_success() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
    let first = apply(&db, &config, &provider, &key);
    let before = fs::read(&config.path).unwrap();
    let failure = apply_with_config(
        &db,
        DesktopClientKind::Codex,
        &provider,
        &second,
        DesktopChangeSource::User,
        &config,
        None,
        |_, _| {
            fs::write(&config.path, b"partial fixture write").unwrap();
            Err("Cannot write fixture catalog.".into())
        },
    )
    .unwrap_err();
    assert!(failure.contains("Previous files and route were restored"));
    assert_eq!(fs::read(&config.path).unwrap(), before);
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &config,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.route.unwrap().api_key_id, key);
    assert_eq!(state.last_config_change, first.state.last_config_change);
    assert!(state.sync_failure.is_some());
}

#[test]
fn rollback_failure_returns_partial_and_reads_actual_state_not_the_old_route() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
    apply(&db, &config, &provider, &key);
    let result = apply_with_config(
        &db,
        DesktopClientKind::Codex,
        &provider,
        &second,
        DesktopChangeSource::User,
        &config,
        None,
        |_, _| {
            // The known temp fixture path becomes a directory, preventing restoration.
            assert!(config.path.starts_with(temp.path()));
            fs::remove_file(&config.path).unwrap();
            fs::create_dir(&config.path).unwrap();
            Err("Fixture write failed.".into())
        },
    )
    .unwrap();
    assert_eq!(result.completion, DesktopCompletion::Partial);
    assert_eq!(result.state.status, DesktopConnectionStatus::Unknown);
    assert!(result.state.route.is_none());
    assert!(result.warning.unwrap().contains("rollback was incomplete"));
    let token = db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .unwrap()
        .unwrap();
    assert_eq!(
        db.proxy_session_get(&token).unwrap().unwrap().api_key_id,
        key
    );
}

#[test]
fn successful_write_with_failed_readback_is_partial_unknown() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, _) = fixture(DesktopClientKind::Codex);
    let result = apply_with_config(
        &db,
        DesktopClientKind::Codex,
        &provider,
        &key,
        DesktopChangeSource::User,
        &config,
        None,
        |token, _| {
            config.write(token)?;
            config.fail_read.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(result.completion, DesktopCompletion::Partial);
    assert_eq!(result.state.status, DesktopConnectionStatus::Unknown);
    assert!(result.state.route.is_none());
    assert!(result.config_changed);
    assert!(result.state.last_config_change.is_some());
    config.fail_read.set(false);
    assert_eq!(
        read_state(
            &db,
            DesktopClientKind::Codex,
            &config,
            DesktopConnectionStatus::Error
        )
        .route
        .unwrap()
        .api_key_id,
        key
    );
}

#[test]
fn metadata_write_failure_rolls_back_and_redacts_database_errors() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
    let original = apply(&db, &config, &provider, &key);
    db.conn.execute_batch("CREATE TRIGGER fail_desktop_notice BEFORE INSERT ON settings WHEN NEW.key LIKE 'desktop.connection.%' BEGIN SELECT RAISE(FAIL, 'synthetic-private-value'); END;").unwrap();
    let error = apply_with_config(
        &db,
        DesktopClientKind::Codex,
        &provider,
        &second,
        DesktopChangeSource::User,
        &config,
        None,
        |token, _| config.write(token),
    )
    .unwrap_err();
    assert!(!error.contains("synthetic-private-value"));
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &config,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.route, original.state.route);
    assert_eq!(state.last_config_change, original.state.last_config_change);
}

#[test]
fn malformed_configuration_is_error_not_official_and_does_not_leak_contents() {
    let temp = TempDir::new().unwrap();
    let manager = codex_config::CodexConfigManager::for_test(temp.path());
    fs::create_dir_all(temp.path().join("codex")).unwrap();
    fs::write(
        temp.path().join("codex/config.toml"),
        "token = 'private-session-value\n",
    )
    .unwrap();
    let (db, _, _, _) = fixture(DesktopClientKind::Codex);
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &manager,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.status, DesktopConnectionStatus::Error);
    assert!(!serde_json::to_string(&state)
        .unwrap()
        .contains("private-session-value"));
    let claude = claude_desktop_config::ClaudeDesktopConfigManager::for_test(temp.path());
    let path = &claude.files()[0];
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "not-json-private-value").unwrap();
    assert_eq!(
        read_state(
            &db,
            DesktopClientKind::ClaudeDesktop,
            &claude,
            DesktopConnectionStatus::Error
        )
        .status,
        DesktopConnectionStatus::Error
    );
}

#[test]
fn wrong_client_disabled_and_exhausted_routes_fail_before_mutation() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, _) = fixture(DesktopClientKind::Codex);
    assert!(apply_with_config(
        &db,
        DesktopClientKind::ClaudeDesktop,
        &provider,
        &key,
        DesktopChangeSource::User,
        &config,
        None,
        |_, _| panic!("must not mutate")
    )
    .is_err());
    db.conn
        .execute("UPDATE api_keys SET is_exhausted = 1 WHERE id = ?1", [&key])
        .unwrap();
    assert!(validate_route(&db, DesktopClientKind::Codex, &provider, &key).is_err());
    db.conn
        .execute(
            "UPDATE api_keys SET is_exhausted = 0, is_active = 0 WHERE id = ?1",
            [&key],
        )
        .unwrap();
    assert!(validate_route(&db, DesktopClientKind::Codex, &provider, &key).is_err());
    assert!(!config.path.exists());
    assert!(db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .unwrap()
        .is_none());
}

#[test]
fn saved_key_survives_profile_sync_failure_with_persistent_key_edit_notice() {
    let temp = TempDir::new().unwrap();
    let manager = claude_desktop_config::ClaudeDesktopConfigManager::for_test(temp.path());
    let (db, provider, key, _) = fixture(DesktopClientKind::ClaudeDesktop);
    let first = claude_desktop_config::claude_apply_with_manager(
        &db,
        &provider,
        &key,
        &manager,
        DesktopChangeSource::User,
    )
    .unwrap();
    let notice = first.state.last_config_change.clone();
    // Invalid JSON is a deterministic file failure without permissions or real paths.
    fs::write(&manager.files()[3], "invalid-fixture-meta").unwrap();
    let input =
        serde_json::from_value(json!({"id": key, "alias": "saved despite sync failure"})).unwrap();
    let saved = crate::commands::api_keys::update_key_with_desktop_sync(&db, &input, || {
        claude_desktop_config::refresh_profile_with_manager(
            &db,
            &manager,
            DesktopChangeSource::KeyEdit,
        )
    })
    .unwrap();
    assert_eq!(saved.alias.as_deref(), Some("saved despite sync failure"));
    assert_eq!(db.api_key_get(&key).unwrap().unwrap().alias, saved.alias);
    let reopened = claude_desktop_config::ClaudeDesktopConfigManager::for_test(temp.path());
    let state = read_state(
        &db,
        DesktopClientKind::ClaudeDesktop,
        &reopened,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.status, DesktopConnectionStatus::Error);
    assert_eq!(state.last_config_change, notice);
    assert_eq!(
        state.sync_failure.unwrap().source,
        DesktopChangeSource::KeyEdit
    );
}

#[test]
fn restore_failure_rolls_back_files_and_keeps_the_live_route() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, _) = fixture(DesktopClientKind::Codex);
    let original = apply(&db, &config, &provider, &key);
    let original_bytes = fs::read(&config.path).unwrap();
    let result = restore_with_config(&db, DesktopClientKind::Codex, &config, || {
        fs::write(&config.path, b"partly restored").unwrap();
        Err("Fixture restore failure.".into())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&config.path).unwrap(), original_bytes);
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &config,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.route, original.state.route);
    assert_eq!(state.last_config_change, original.state.last_config_change);
    let token = db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .unwrap()
        .unwrap();
    assert!(db
        .proxy_session_get(&token)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none());
}

#[test]
fn state_follows_token_in_configuration_not_the_last_selected_setting() {
    let temp = TempDir::new().unwrap();
    let config = TestConfig::new(temp.path());
    let (db, provider, key, _) = fixture(DesktopClientKind::Codex);
    apply(&db, &config, &provider, &key);
    db.settings_set_value(CODEX_SESSION_TOKEN_SETTING_KEY, "session-unrelated-setting")
        .unwrap();
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &config,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.status, DesktopConnectionStatus::TakenOver);
    assert_eq!(state.route.unwrap().api_key_id, key);
    let before = fs::read(&config.path).unwrap();
    let switched = apply(&db, &config, &provider, &key);
    assert!(!switched.config_changed);
    assert_eq!(fs::read(&config.path).unwrap(), before);
    config.write("session-missing-fixture").unwrap();
    let missing = read_state(
        &db,
        DesktopClientKind::Codex,
        &config,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(missing.status, DesktopConnectionStatus::Unknown);
    assert!(missing.route.is_none());
    assert!(missing.warning.is_some());
}

#[test]
fn codex_real_atomic_write_failure_restores_catalog_and_session_together() {
    let temp = TempDir::new().unwrap();
    let manager = codex_config::CodexConfigManager::for_test(temp.path());
    let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
    let catalog = r#"{"models":[{"slug":"fixture-model","display_name":"Fixture"}]}"#;
    let first = codex_config::codex_apply_with_catalog(
        &db,
        &manager,
        &provider,
        &key,
        "fixture-model",
        catalog,
        1,
    )
    .unwrap();
    let before: Vec<_> = manager
        .files()
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect();
    // This is the manager's temporary *fixture* write path, not a user file.
    fs::create_dir(temp.path().join("codex/config.cc-use.tmp")).unwrap();
    let changed_catalog =
        r#"{"models":[{"slug":"fixture-model","display_name":"Updated fixture"}]}"#;
    let result = codex_config::codex_apply_with_catalog(
        &db,
        &manager,
        &provider,
        &second,
        "fixture-model",
        changed_catalog,
        1,
    );
    assert!(result
        .unwrap_err()
        .contains("Previous files and route were restored"));
    let after: Vec<_> = manager
        .files()
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect();
    assert_eq!(before, after);
    let state = read_state(
        &db,
        DesktopClientKind::Codex,
        &manager,
        DesktopConnectionStatus::Error,
    );
    assert_eq!(state.route, first.state.route);
    assert_eq!(state.last_config_change, first.state.last_config_change);
}

#[test]
fn codex_reapplies_drifted_provider_protocol_and_other_owned_fields() {
    for drift in [
        "model_provider",
        "wire_api",
        "name",
        "disable_response_storage",
    ] {
        let temp = TempDir::new().unwrap();
        let manager = codex_config::CodexConfigManager::for_test(temp.path());
        let (db, provider, key, second) = fixture(DesktopClientKind::Codex);
        let catalog = r#"{"models":[{"slug":"fixture-model","display_name":"Fixture"}]}"#;
        codex_config::codex_apply_with_catalog(
            &db,
            &manager,
            &provider,
            &key,
            "fixture-model",
            catalog,
            1,
        )
        .unwrap();
        let path = &manager.files()[0];
        let mut document: toml_edit::DocumentMut =
            fs::read_to_string(path).unwrap().parse().unwrap();
        match drift {
            "model_provider" => document["model_provider"] = toml_edit::value("openai"),
            "wire_api" => {
                document["model_providers"]["cc-use"]["wire_api"] = toml_edit::value("chat")
            }
            "name" => {
                document["model_providers"]["cc-use"]["name"] =
                    toml_edit::value("old fixture label")
            }
            "disable_response_storage" => {
                document["disable_response_storage"] = toml_edit::value(false)
            }
            _ => unreachable!(),
        }
        fs::write(path, document.to_string()).unwrap();
        if drift == "model_provider" {
            assert_eq!(
                read_state(
                    &db,
                    DesktopClientKind::Codex,
                    &manager,
                    DesktopConnectionStatus::Error
                )
                .status,
                DesktopConnectionStatus::Official
            );
        }
        let result = codex_config::codex_apply_with_catalog(
            &db,
            &manager,
            &provider,
            &second,
            "fixture-model",
            catalog,
            1,
        )
        .unwrap();
        assert!(result.config_changed, "owned-field drift: {drift}");
        assert_eq!(result.action, DesktopAction::Takeover);
        assert_eq!(result.completion, DesktopCompletion::Complete);
        assert_eq!(result.next_action, DesktopNextAction::ReopenClient);
        assert_eq!(result.state.status, DesktopConnectionStatus::TakenOver);
        assert_eq!(result.state.route.as_ref().unwrap().api_key_id, second);
        assert_eq!(result.state.last_config_change.as_ref().unwrap().version, 2);
        let no_op = codex_config::codex_apply_with_catalog(
            &db,
            &manager,
            &provider,
            &second,
            "fixture-model",
            catalog,
            1,
        )
        .unwrap();
        assert!(!no_op.config_changed);
        assert_eq!(
            no_op.state.last_config_change,
            result.state.last_config_change
        );
    }
}
