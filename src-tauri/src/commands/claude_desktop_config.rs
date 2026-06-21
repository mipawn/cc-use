//! Claude Desktop 配置级接管 (adapter)
//!
//! 实现 Claude Desktop 配置文件的读取、备份、写入、恢复。
//!
//! ## Schema 探测与状态机
//!
//! Claude Desktop 配置 schema 未正式验证前,状态保持 `unsupported`。
//! 只有在真机验证 schema 正确后才标记为 `supported`。
//!
//! ## 接管策略
//!
//! - 配置路径: `~/Library/Application Support/Claude/config.json` (macOS)
//! - 只修改 provider/baseUrl/apiKey,保留其他配置
//! - 备份到 `~/.cc-use/backups/claude-desktop/config.<ISO8601>.json`
//! - 不改 Claude Code CLI 的 env 或 settings
//!
//! ## 写入内容示例
//!
//! ```json
//! {
//!   "provider": "custom",
//!   "baseUrl": "http://127.0.0.1:12345/v1",
//!   "apiKey": "<route-token>"
//! }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ClaudeDesktopConfigError {
    #[error("Config file not found: {0}")]
    NotFound(String),
    #[error("Failed to read config: {0}")]
    ReadError(String),
    #[error("Failed to parse JSON: {0}")]
    ParseError(String),
    #[error("Failed to write config: {0}")]
    WriteError(String),
    #[error("Failed to create backup: {0}")]
    BackupError(String),
    #[error("Schema not supported yet")]
    UnsupportedSchema,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeDesktopConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(flatten)]
    pub other: HashMap<String, JsonValue>,
}

/// Claude Desktop 配置状态
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopConfigStatus {
    NotFound,
    Unsupported, // Schema 未验证
    Official,    // 官方配置
    TakenOver,   // 已被 cc-use 接管
}

/// Claude Desktop 配置管理器
pub struct ClaudeDesktopConfigManager {
    config_path: PathBuf,
    backup_dir: PathBuf,
    schema_verified: bool, // 真机验证前保持 false
}

impl ClaudeDesktopConfigManager {
    /// 创建新的配置管理器
    pub fn new() -> Result<Self, ClaudeDesktopConfigError> {
        let home = dirs::home_dir().ok_or_else(|| {
            ClaudeDesktopConfigError::NotFound("Could not find home directory".to_string())
        })?;

        // macOS 路径
        let config_path = home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("config.json");

        let backup_dir = home
            .join(".cc-use")
            .join("backups")
            .join("claude-desktop");

        Ok(Self {
            config_path,
            backup_dir,
            schema_verified: false, // 未验证前保持 false
        })
    }

    /// 探测配置状态
    pub fn detect_status(&self) -> DesktopConfigStatus {
        if !self.config_path.exists() {
            return DesktopConfigStatus::NotFound;
        }

        if !self.schema_verified {
            return DesktopConfigStatus::Unsupported;
        }

        match self.read() {
            Ok(config) => {
                if self.is_taken_over_config(&config) {
                    DesktopConfigStatus::TakenOver
                } else {
                    DesktopConfigStatus::Official
                }
            }
            Err(_) => DesktopConfigStatus::Unsupported,
        }
    }

    /// 读取当前配置
    pub fn read(&self) -> Result<ClaudeDesktopConfig, ClaudeDesktopConfigError> {
        if !self.config_path.exists() {
            return Ok(ClaudeDesktopConfig {
                provider: None,
                base_url: None,
                api_key: None,
                other: HashMap::new(),
            });
        }

        let content = fs::read_to_string(&self.config_path).map_err(|e| {
            ClaudeDesktopConfigError::ReadError(format!("{}: {}", self.config_path.display(), e))
        })?;

        serde_json::from_str(&content).map_err(|e| {
            ClaudeDesktopConfigError::ParseError(format!("{}: {}", self.config_path.display(), e))
        })
    }

