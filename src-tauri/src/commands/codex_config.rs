//! Codex config.toml 配置级接管
//!
//! 实现 Codex 配置文件的读取、备份、写入、恢复。
//!
//! ## 接管策略
//!
//! - 只改 `model_provider` 与 `[model_providers.cc-use]` 块
//! - 保留用户其他配置（官方登录、其他 provider、用户偏好）
//! - 不碰 `~/.codex/auth.json`
//! - 备份到 `~/.cc-use/backups/codex/config.<ISO8601>.toml`
//!
//! ## 写入内容
//!
//! ```toml
//! model_provider = "cc-use"
//!
//! [model_providers.cc-use]
//! name = "CC Use"
//! base_url = "http://127.0.0.1:12345/v1"
//! wire_api = "responses"
//!
//! [model_providers.cc-use.auth]
//! token = "<route-token>"
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

const CC_USE_PROVIDER_KEY: &str = "cc-use";

#[derive(Error, Debug)]
pub enum CodexConfigError {
    #[error("Config file not found: {0}")]
    NotFound(String),
    #[error("Failed to read config: {0}")]
    ReadError(String),
    #[error("Failed to parse TOML: {0}")]
    ParseError(String),
    #[error("Failed to write config: {0}")]
    WriteError(String),
    #[error("Failed to create backup: {0}")]
    BackupError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_providers: Option<HashMap<String, ProviderConfig>>,
    #[serde(flatten)]
    pub other: HashMap<String, toml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    pub wire_api: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<ProviderAuth>,
    #[serde(flatten)]
    pub other: HashMap<String, toml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAuth {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_interval_ms: Option<u64>,
    #[serde(flatten)]
    pub other: HashMap<String, toml::Value>,
}

/// Codex 配置管理器
pub struct CodexConfigManager {
    config_path: PathBuf,
    backup_dir: PathBuf,
}

impl CodexConfigManager {
    /// 创建新的配置管理器
    pub fn new() -> Result<Self, CodexConfigError> {
        let home = dirs::home_dir().ok_or_else(|| {
            CodexConfigError::NotFound("Could not find home directory".to_string())
        })?;

        let config_path = home.join(".codex").join("config.toml");
        let backup_dir = home.join(".cc-use").join("backups").join("codex");

        Ok(Self {
            config_path,
            backup_dir,
        })
    }

    /// 读取当前配置
    pub fn read(&self) -> Result<CodexConfig, CodexConfigError> {
        if !self.config_path.exists() {
            return Ok(CodexConfig {
                model_provider: None,
                model_providers: None,
                other: HashMap::new(),
            });
        }

        let content = fs::read_to_string(&self.config_path).map_err(|e| {
            CodexConfigError::ReadError(format!("{}: {}", self.config_path.display(), e))
        })?;

        toml::from_str(&content)
            .map_err(|e| CodexConfigError::ParseError(format!("{}: {}", self.config_path.display(), e)))
    }

    /// 备份当前配置
    pub fn backup(&self) -> Result<PathBuf, CodexConfigError> {
        if !self.config_path.exists() {
            return Err(CodexConfigError::NotFound(format!(
                "Config file does not exist: {}",
                self.config_path.display()
            )));
        }

        fs::create_dir_all(&self.backup_dir)?;

        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let backup_path = self.backup_dir.join(format!("config.{}.toml", timestamp));

        fs::copy(&self.config_path, &backup_path).map_err(|e| {
            CodexConfigError::BackupError(format!("Failed to copy to {}: {}", backup_path.display(), e))
        })?;

        Ok(backup_path)
    }

    /// 接管配置：写入 cc-use provider
    pub fn takeover(&self, route_token: &str, proxy_port: u16) -> Result<PathBuf, CodexConfigError> {
        // 1. 备份原配置(如果存在且尚未被接管)
        let backup_path = if self.config_path.exists() {
            let is_taken = self.is_taken_over().unwrap_or(false);
            if !is_taken {
                Some(self.backup()?)
            } else {
                None
            }
        } else {
            fs::create_dir_all(self.config_path.parent().unwrap())?;
            None
        };

        // 2. 读取现有配置
        let mut config = self.read()?;

        // 3. 修改 model_provider
        config.model_provider = Some(CC_USE_PROVIDER_KEY.to_string());

        // 4. 写入 cc-use provider
        let mut providers = config.model_providers.unwrap_or_default();
        providers.insert(
            CC_USE_PROVIDER_KEY.to_string(),
            ProviderConfig {
                name: "CC Use".to_string(),
                base_url: format!("http://127.0.0.1:{}/v1", proxy_port),
                wire_api: "responses".to_string(),
                auth: Some(ProviderAuth {
                    token: Some(route_token.to_string()),
                    command: None,
                    refresh_interval_ms: None,
                    other: HashMap::new(),
                }),
                other: HashMap::new(),
            },
        );
        config.model_providers = Some(providers);

        // 5. 原子写入
        self.write_atomic(&config)?;

        Ok(backup_path.unwrap_or_else(|| PathBuf::from("")))
    }

