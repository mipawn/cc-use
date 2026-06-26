#![allow(dead_code)]

use cc_use_lib::db::Database;
use cc_use_lib::models::{
    ApiKey, CreateApiKeyInput, CreateProjectInput, CreateProviderInput, ManagedInstance, Project,
    Provider, ProxySession,
};
use cc_use_lib::proxy::ProxyState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

pub struct TempDb {
    pub db: Database,
    path: PathBuf,
}

impl TempDb {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("cc-use-integration-{}.db", nanoid::nanoid!(8)));
        let db = Database::open_at(&path).expect("create temp database");
        Self { db, path }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }
}

pub fn create_provider(db: &Database, name: &str, provider_type: &str) -> Provider {
    db.provider_create(&CreateProviderInput {
        name: name.to_string(),
        base_url: "https://example.com".to_string(),
        provider_type: Some(provider_type.to_string()),
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
        api_format: None,
        transform_enabled: None,
    })
    .expect("create provider")
}

pub fn create_api_key(db: &Database, provider_id: &str, cli_type: &str) -> ApiKey {
    db.api_key_create(&CreateApiKeyInput {
        provider_id: provider_id.to_string(),
        alias: Some(format!("{}-key", cli_type)),
        value: format!("sk-{}", cli_type),
        types: Some(vec![cli_type.to_string()]),
        priority: Some(0),
        is_active: Some(true),
        config: None,
        cost_multiplier: None,
        usage_type: None,
        usage_url: None,
        usage_path: None,
        usage_headers: None,
        model_mapping: None,
        api_format: None,
        transform_enabled: None,
        client_configs: None,
    })
    .expect("create api key")
}

pub fn create_project(
    db: &Database,
    provider_id: Option<String>,
    api_key_id: Option<String>,
    cli_type: &str,
) -> Project {
    db.project_create(&CreateProjectInput {
        name: format!("{} project", cli_type),
        path: format!("/tmp/{}-project-{}", cli_type, nanoid::nanoid!(6)),
        remark: None,
        provider_id,
        api_key_id,
        cli_type: Some(cli_type.to_string()),
        terminal_type: Some("terminal".to_string()),
    })
    .expect("create project")
}

pub fn build_proxy_state(db: Database) -> Arc<ProxyState> {
    let (console_tx, _rx) = tokio::sync::broadcast::channel(256);
    Arc::new(ProxyState {
        db: Arc::new(Mutex::new(db)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        request_count: Arc::new(AtomicU64::new(0)),
        last_error: Arc::new(Mutex::new(None)),
        console_tx,
    })
}

pub fn create_proxy_session(
    db: &Database,
    session_token: &str,
    provider_id: &str,
    api_key_id: &str,
    project_id: Option<&str>,
) {
    db.proxy_session_create(&ProxySession {
        session_token: session_token.to_string(),
        provider_id: provider_id.to_string(),
        api_key_id: api_key_id.to_string(),
        project_id: project_id.map(|id| id.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        cli_type: None,
    })
    .expect("create proxy session")
}

pub fn create_managed_instance(
    db: &Database,
    id: &str,
    session_token: &str,
    project_id: Option<&str>,
    provider_id: Option<&str>,
    api_key_id: Option<&str>,
    cli_type: &str,
) -> ManagedInstance {
    let instance = ManagedInstance {
        id: id.to_string(),
        session_token: session_token.to_string(),
        project_id: project_id.map(|value| value.to_string()),
        provider_id: provider_id.map(|value| value.to_string()),
        api_key_id: api_key_id.map(|value| value.to_string()),
        cli_type: cli_type.to_string(),
        terminal_type: "terminal".to_string(),
        project_path: format!("/tmp/{}", id),
        shell_pid: Some(1001),
        process_pid: Some(1002),
        status: "running".to_string(),
        assignment_source: Some("project_launch".to_string()),
        last_seen_at: "2026-04-14T16:00:00Z".to_string(),
        launched_at: "2026-04-14T16:00:00Z".to_string(),
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
    };
    db.managed_instance_create(&instance)
        .expect("create managed instance");
    instance
}