    /// 备份当前配置
    pub fn backup(&self) -> Result<PathBuf, ClaudeDesktopConfigError> {
        if !self.config_path.exists() {
            return Err(ClaudeDesktopConfigError::NotFound(format!(
                "Config file does not exist: {}",
                self.config_path.display()
            )));
        }

        fs::create_dir_all(&self.backup_dir)?;

        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let backup_path = self.backup_dir.join(format!("config.{}.json", timestamp));

        fs::copy(&self.config_path, &backup_path).map_err(|e| {
            ClaudeDesktopConfigError::BackupError(format!(
                "Failed to copy to {}: {}",
                backup_path.display(),
                e
            ))
        })?;

        Ok(backup_path)
    }

    /// 接管配置：写入 cc-use provider
    pub fn takeover(
        &self,
        route_token: &str,
        proxy_port: u16,
    ) -> Result<PathBuf, ClaudeDesktopConfigError> {
        // 1. 备份原配置（如果 config 不存在则创建目录）
        let backup_path = if self.config_path.exists() {
            let status = self.detect_status();
            if status != DesktopConfigStatus::TakenOver {
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

        // 3. 修改为指向本地代理
        config.provider = Some("custom".to_string());
        config.base_url = Some(format!("http://127.0.0.1:{}", proxy_port));
        config.api_key = Some(route_token.to_string());

        // 4. 原子写入
        self.write_atomic(&config)?;

        Ok(backup_path.unwrap_or_else(|| PathBuf::from("")))
    }

    /// 恢复配置：从备份恢复或移除 cc-use 设置
    pub fn restore(
        &self,
        backup_path: Option<&Path>,
    ) -> Result<(), ClaudeDesktopConfigError> {
        if let Some(backup) = backup_path {
            // 从备份恢复
            if !backup.exists() {
                return Err(ClaudeDesktopConfigError::NotFound(format!(
                    "Backup file not found: {}",
                    backup.display()
                )));
            }
            fs::copy(backup, &self.config_path)?;
        } else {
            // 移除 cc-use 设置
            let mut config = self.read()?;

            if self.is_taken_over_config(&config) {
                config.provider = None;
                config.base_url = None;
                config.api_key = None;
            }

            self.write_atomic(&config)?;
        }

        Ok(())
    }

    /// 原子写入配置（临时文件 + rename）
    fn write_atomic(
        &self,
        config: &ClaudeDesktopConfig,
    ) -> Result<(), ClaudeDesktopConfigError> {
        let content = serde_json::to_string_pretty(config).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to serialize: {}", e))
        })?;

        let temp_path = self.config_path.with_extension("json.tmp");

        fs::write(&temp_path, content).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to write temp file: {}", e))
        })?;

        fs::rename(&temp_path, &self.config_path).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to rename temp file: {}", e))
        })?;

        Ok(())
    }

    /// 检查配置是否被接管
    fn is_taken_over_config(&self, config: &ClaudeDesktopConfig) -> bool {
        config.provider.as_deref() == Some("custom")
            && config
                .base_url
                .as_ref()
                .map(|url| url.starts_with("http://127.0.0.1:"))
                .unwrap_or(false)
    }

    /// 列出所有备份
    pub fn list_backups(&self) -> Result<Vec<PathBuf>, ClaudeDesktopConfigError> {
        if !self.backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        for entry in fs::read_dir(&self.backup_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                backups.push(path);
            }
        }

        backups.sort();
        backups.reverse(); // 最新的在前

        Ok(backups)
    }

    /// 启用 schema 验证（仅在真机验证后调用）
    #[cfg(test)]
    pub fn enable_schema_verification(&mut self) {
        self.schema_verified = true;
    }
}

