//! Desktop control-plane facts and atomic file/session coordination.
//! No state here claims that an external client has reloaded its configuration.
use super::{claude_desktop_config, codex_config};
use crate::db::Database;
use crate::models::{ApiKey, Provider, ProxySession};
use crate::shared_runtime::session_token::{
    new_session_token, CODEX_SESSION_TOKEN_SETTING_KEY, SESSION_TOKEN_PREFIX,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopClientKind {
    Codex,
    ClaudeDesktop,
}
impl DesktopClientKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeDesktop => "claude_desktop",
        }
    }
    fn session_key(self) -> &'static str {
        match self {
            Self::Codex => CODEX_SESSION_TOKEN_SETTING_KEY,
            Self::ClaudeDesktop => claude_desktop_config::GATEWAY_TOKEN_SETTING_KEY,
        }
    }
    fn cli_type(self) -> &'static str {
        match self {
            Self::Codex => "codex-app",
            Self::ClaudeDesktop => "claude_desktop",
        }
    }
    fn record_key(self) -> String {
        format!("desktop.connection.{}.v1", self.as_str())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopChangeSource {
    User,
    KeyEdit,
    Startup,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopConnectionStatus {
    Official,
    TakenOver,
    NotFound,
    Error,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopAction {
    Takeover,
    SwitchRoute,
    Restore,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopConfigAction {
    Takeover,
    Restore,
    Sync,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopCompletion {
    Complete,
    Partial,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopNextAction {
    ReopenClient,
    None,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRoute {
    pub provider_id: String,
    pub api_key_id: String,
    #[serde(default)]
    pub profile_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfigChange {
    pub action: DesktopConfigAction,
    pub source: DesktopChangeSource,
    pub changed_at: String,
    pub version: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncFailure {
    pub source: DesktopChangeSource,
    pub occurred_at: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConnectionState {
    pub client_kind: DesktopClientKind,
    pub status: DesktopConnectionStatus,
    pub route: Option<DesktopRoute>,
    pub last_config_change: Option<DesktopConfigChange>,
    pub sync_failure: Option<DesktopSyncFailure>,
    pub warning: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOperationResult {
    pub client_kind: DesktopClientKind,
    pub action: DesktopAction,
    pub completion: DesktopCompletion,
    pub route_changed: bool,
    pub config_changed: bool,
    pub model_count: Option<usize>,
    pub next_action: DesktopNextAction,
    pub updated_at: String,
    pub warning: Option<String>,
    pub state: DesktopConnectionState,
}
impl DesktopOperationResult {
    /// Compatibility for the tray and old IPC callers; they must not parse this copy.
    pub(crate) fn legacy_message(self) -> Result<String, String> {
        if self.completion == DesktopCompletion::Partial {
            return Err(self.warning.unwrap_or_else(|| "Desktop configuration is partially updated. Refresh and retry or restore official configuration.".into()));
        }
        Ok(if self.config_changed {
            "配置已更新；请完全退出并重新打开客户端以加载配置".into()
        } else if self.action == DesktopAction::Restore {
            "官方配置已保留".into()
        } else {
            "网关线路已更新；未改写客户端配置".into()
        })
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRecord {
    last_config_change: Option<DesktopConfigChange>,
    sync_failure: Option<DesktopSyncFailure>,
}
fn read_record(db: &Database, client: DesktopClientKind) -> Result<DesktopRecord, String> {
    db.settings_get_value(&client.record_key()).map_err(|_| "Cannot read desktop operation history. Retry after checking the local database.".to_string())?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| "Desktop operation history is unreadable. Configuration status could not be fully verified.".into()))
        .unwrap_or_else(|| Ok(DesktopRecord::default()))
}
fn write_record(
    db: &Database,
    client: DesktopClientKind,
    record: &DesktopRecord,
) -> Result<(), String> {
    let raw = serde_json::to_string(record)
        .map_err(|_| "Cannot encode desktop operation history.".to_string())?;
    db.settings_set_value(&client.record_key(), &raw)
        .map_err(|_| {
            "Cannot save desktop operation history. Retry after checking the local database.".into()
        })
}
pub(crate) fn record_sync_failure(
    db: &Database,
    client: DesktopClientKind,
    source: DesktopChangeSource,
) -> Result<(), String> {
    let mut record = read_record(db, client)?;
    record.sync_failure = Some(DesktopSyncFailure {
        source,
        occurred_at: chrono::Utc::now().to_rfc3339(),
        // Never persist raw parser/SQL/provider errors: they can contain credentials.
        message: "Desktop configuration could not be synchronized. Saved key data is retained. Refresh the connection state and reapply its route, or restore official configuration.".into(),
    });
    write_record(db, client, &record)
}
fn record_success(
    db: &Database,
    client: DesktopClientKind,
    source: DesktopChangeSource,
    action: DesktopAction,
    changed: bool,
) -> Result<(), String> {
    let mut record = read_record(db, client)?;
    if changed {
        record.last_config_change = Some(DesktopConfigChange {
            action: if action == DesktopAction::Restore {
                DesktopConfigAction::Restore
            } else if source == DesktopChangeSource::User {
                DesktopConfigAction::Takeover
            } else {
                DesktopConfigAction::Sync
            },
            source,
            changed_at: chrono::Utc::now().to_rfc3339(),
            version: record
                .last_config_change
                .as_ref()
                .map_or(1, |change| change.version.saturating_add(1)),
        });
    }
    record.sync_failure = None;
    write_record(db, client, &record)
}

pub(crate) struct ConfigFacts {
    pub status: DesktopConnectionStatus,
    // Private control-plane data: never serialize this struct or include it in an error.
    pub token: Option<String>,
}
pub(crate) trait DesktopConfigFiles {
    fn files(&self) -> Vec<PathBuf>;
    fn inspect(&self) -> Result<ConfigFacts, String>;
}
#[derive(PartialEq, Eq)]
struct FileSnapshot {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}
fn snapshot(config: &impl DesktopConfigFiles) -> Result<Vec<FileSnapshot>, String> {
    config
        .files()
        .into_iter()
        .map(|path| {
            let bytes = match fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => {
                    return Err(
                        "Cannot read desktop configuration files. Check file access and retry."
                            .into(),
                    )
                }
            };
            Ok(FileSnapshot { path, bytes })
        })
        .collect()
}
fn rollback_files(snapshots: &[FileSnapshot]) -> bool {
    // Attempt every restoration, not just the first file. Only restore known paths.
    let mut restored = true;
    for old in snapshots {
        let result = match &old.bytes {
            Some(bytes) => fs::write(&old.path, bytes),
            None => match fs::remove_file(&old.path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
        };
        restored &= result.is_ok();
    }
    restored
}
fn read_state_inner(
    db: &Database,
    client: DesktopClientKind,
    config: &impl DesktopConfigFiles,
) -> Result<DesktopConnectionState, String> {
    let facts = config.inspect()?;
    let record = read_record(db, client)?;
    let mut state = DesktopConnectionState {
        client_kind: client,
        status: facts.status,
        route: None,
        last_config_change: record.last_config_change,
        sync_failure: record.sync_failure,
        warning: None,
    };
    if facts.status == DesktopConnectionStatus::Unknown {
        state.warning = Some("Desktop configuration is incomplete or a different profile is selected. Reapply a route or restore official configuration.".into());
    }
    if facts.status == DesktopConnectionStatus::TakenOver {
        let session = facts
            .token
            .as_deref()
            .filter(|token| token.starts_with(SESSION_TOKEN_PREFIX))
            .map(|token| db.proxy_session_get(token))
            .transpose()
            .map_err(|_| {
                "Cannot read the configured desktop route. Refresh and retry.".to_string()
            })?
            .flatten();
        if let Some(session) = session.filter(|session| {
            session.session_kind == "desktop"
                && session.cli_type.as_deref() == Some(client.cli_type())
                && session.revoked_at.is_none()
                && session.is_active
        }) {
            let provider = db
                .provider_get(&session.provider_id)
                .map_err(|_| "Cannot read the desktop provider.".to_string())?;
            let key = db
                .api_key_get(&session.api_key_id)
                .map_err(|_| "Cannot read the desktop key.".to_string())?;
            if provider.is_some()
                && key
                    .as_ref()
                    .is_some_and(|key| key.provider_id == session.provider_id)
            {
                state.route = Some(DesktopRoute {
                    provider_id: session.provider_id,
                    api_key_id: session.api_key_id,
                    profile_id: session.client_profile_id,
                });
            }
        }
        if state.route.is_none() {
            state.status = DesktopConnectionStatus::Unknown;
            state.warning = Some("Takeover configuration exists, but its saved route is unavailable. Reapply a route or restore official configuration.".into());
        }
    }
    Ok(state)
}
pub(crate) fn read_state(
    db: &Database,
    client: DesktopClientKind,
    config: &impl DesktopConfigFiles,
    failure_status: DesktopConnectionStatus,
) -> DesktopConnectionState {
    match read_state_inner(db, client, config) {
        Ok(state) => state,
        Err(warning) => {
            let record = read_record(db, client).unwrap_or_default();
            DesktopConnectionState {
                client_kind: client,
                status: failure_status,
                route: None,
                last_config_change: record.last_config_change,
                sync_failure: record.sync_failure,
                warning: Some(warning),
            }
        }
    }
}

pub(crate) fn validate_route_with_profile(
    db: &Database,
    client: DesktopClientKind,
    provider_id: &str,
    api_key_id: &str,
    client_profile_id: Option<&str>,
) -> Result<(Provider, ApiKey, Option<crate::models::ClientProfile>), String> {
    let provider = db
        .provider_get(provider_id)
        .map_err(|_| "Cannot read provider.".to_string())?
        .ok_or("Provider not found")?;
    let key = db
        .api_key_get(api_key_id)
        .map_err(|_| "Cannot read API key.".to_string())?
        .ok_or("API key not found")?;
    if key.provider_id != provider.id {
        return Err("API key does not belong to the selected provider.".into());
    }
    if !provider.is_active || !key.is_active {
        return Err("The selected provider or API key is disabled.".into());
    }
    if key.is_exhausted {
        return Err("The selected API key is exhausted.".into());
    }
    if let Some(pid) = client_profile_id {
        let profile = db
            .client_profile_get(pid)
            .map_err(|_| "Cannot read client profile.".to_string())?
            .ok_or("Client profile not found")?;
        if profile.client_kind != client.as_str() {
            return Err("The selected profile is not compatible with this desktop client.".into());
        }
        if profile.provider_id != provider.id || profile.api_key_id != key.id {
            return Err("The selected profile does not match the selected provider or key.".into());
        }
        return Ok((provider, key, Some(profile)));
    }
    if !key.types.iter().any(|kind| kind == client.as_str()) {
        return Err("The selected API key is not compatible with this desktop client.".into());
    }
    Ok((provider, key, None))
}

#[allow(dead_code)]
pub(crate) fn validate_route(
    db: &Database,
    client: DesktopClientKind,
    provider_id: &str,
    api_key_id: &str,
) -> Result<(Provider, ApiKey), String> {
    let (provider, key, _) =
        validate_route_with_profile(db, client, provider_id, api_key_id, None)?;
    Ok((provider, key))
}

#[allow(dead_code, clippy::too_many_arguments)]
pub(crate) fn apply_with_config(
    db: &Database,
    client: DesktopClientKind,
    provider_id: &str,
    api_key_id: &str,
    source: DesktopChangeSource,
    config: &impl DesktopConfigFiles,
    model_count: Option<usize>,
    apply: impl FnOnce(&str, u16) -> Result<(), String>,
) -> Result<DesktopOperationResult, String> {
    apply_with_config_and_profile(
        db,
        client,
        provider_id,
        api_key_id,
        None,
        source,
        config,
        model_count,
        apply,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_with_config_and_profile(
    db: &Database,
    client: DesktopClientKind,
    provider_id: &str,
    api_key_id: &str,
    client_profile_id: Option<&str>,
    source: DesktopChangeSource,
    config: &impl DesktopConfigFiles,
    model_count: Option<usize>,
    apply: impl FnOnce(&str, u16) -> Result<(), String>,
) -> Result<DesktopOperationResult, String> {
    validate_route_with_profile(db, client, provider_id, api_key_id, client_profile_id)?;
    let configured_token = config.inspect()?.token;
    let saved_token = db
        .settings_get_value(client.session_key())
        .map_err(|_| "Cannot read desktop session setting.".to_string())?;
    // Prefer the token actually installed in the client. A stale setting must
    // neither force a config rewrite nor overwrite another client's session.
    let mut reusable_token = None;
    for candidate in [configured_token, saved_token].into_iter().flatten() {
        if !candidate.starts_with(SESSION_TOKEN_PREFIX) {
            continue;
        }
        let session = db
            .proxy_session_get(&candidate)
            .map_err(|_| "Cannot read desktop session.".to_string())?;
        if session.as_ref().is_none_or(|session| {
            session.session_kind == "desktop"
                && session.cli_type.as_deref() == Some(client.cli_type())
        }) {
            reusable_token = Some(candidate);
            break;
        }
    }
    let token = reusable_token.unwrap_or_else(new_session_token);
    let port = db
        .settings_get()
        .map_err(|_| "Cannot read proxy settings.".to_string())?
        .proxy_port as u16;
    execute_change(
        db,
        client,
        source,
        config,
        DesktopAction::Takeover,
        model_count,
        || {
            let old = db
                .proxy_session_get(&token)
                .map_err(|_| "Cannot read desktop session.".to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            db.proxy_session_create(&ProxySession {
                session_token: token.clone(),
                provider_id: provider_id.into(),
                api_key_id: api_key_id.into(),
                client_profile_id: client_profile_id.map(str::to_string),
                project_id: None,
                created_at: old.map_or_else(|| now.clone(), |session| session.created_at),
                session_kind: "desktop".into(),
                last_seen_at: now,
                expires_at: None,
                revoked_at: None,
                revoked_reason: None,
                cli_type: Some(client.cli_type().into()),
                display_name: None,
                is_active: true,
                connection_config: None,
                model_policy: None,
            })
            .map_err(|_| {
                "Cannot save desktop session. Retry after checking the local database.".to_string()
            })?;
            db.settings_set_value(client.session_key(), &token)
                .map_err(|_| "Cannot save desktop session setting.".to_string())?;
            apply(&token, port)
        },
    )
}
pub(crate) fn restore_with_config(
    db: &Database,
    client: DesktopClientKind,
    config: &impl DesktopConfigFiles,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<DesktopOperationResult, String> {
    let configured_token = config.inspect()?.token;
    execute_change(
        db,
        client,
        DesktopChangeSource::User,
        config,
        DesktopAction::Restore,
        None,
        || {
            restore()?;
            let saved_token = db
                .settings_get_value(client.session_key())
                .map_err(|_| "Cannot read desktop session setting.".to_string())?;
            let tokens: std::collections::BTreeSet<_> = [configured_token, saved_token]
                .into_iter()
                .flatten()
                .collect();
            for token in tokens {
                let session = db
                    .proxy_session_get(&token)
                    .map_err(|_| "Cannot read the old desktop session.".to_string())?;
                if session.is_some_and(|session| {
                    session.session_kind == "desktop"
                        && session.cli_type.as_deref() == Some(client.cli_type())
                }) {
                    db.proxy_session_revoke(
                        &token,
                        "desktop_restore",
                        &chrono::Utc::now().to_rfc3339(),
                    )
                    .map_err(|_| "Cannot revoke the old desktop session.".to_string())?;
                }
            }
            db.settings_delete_value(client.session_key())
                .map_err(|_| "Cannot clear desktop session setting.".to_string())
        },
    )
}
fn execute_change(
    db: &Database,
    client: DesktopClientKind,
    source: DesktopChangeSource,
    config: &impl DesktopConfigFiles,
    action: DesktopAction,
    model_count: Option<usize>,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<DesktopOperationResult, String> {
    // Validate readable configuration before mutating the DB. The transaction keeps
    // new session bindings invisible to the daemon until all file writes succeed.
    config.inspect()?;
    let before = snapshot(config)?;
    let old_route = read_state(db, client, config, DesktopConnectionStatus::Error).route;
    let transaction = db
        .conn
        .unchecked_transaction()
        .map_err(|_| "Cannot begin desktop configuration update.".to_string())?;
    let mut changed = false;
    let attempt = operation().and_then(|()| {
        changed = snapshot(config)? != before;
        record_success(db, client, source, action, changed)
    });
    let failure = match attempt {
        Ok(()) => transaction.commit().err().map(|_| {
            (
                "Cannot commit desktop configuration update.".to_string(),
                db.conn.is_autocommit(),
            )
        }),
        Err(error) => Some((error, transaction.rollback().is_ok())),
    };
    if let Some((error, db_restored)) = failure {
        let files_restored = rollback_files(&before);
        let record_saved = record_sync_failure(db, client, source).is_ok();
        if db_restored && files_restored {
            return Err(format!(
                "{error} Previous files and route were restored. Retry the operation.{}",
                if record_saved {
                    ""
                } else {
                    " The failure notice could not be saved."
                }
            ));
        }
        let mut state = read_state(db, client, config, DesktopConnectionStatus::Unknown);
        if !db_restored {
            state.status = DesktopConnectionStatus::Unknown;
            state.route = None;
        }
        let warning = format!("Desktop update failed and rollback was incomplete. Refresh to inspect the actual configuration, then reapply a route or restore official configuration.{}", if record_saved { "" } else { " The failure notice could not be saved." });
        let config_changed = snapshot(config)
            .map(|after| after != before)
            .unwrap_or(true);
        return Ok(DesktopOperationResult {
            client_kind: client,
            action,
            completion: DesktopCompletion::Partial,
            route_changed: state.route != old_route,
            config_changed,
            model_count,
            next_action: if config_changed {
                DesktopNextAction::ReopenClient
            } else {
                DesktopNextAction::None
            },
            updated_at: chrono::Utc::now().to_rfc3339(),
            warning: Some(warning),
            state,
        });
    }
    let state = read_state(db, client, config, DesktopConnectionStatus::Unknown);
    let partial = matches!(
        state.status,
        DesktopConnectionStatus::Unknown | DesktopConnectionStatus::Error
    );
    let warning = if partial {
        Some("Configuration was saved, but its current state could not be fully read back. Refresh and retry or restore official configuration.".into())
    } else {
        None
    };
    Ok(DesktopOperationResult {
        client_kind: client,
        action: if action == DesktopAction::Takeover && !changed {
            DesktopAction::SwitchRoute
        } else {
            action
        },
        completion: if partial {
            DesktopCompletion::Partial
        } else {
            DesktopCompletion::Complete
        },
        route_changed: old_route != state.route,
        config_changed: changed,
        model_count,
        next_action: if changed {
            DesktopNextAction::ReopenClient
        } else {
            DesktopNextAction::None
        },
        updated_at: chrono::Utc::now().to_rfc3339(),
        warning,
        state,
    })
}

#[tauri::command]
pub fn desktop_connection_state(
    client_kind: DesktopClientKind,
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<DesktopConnectionState, String> {
    let db = db
        .lock()
        .map_err(|_| "Desktop database is unavailable.".to_string())?;
    desktop_connection_state_inner(&db, client_kind)
}

/// Shared read path for the GUI and tray; neither uses historical key choices.
pub(crate) fn desktop_connection_state_inner(
    db: &Database,
    client_kind: DesktopClientKind,
) -> Result<DesktopConnectionState, String> {
    match client_kind {
        DesktopClientKind::Codex => {
            let manager = codex_config::CodexConfigManager::new()
                .map_err(|_| "Cannot locate Codex configuration.".to_string())?;
            Ok(read_state(
                db,
                client_kind,
                &manager,
                DesktopConnectionStatus::Error,
            ))
        }
        DesktopClientKind::ClaudeDesktop => {
            let manager = claude_desktop_config::ClaudeDesktopConfigManager::new()
                .map_err(|_| "Cannot locate Claude Desktop configuration.".to_string())?;
            Ok(read_state(
                db,
                client_kind,
                &manager,
                DesktopConnectionStatus::Error,
            ))
        }
    }
}
#[tauri::command]
pub async fn desktop_connection_apply(
    client_kind: DesktopClientKind,
    provider_id: String,
    api_key_id: String,
    client_profile_id: Option<String>,
    db: State<'_, Arc<Mutex<Database>>>,
    app: tauri::AppHandle,
) -> Result<DesktopOperationResult, String> {
    let result = match client_kind {
        DesktopClientKind::Codex => {
            codex_config::codex_config_apply_with_profile_inner(
                db.inner(),
                provider_id,
                api_key_id,
                client_profile_id,
            )
            .await
        }
        DesktopClientKind::ClaudeDesktop => {
            claude_desktop_config::claude_desktop_config_apply_with_profile_inner(
                db.inner(),
                provider_id,
                api_key_id,
                client_profile_id,
            )
        }
    };
    // All mutex guards have been released by the operation. Rebuild from the
    // actual files even after partial failure rather than optimistic UI state.
    crate::tray::refresh_tray_menu(&app);
    result
}
#[tauri::command]
pub fn desktop_connection_restore(
    client_kind: DesktopClientKind,
    db: State<'_, Arc<Mutex<Database>>>,
    app: tauri::AppHandle,
) -> Result<DesktopOperationResult, String> {
    let result = match client_kind {
        DesktopClientKind::Codex => codex_config::codex_config_restore_typed(db.inner()),
        DesktopClientKind::ClaudeDesktop => {
            claude_desktop_config::claude_desktop_config_restore_typed(db.inner())
        }
    };
    crate::tray::refresh_tray_menu(&app);
    result
}

#[cfg(test)]
#[path = "desktop_connection_tests.rs"]
mod tests;