    /// 恢复配置：从备份恢复或移除 cc-use provider
    pub fn restore(&self, backup_path: Option<&Path>) -> Result<(), CodexConfigError> {
        if let Some(backup) = backup_path {
            // 从备份恢复
            if !backup.exists() {
                return Err(CodexConfigError::NotFound(format!(
                    "Backup file not found: {}",
                    backup.display()
                )));
            }
            fs::copy(backup, &self.config_path)?;
        } else {
            // 移除 cc-use provider
            let mut config = self.read()?;

            if config.model_provider.as_deref() == Some(CC_USE_PROVIDER_KEY) {
                config.model_provider = None;
            }

            if let Some(ref mut providers) = config.model_providers {
                providers.remove(CC_USE_PROVIDER_KEY);
            }

            self.write_atomic(&config)?;
        }

        Ok(())
    }

    /// 原子写入配置（临时文件 + rename）
    fn write_atomic(&self, config: &CodexConfig) -> Result<(), CodexConfigError> {
        let content = toml::to_string_pretty(config)
            .map_err(|e| CodexConfigError::WriteError(format!("Failed to serialize: {}", e)))?;

        let temp_path = self.config_path.with_extension("toml.tmp");

        fs::write(&temp_path, content).map_err(|e| {
            CodexConfigError::WriteError(format!("Failed to write temp file: {}", e))
        })?;

        fs::rename(&temp_path, &self.config_path).map_err(|e| {
            CodexConfigError::WriteError(format!("Failed to rename temp file: {}", e))
        })?;

        Ok(())
    }

    /// 列出所有备份
    pub fn list_backups(&self) -> Result<Vec<PathBuf>, CodexConfigError> {
        if !self.backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        for entry in fs::read_dir(&self.backup_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("toml") {
                backups.push(path);
            }
        }

        backups.sort();
        backups.reverse(); // 最新的在前

        Ok(backups)
    }

    /// 检查是否已接管
    pub fn is_taken_over(&self) -> Result<bool, CodexConfigError> {
        let config = self.read()?;
        Ok(config.model_provider.as_deref() == Some(CC_USE_PROVIDER_KEY)
            && config
                .model_providers
                .as_ref()
                .and_then(|p| p.get(CC_USE_PROVIDER_KEY))
                .is_some())
    }
}

impl Default for CodexConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to create CodexConfigManager")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_manager() -> (CodexConfigManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".codex").join("config.toml");
        let backup_dir = temp_dir.path().join(".cc-use").join("backups").join("codex");

        let manager = CodexConfigManager {
            config_path,
            backup_dir,
        };