impl Default for ClaudeDesktopConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to create ClaudeDesktopConfigManager")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_manager() -> (ClaudeDesktopConfigManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir
            .path()
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("config.json");
        let backup_dir = temp_dir
            .path()
            .join(".cc-use")
            .join("backups")
            .join("claude-desktop");

        let mut manager = ClaudeDesktopConfigManager {
            config_path,
            backup_dir,
            schema_verified: false,
        };

        // 在测试中启用 schema 验证
        manager.enable_schema_verification();

        (manager, temp_dir)
    }

    #[test]
    fn test_detect_status_not_found() {
        let (manager, _temp) = create_test_manager();
        assert_eq!(manager.detect_status(), DesktopConfigStatus::NotFound);
    }

    #[test]
    fn test_takeover_creates_custom_provider() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        manager.takeover("test-token", 12345).unwrap();

        let config = manager.read().unwrap();
        assert_eq!(config.provider.as_deref(), Some("custom"));
        assert_eq!(
            config.base_url.as_deref(),
            Some("http://127.0.0.1:12345")
        );
        assert_eq!(config.api_key.as_deref(), Some("test-token"));
    }

    #[test]
    fn test_takeover_preserves_other_config() {
        let (manager, _temp) = create_test_manager();

        // 写入原始配置
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original = r#"{"theme":"dark","someOtherField":"value"}"#;
        fs::write(&manager.config_path, original).unwrap();

        manager.takeover("test-token", 12345).unwrap();

        let config = manager.read().unwrap();
        assert!(config.other.contains_key("theme"));
        assert!(config.other.contains_key("someOtherField"));
    }

    #[test]
    fn test_restore_removes_cc_use_settings() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        manager.takeover("test-token", 12345).unwrap();

        manager.restore(None).unwrap();

        let config = manager.read().unwrap();
        assert!(config.provider.is_none());
        assert!(config.base_url.is_none());
        assert!(config.api_key.is_none());
    }

    #[test]
    fn test_backup_and_restore() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original = r#"{"provider":"anthropic"}"#;
        fs::write(&manager.config_path, original).unwrap();

        let backup_path = manager.takeover("test-token", 12345).unwrap();
        assert!(backup_path.exists());

        manager.restore(Some(&backup_path)).unwrap();

        let content = fs::read_to_string(&manager.config_path).unwrap();
        assert_eq!(content, original);
    }

    #[test]
    fn test_detect_status_taken_over() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        manager.takeover("test-token", 12345).unwrap();

        assert_eq!(manager.detect_status(), DesktopConfigStatus::TakenOver);
    }

}

// ── Tauri commands ──

use crate::db::Database;
use crate::models::ProxySession;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::shared_runtime::session_token::new_session_token;

fn get_desktop_proxy_port(db: &Database) -> i32 {
    db.settings_get()
        .ok()
        .and_then(|s| s.proxy_port.to_string().parse().ok())
        .unwrap_or(12345)
}

#[tauri::command]
pub fn claude_desktop_config_read() -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    let config = mgr.read().map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_desktop_schema_detect() -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    let status = mgr.detect_status();
    match status {
        DesktopConfigStatus::NotFound => Ok("not_found".to_string()),
        DesktopConfigStatus::Unsupported => Ok("unsupported".to_string()),
        DesktopConfigStatus::Official => Ok("official".to_string()),
        DesktopConfigStatus::TakenOver => Ok("taken_over".to_string()),
    }
}

#[tauri::command]
pub fn claude_desktop_config_takeover(
    db: State<'_, Arc<Mutex<Database>>>,
    provider_id: String,
    api_key_id: String,
) -> Result<String, String> {
    let (port, session_token) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let port = get_desktop_proxy_port(&db);
        let session_token = new_session_token();
        let session = ProxySession {
            session_token: session_token.clone(),
            provider_id: provider_id.clone(),
            api_key_id: api_key_id.clone(),
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            cli_type: Some("claude_desktop".to_string()),
        };
        db.proxy_session_create(&session)
            .map_err(|e| format!("创建 session 失败: {}", e))?;
        (port, session_token)
    };
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    mgr.takeover(&session_token, port as u16).map_err(|e| e.to_string())?;
    Ok("接管成功, route 已绑定, config.json 已写入".to_string())
}

#[tauri::command]
pub fn claude_desktop_config_restore(_db: State<'_, Arc<Mutex<Database>>>) -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    mgr.restore(None).map_err(|e| e.to_string())?;
    Ok("已恢复官方配置".to_string())
}

#[tauri::command]
pub fn claude_desktop_config_list_backups() -> Result<Vec<String>, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    let backups = mgr.list_backups().map_err(|e| e.to_string())?;
    Ok(backups.iter().map(|p| p.display().to_string()).collect())
}