        (manager, temp_dir)
    }

    #[test]
    fn test_read_empty_config() {
        let (manager, _temp) = create_test_manager();
        let config = manager.read().unwrap();
        assert!(config.model_provider.is_none());
        assert!(config.model_providers.is_none());
    }

    #[test]
    fn test_takeover_creates_cc_use_provider() {
        let (manager, _temp) = create_test_manager();

        manager.takeover("test-token", 12345).unwrap();

        let config = manager.read().unwrap();
        assert_eq!(config.model_provider.as_deref(), Some("cc-use"));

        let providers = config.model_providers.unwrap();
        let cc_use = providers.get("cc-use").unwrap();

        assert_eq!(cc_use.name, "CC Use");
        assert_eq!(cc_use.base_url, "http://127.0.0.1:12345/v1");
        assert_eq!(cc_use.wire_api, "responses");
        assert_eq!(
            cc_use.auth.as_ref().unwrap().token.as_deref(),
            Some("test-token")
        );
    }

    #[test]
    fn test_takeover_preserves_other_config() {
        let (manager, _temp) = create_test_manager();

        // 写入原始配置
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original = r#"
model_provider = "openai"
some_other_field = "value"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "openai"
"#;
        fs::write(&manager.config_path, original).unwrap();

        // 接管
        manager.takeover("test-token", 12345).unwrap();

        // 验证保留了其他配置
        let config = manager.read().unwrap();
        assert!(config.other.contains_key("some_other_field"));

        let providers = config.model_providers.unwrap();
        assert!(providers.contains_key("openai"));
        assert!(providers.contains_key("cc-use"));
    }

    #[test]
    fn test_restore_removes_cc_use_provider() {
        let (manager, _temp) = create_test_manager();

        manager.takeover("test-token", 12345).unwrap();
        assert!(manager.is_taken_over().unwrap());

        manager.restore(None).unwrap();

        let config = manager.read().unwrap();
        assert_ne!(config.model_provider.as_deref(), Some("cc-use"));
        assert!(!config
            .model_providers
            .as_ref()
            .map(|p| p.contains_key("cc-use"))
            .unwrap_or(false));
    }

    #[test]
    fn test_backup_and_restore() {
        let (manager, _temp) = create_test_manager();

        // 写入原始配置
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original = "model_provider = \"openai\"\n";
        fs::write(&manager.config_path, original).unwrap();

        // 接管并备份
        let backup_path = manager.takeover("test-token", 12345).unwrap();
        assert!(backup_path.exists());

        // 从备份恢复
        manager.restore(Some(&backup_path)).unwrap();

        let content = fs::read_to_string(&manager.config_path).unwrap();
        assert_eq!(content, original);
    }

    #[test]
    fn test_is_taken_over() {
        let (manager, _temp) = create_test_manager();

        assert!(!manager.is_taken_over().unwrap());

        manager.takeover("test-token", 12345).unwrap();
        assert!(manager.is_taken_over().unwrap());

        manager.restore(None).unwrap();
        assert!(!manager.is_taken_over().unwrap());
    }

    #[test]
    fn test_list_backups() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        fs::write(&manager.config_path, "model_provider = \"openai\"\n").unwrap();

        // 第一次 takeover 创建备份
        manager.takeover("token1", 12345).unwrap();
        let backups = manager.list_backups().unwrap();
        assert_eq!(backups.len(), 1);

        // 恢复并再次接管
        let first_backup = backups[0].clone();
        manager.restore(Some(&first_backup)).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        manager.takeover("token2", 12345).unwrap();

        let backups = manager.list_backups().unwrap();
        assert_eq!(backups.len(), 2);
    }
}

// ── Tauri commands ──

use crate::db::Database;
use crate::models::ProxySession;
use std::sync::{Arc, Mutex};
use tauri::State;

fn get_proxy_port(db: &Database) -> i32 {
    db.settings_get()
        .ok()
        .and_then(|s| s.proxy_port.to_string().parse().ok())
        .unwrap_or(12345)
}

fn gen_route_token() -> String {
    format!("rt_{}", nanoid::nanoid!(32))
}

#[tauri::command]
pub fn codex_config_read() -> Result<String, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    let config = mgr.read().map_err(|e| e.to_string())?;
    toml::to_string_pretty(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn codex_config_is_taken_over() -> Result<bool, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    mgr.is_taken_over().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn codex_config_takeover(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
) -> Result<String, String> {
    let (port, session_token) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let port = get_proxy_port(&db);
        // 创建持久 session,用于代理识别此接入点的 route
        let session_token = gen_route_token();
        let session = ProxySession {
            session_token: session_token.clone(),
            provider_id: provider_id.clone(),
            api_key_id: api_key_id.clone(),
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            cli_type: Some("codex".to_string()),
        };
        db.proxy_session_create(&session)
            .map_err(|e| format!("创建 session 失败: {}", e))?;
        (port, session_token)
    };
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    let backup = mgr.takeover(&session_token, port as u16).map_err(|e| e.to_string())?;
    Ok(format!("接管成功, route 已绑定, config.toml 已写入"))
}

#[tauri::command]
pub fn codex_config_restore(_db: State<'_, Arc<Mutex<Database>>>) -> Result<String, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    mgr.restore(None).map_err(|e| e.to_string())?;
    Ok("已恢复官方配置".to_string())
}

#[tauri::command]
pub fn codex_config_list_backups() -> Result<Vec<String>, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    let backups = mgr.list_backups().map_err(|e| e.to_string())?;
    Ok(backups.iter().map(|p| p.display().to_string()).collect())
}
