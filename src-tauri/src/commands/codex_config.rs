//! Codex Desktop 配置级接管
//!
//! 基于 cc-switch preserve 模式(线上验证):key 写进 config.toml 的
//! `experimental_bearer_token`(per-provider 或顶层),**不碰 `auth.json`**
//! 以保留官方 ChatGPT OAuth 登录(及依赖它的插件能力)。
//!
//! ## 接管策略
//!
//! - **不写 `auth.json`**(保住用户的官方登录/OAuth tokens)
//! - 写 `~/.codex/config.toml`:
//!   - `model_provider = "cc-use"`
//!   - `[model_providers.cc-use]`:base_url 指向 daemon、wire_api="responses"
//!   - `experimental_bearer_token = "<session-token>"`(写进 cc-use 表或顶层)
//! - 保留用户其他配置(mcp_servers / projects / marketplaces 等)
//! - 接管前备份 config.toml/auth.json 到带时间戳子目录,恢复时还原
//!
//! ## 写入内容(参考 cc-switch)
//!
//! `config.toml`:
//! ```toml
//! model_provider = "cc-use"
//! model = "gpt-5.5"
//! model_reasoning_effort = "high"
//! disable_response_storage = true
//!
//! [model_providers.cc-use]
//! name = "CC Use"
//! base_url = "http://127.0.0.1:<proxy_port>/v1"
//! wire_api = "responses"
//! experimental_bearer_token = "session-xxxx"
//! ```
//!
//! **不设 `requires_openai_auth = true`**(那会让 Codex 走 auth.json 的
//! OAuth 直连官方,忽略我们的 base_url)。bearer token 走 Authorization
//! header,daemon 识别 `session-` 前缀路由到对应 provider。
//!
//! 适配点:`cli_type = "codex-app"` session 用于标记 Codex Desktop
//! 接管请求；请求会按原始路径转发到当前 provider。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
use toml_edit::DocumentMut;

const CC_USE_PROVIDER_KEY: &str = "cc-use";
/// 默认钉死的 Codex 模型(Codex Desktop 当前主力模型)。
const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";
const DEEPSEEK_CODEX_MODEL: &str = "deepseek-v4-flash";
const DEEPSEEK_CODEX_CATALOG: &str = include_str!("../../resources/deepseek-codex-models.json");

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
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_interval_ms: Option<u64>,
    #[serde(flatten)]
    pub other: HashMap<String, toml::Value>,
}

/// Codex 配置管理器
pub struct CodexConfigManager {
    config_path: PathBuf,
    auth_path: PathBuf,
    backup_dir: PathBuf,
    model_catalog_path: PathBuf,
    model_catalog_state_path: PathBuf,
}

impl CodexConfigManager {
    /// 创建新的配置管理器
    pub fn new() -> Result<Self, CodexConfigError> {
        let home = dirs::home_dir().ok_or_else(|| {
            CodexConfigError::NotFound("Could not find home directory".to_string())
        })?;

        let codex_dir = home.join(".codex");
        let config_path = codex_dir.join("config.toml");
        let auth_path = codex_dir.join("auth.json");
        let backup_dir = home.join(".cc-use").join("backups").join("codex");
        let runtime_dir = home.join(".cc-use").join("runtime");

        Ok(Self {
            config_path,
            auth_path,
            backup_dir,
            model_catalog_path: runtime_dir.join("codex-deepseek-models.json"),
            model_catalog_state_path: runtime_dir.join("codex-model-catalog-state.json"),
        })
    }

    /// 读取当前配置文本
    fn read_text(&self) -> Result<String, CodexConfigError> {
        if !self.config_path.exists() {
            return Ok(String::new());
        }

        fs::read_to_string(&self.config_path).map_err(|e| {
            CodexConfigError::ReadError(format!("{}: {}", self.config_path.display(), e))
        })
    }

    /// 读取当前配置
    pub fn read(&self) -> Result<CodexConfig, CodexConfigError> {
        let text = self.read_text()?;
        if text.trim().is_empty() {
            return Ok(CodexConfig {
                model_provider: None,
                model_providers: None,
                other: HashMap::new(),
            });
        }

        toml::from_str(&text).map_err(|e| {
            CodexConfigError::ParseError(format!("{}: {}", self.config_path.display(), e))
        })
    }

    /// 备份当前 config.toml/auth.json 到带时间戳的子目录,返回该目录路径。
    /// 任一文件不存在则跳过该文件。
    pub fn backup(&self) -> Result<PathBuf, CodexConfigError> {
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let dir = self.backup_dir.join(&timestamp);
        fs::create_dir_all(&dir)?;

        if self.config_path.exists() {
            fs::copy(&self.config_path, dir.join("config.toml")).map_err(|e| {
                CodexConfigError::BackupError(format!("Failed to backup config.toml: {}", e))
            })?;
        }
        if self.auth_path.exists() {
            fs::copy(&self.auth_path, dir.join("auth.json")).map_err(|e| {
                CodexConfigError::BackupError(format!("Failed to backup auth.json: {}", e))
            })?;
        }
        Ok(dir)
    }

    /// 最新的备份目录(用于恢复)
    fn latest_backup_dir(&self) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(&self.backup_dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        dirs.pop()
    }

    /// 接管配置:写入 cc-use provider + experimental_bearer_token
    pub fn takeover(
        &self,
        session_token: &str,
        proxy_port: u16,
    ) -> Result<PathBuf, CodexConfigError> {
        self.takeover_with_profile(session_token, proxy_port, DEFAULT_CODEX_MODEL, false)
    }

    /// 接管配置,可指定钉死的 model
    pub fn takeover_with_model(
        &self,
        session_token: &str,
        proxy_port: u16,
        model: &str,
    ) -> Result<PathBuf, CodexConfigError> {
        self.takeover_with_profile(session_token, proxy_port, model, false)
    }

    /// 接管配置并选择是否启用 cc-use 托管的 DeepSeek Codex 模型目录。
    pub fn takeover_with_profile(
        &self,
        session_token: &str,
        proxy_port: u16,
        model: &str,
        use_deepseek_catalog: bool,
    ) -> Result<PathBuf, CodexConfigError> {
        // 1. 读取原配置文本
        let original_text = self.read_text()?;

        // 2. 备份(仅在尚未被接管时,避免把已接管状态覆盖成基线)
        let backup_path = {
            let is_taken = self.is_taken_over_inner(&original_text)?;
            if !is_taken && (self.config_path.exists() || self.auth_path.exists()) {
                Some(self.backup()?)
            } else {
                None
            }
        };

        // 3. 确保 ~/.codex 目录存在
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 4. 用 toml_edit 修改 config.toml(保留用户其他配置)
        let mut doc = if original_text.trim().is_empty() {
            DocumentMut::new()
        } else {
            original_text
                .parse::<DocumentMut>()
                .map_err(|e| CodexConfigError::ParseError(format!("Invalid TOML: {}", e)))?
        };

        // 5. 顶层字段
        doc["model_provider"] = toml_edit::value(CC_USE_PROVIDER_KEY);
        doc["model"] = toml_edit::value(model);
        doc["model_reasoning_effort"] = toml_edit::value("high");
        doc["disable_response_storage"] = toml_edit::value(true);
        let mut clear_catalog_state_after_write = false;
        if use_deepseek_catalog {
            self.remember_original_model_catalog(&doc)?;
            self.write_deepseek_model_catalog()?;
            doc["model_catalog_json"] =
                toml_edit::value(self.model_catalog_path.to_string_lossy().to_string());
        } else if self.is_our_model_catalog(&doc) {
            self.restore_original_model_catalog(&mut doc)?;
            clear_catalog_state_after_write = true;
        }

        // 6. 确保 [model_providers] 存在
        if doc.get("model_providers").is_none() {
            doc["model_providers"] = toml_edit::table();
        }

        // 7. 写入 [model_providers.cc-use](含 experimental_bearer_token)
        if let Some(providers) = doc["model_providers"].as_table_mut() {
            let mut cc_use_table = toml_edit::Table::new();
            cc_use_table["name"] = toml_edit::value("CC Use");
            cc_use_table["base_url"] =
                toml_edit::value(format!("http://127.0.0.1:{}/v1", proxy_port));
            cc_use_table["wire_api"] = toml_edit::value("responses");
            cc_use_table["experimental_bearer_token"] = toml_edit::value(session_token);
            // 不设 requires_openai_auth — 那会让 Codex 走 OAuth 直连官方
            providers[CC_USE_PROVIDER_KEY] = toml_edit::Item::Table(cc_use_table);
        }

        // 8. 原子写入 config.toml
        write_atomic(&self.config_path, &doc.to_string())?;
        if clear_catalog_state_after_write {
            let _ = fs::remove_file(&self.model_catalog_state_path);
        }

        Ok(backup_path.unwrap_or_else(|| PathBuf::from("")))
    }

    fn write_deepseek_model_catalog(&self) -> Result<(), CodexConfigError> {
        if let Some(parent) = self.model_catalog_path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(&self.model_catalog_path, DEEPSEEK_CODEX_CATALOG)
    }

    fn is_our_model_catalog(&self, doc: &DocumentMut) -> bool {
        doc.get("model_catalog_json")
            .and_then(|item| item.as_str())
            .is_some_and(|path| Path::new(path) == self.model_catalog_path)
    }

    fn remember_original_model_catalog(&self, doc: &DocumentMut) -> Result<(), CodexConfigError> {
        if self.model_catalog_state_path.exists() || self.is_our_model_catalog(doc) {
            return Ok(());
        }
        if let Some(parent) = self.model_catalog_state_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let original = doc
            .get("model_catalog_json")
            .and_then(|item| item.as_str())
            .map(ToOwned::to_owned);
        let serialized = serde_json::to_string(&original)
            .map_err(|error| CodexConfigError::WriteError(error.to_string()))?;
        write_atomic(&self.model_catalog_state_path, &serialized)
    }

    fn restore_original_model_catalog(
        &self,
        doc: &mut DocumentMut,
    ) -> Result<(), CodexConfigError> {
        let original = if self.model_catalog_state_path.exists() {
            let text = fs::read_to_string(&self.model_catalog_state_path)?;
            serde_json::from_str::<Option<String>>(&text)
                .map_err(|error| CodexConfigError::ParseError(error.to_string()))?
        } else {
            None
        };
        match original {
            Some(path) => doc["model_catalog_json"] = toml_edit::value(path),
            None => {
                doc.as_table_mut().remove("model_catalog_json");
            }
        }
        Ok(())
    }

    /// 恢复配置:优先从最新备份还原 config.toml/auth.json;
    /// 无备份时移除 cc-use provider 并清空被覆写字段。
    pub fn restore(&self, backup_path: Option<&Path>) -> Result<(), CodexConfigError> {
        let dir = backup_path
            .map(|p| p.to_path_buf())
            .or_else(|| self.latest_backup_dir());

        if let Some(dir) = dir.filter(|d| d.is_dir()) {
            // 从备份目录还原
            let backup_config = dir.join("config.toml");
            if backup_config.exists() {
                fs::copy(&backup_config, &self.config_path)?;
            } else {
                self.strip_cc_use_from_config()?;
            }
            let backup_auth = dir.join("auth.json");
            if backup_auth.exists() {
                if let Some(parent) = self.auth_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(&backup_auth, &self.auth_path)?;
            }
            self.cleanup_deepseek_runtime();
            return Ok(());
        }

        // 无备份:移除 cc-use 痕迹
        self.strip_cc_use_from_config()?;
        self.cleanup_deepseek_runtime();
        Ok(())
    }

    fn cleanup_deepseek_runtime(&self) {
        let _ = fs::remove_file(&self.model_catalog_path);
        let _ = fs::remove_file(&self.model_catalog_state_path);
    }

    /// 从 config.toml 移除 cc-use provider 及被我们覆写的顶层字段
    fn strip_cc_use_from_config(&self) -> Result<(), CodexConfigError> {
        let original_text = self.read_text()?;
        if original_text.trim().is_empty() {
            return Ok(());
        }

        let mut doc = original_text
            .parse::<DocumentMut>()
            .map_err(|e| CodexConfigError::ParseError(format!("Invalid TOML: {}", e)))?;

        if doc
            .get("model_provider")
            .and_then(|item: &toml_edit::Item| item.as_str())
            == Some(CC_USE_PROVIDER_KEY)
        {
            let table = doc.as_table_mut();
            table.remove("model_provider");
            table.remove("model");
            table.remove("model_reasoning_effort");
            table.remove("disable_response_storage");
        }
        if self.is_our_model_catalog(&doc) {
            doc.as_table_mut().remove("model_catalog_json");
        }

        if let Some(providers) = doc
            .get_mut("model_providers")
            .and_then(|item: &mut toml_edit::Item| item.as_table_mut())
        {
            providers.remove(CC_USE_PROVIDER_KEY);
            if providers.is_empty() {
                doc.as_table_mut().remove("model_providers");
            }
        }

        write_atomic(&self.config_path, &doc.to_string())
    }

    /// 列出所有备份目录
    pub fn list_backups(&self) -> Result<Vec<PathBuf>, CodexConfigError> {
        if !self.backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups: Vec<PathBuf> = fs::read_dir(&self.backup_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();

        backups.sort();
        backups.reverse(); // 最新的在前

        Ok(backups)
    }

    /// 检查是否已接管(内部版本,接受文本)
    fn is_taken_over_inner(&self, text: &str) -> Result<bool, CodexConfigError> {
        if text.trim().is_empty() {
            return Ok(false);
        }

        let doc = text
            .parse::<DocumentMut>()
            .map_err(|e| CodexConfigError::ParseError(format!("Invalid TOML: {}", e)))?;

        let has_provider = doc
            .get("model_provider")
            .and_then(|item: &toml_edit::Item| item.as_str())
            == Some(CC_USE_PROVIDER_KEY);

        let has_provider_table = doc
            .get("model_providers")
            .and_then(|item: &toml_edit::Item| item.as_table())
            .and_then(|table| table.get(CC_USE_PROVIDER_KEY))
            .is_some();

        Ok(has_provider && has_provider_table)
    }

    /// 检查是否已接管
    pub fn is_taken_over(&self) -> Result<bool, CodexConfigError> {
        let text = self.read_text()?;
        self.is_taken_over_inner(&text)
    }

    /// config 是否已是「当前 token 的接管」。保留旧接口供兼容和测试使用。
    pub fn matches_takeover_token(&self, token: &str) -> Result<bool, CodexConfigError> {
        let text = self.read_text()?;
        if text.trim().is_empty() {
            return Ok(false);
        }
        let doc = text
            .parse::<DocumentMut>()
            .map_err(|e| CodexConfigError::ParseError(format!("Invalid TOML: {}", e)))?;
        let provider_table = doc
            .get("model_providers")
            .and_then(|item: &toml_edit::Item| item.as_table())
            .and_then(|table| table.get(CC_USE_PROVIDER_KEY))
            .and_then(|item: &toml_edit::Item| item.as_table());
        let bearer = provider_table
            .and_then(|table| table.get("experimental_bearer_token"))
            .and_then(|item: &toml_edit::Item| item.as_str());
        Ok(bearer == Some(token))
    }

    pub fn matches_takeover_profile(
        &self,
        token: &str,
        proxy_port: u16,
        model: &str,
        use_deepseek_catalog: bool,
    ) -> Result<bool, CodexConfigError> {
        let text = self.read_text()?;
        if text.trim().is_empty() {
            return Ok(false);
        }
        let doc = text
            .parse::<DocumentMut>()
            .map_err(|e| CodexConfigError::ParseError(format!("Invalid TOML: {}", e)))?;
        let provider_table = doc
            .get("model_providers")
            .and_then(|item| item.as_table())
            .and_then(|table| table.get(CC_USE_PROVIDER_KEY))
            .and_then(|item| item.as_table());
        let bearer = provider_table
            .and_then(|table| table.get("experimental_bearer_token"))
            .and_then(|item| item.as_str());
        let base_url = provider_table
            .and_then(|table| table.get("base_url"))
            .and_then(|item| item.as_str());
        let configured_model = doc.get("model").and_then(|item| item.as_str());
        let catalog_matches = self.is_our_model_catalog(&doc) == use_deepseek_catalog;
        let catalog_file_ready = !use_deepseek_catalog || self.model_catalog_path.is_file();
        let expected_base_url = format!("http://127.0.0.1:{}/v1", proxy_port);

        Ok(bearer == Some(token)
            && base_url == Some(expected_base_url.as_str())
            && configured_model == Some(model)
            && catalog_matches
            && catalog_file_ready)
    }
}

impl Default for CodexConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to create CodexConfigManager")
    }
}

/// 原子写入文件(临时文件 + rename)
fn write_atomic(path: &Path, content: &str) -> Result<(), CodexConfigError> {
    let temp_path = path.with_extension("cc-use.tmp");

    fs::write(&temp_path, content)
        .map_err(|e| CodexConfigError::WriteError(format!("Failed to write temp file: {}", e)))?;

    fs::rename(&temp_path, path)
        .map_err(|e| CodexConfigError::WriteError(format!("Failed to rename temp file: {}", e)))?;

    Ok(())
}

// ── Tauri commands ──

use crate::db::Database;
use crate::models::{ApiKey, Provider, ProxySession};
use std::sync::{Arc, Mutex};
use tauri::State;

fn get_proxy_port(db: &Database) -> i32 {
    db.settings_get()
        .ok()
        .and_then(|s| s.proxy_port.to_string().parse().ok())
        .unwrap_or(12345)
}

use crate::shared_runtime::session_token::{new_session_token, CODEX_SESSION_TOKEN_SETTING_KEY};

fn is_builtin_deepseek_provider(provider: &Provider) -> bool {
    if provider.icon.as_deref() != Some("deepseek") {
        return false;
    }
    url::Url::parse(&provider.base_url)
        .ok()
        .and_then(|url| url.host_str().map(ToOwned::to_owned))
        .is_some_and(|host| host == "api.deepseek.com")
}

fn codex_model_from_mapping(api_key: &ApiKey) -> Option<String> {
    api_key
        .model_mapping
        .as_deref()
        .and_then(|mapping| serde_json::from_str::<serde_json::Value>(mapping).ok())
        .and_then(|mapping| {
            mapping
                .get("codex")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
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
    codex_config_takeover_inner(&db, provider_id, api_key_id)
}

pub fn codex_config_takeover_inner(
    db: &Arc<Mutex<Database>>,
    provider_id: String,
    api_key_id: String,
) -> Result<String, String> {
    // 固定的 Codex session token 持久化在 settings 里。token 不随 provider/key
    // 变化；同一模型目录类型内切换密钥只更新 daemon session。
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;

    let (port, session_token, use_deepseek_catalog, codex_model) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let port = get_proxy_port(&db);
        let provider = db
            .provider_get(&provider_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "供应商不存在".to_string())?;
        let api_key = db
            .api_key_get(&api_key_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "API 密钥不存在".to_string())?;
        if api_key.provider_id != provider_id {
            return Err("API 密钥不属于所选供应商".to_string());
        }
        if !api_key.types.iter().any(|kind| kind == "codex") {
            return Err("所选 API 密钥未启用 Codex Desktop".to_string());
        }
        let use_deepseek_catalog = is_builtin_deepseek_provider(&provider);
        let codex_model = if use_deepseek_catalog {
            codex_model_from_mapping(&api_key).unwrap_or_else(|| DEEPSEEK_CODEX_MODEL.to_string())
        } else {
            DEFAULT_CODEX_MODEL.to_string()
        };

        // 复用已存的固定 token,否则生成并持久化。
        let session_token = match db.settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY) {
            Ok(Some(t)) if !t.trim().is_empty() => t,
            _ => {
                let t = new_session_token();
                db.settings_set_value(CODEX_SESSION_TOKEN_SETTING_KEY, &t)
                    .map_err(|e| format!("保存 session token 失败: {}", e))?;
                t
            }
        };

        // upsert proxy_session:已存在则只改 provider/key 指向(切换密钥),
        // 否则创建。daemon 每次请求按 token 查表,下个请求即走新 provider/key。
        if db
            .proxy_session_get(&session_token)
            .ok()
            .flatten()
            .is_some()
        {
            db.proxy_session_update_provider_key_cli_type(
                &session_token,
                &provider_id,
                &api_key_id,
                "codex-app",
            )
            .map_err(|e| format!("更新 session 失败: {}", e))?;
        } else {
            let now = chrono::Utc::now().to_rfc3339();
            let session = ProxySession {
                session_token: session_token.clone(),
                provider_id: provider_id.clone(),
                api_key_id: api_key_id.clone(),
                project_id: None,
                created_at: now.clone(),
                session_kind: "desktop".to_string(),
                last_seen_at: now,
                expires_at: None,
                revoked_at: None,
                revoked_reason: None,
                cli_type: Some("codex-app".to_string()),
            };
            db.proxy_session_create(&session)
                .map_err(|e| format!("创建 session 失败: {}", e))?;
        }
        (port, session_token, use_deepseek_catalog, codex_model)
    };

    // token、base_url、可见模型和模型目录都相同才只切 daemon 指向。
    // 普通线路与 DeepSeek 线路互切需要重写启动时目录并提示重启。
    let already_current = mgr
        .matches_takeover_profile(
            &session_token,
            port as u16,
            &codex_model,
            use_deepseek_catalog,
        )
        .map_err(|e| e.to_string())?;
    if already_current {
        Ok("已切换密钥,无需重启 Codex".to_string())
    } else {
        mgr.takeover_with_profile(
            &session_token,
            port as u16,
            &codex_model,
            use_deepseek_catalog,
        )
        .map_err(|e| e.to_string())?;
        if use_deepseek_catalog {
            Ok(
                "接管完成；请完全退出并重新打开 Codex Desktop，模型选择器将显示“自定义”"
                    .to_string(),
            )
        } else {
            Ok("接管完成,请重启 Codex Desktop 加载新配置".to_string())
        }
    }
}

#[tauri::command]
pub fn codex_config_restore(db: State<'_, Arc<Mutex<Database>>>) -> Result<String, String> {
    codex_config_restore_inner(db.inner())
}

pub fn codex_config_restore_inner(db: &Arc<Mutex<Database>>) -> Result<String, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    mgr.restore(None).map_err(|e| e.to_string())?;
    let db = db.lock().map_err(|e| e.to_string())?;
    if let Some(token) = db
        .settings_get_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .map_err(|e| e.to_string())?
    {
        db.proxy_session_revoke(&token, "desktop_restore", &chrono::Utc::now().to_rfc3339())
            .map_err(|e| e.to_string())?;
    }
    db.settings_delete_value(CODEX_SESSION_TOKEN_SETTING_KEY)
        .map_err(|e| e.to_string())?;
    Ok("已恢复官方配置,请重启 Codex Desktop 生效".to_string())
}

#[tauri::command]
pub fn codex_config_list_backups() -> Result<Vec<String>, String> {
    let mgr = CodexConfigManager::new().map_err(|e| e.to_string())?;
    let backups = mgr.list_backups().map_err(|e| e.to_string())?;
    Ok(backups.iter().map(|p| p.display().to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_manager() -> (CodexConfigManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".codex").join("config.toml");
        let auth_path = temp_dir.path().join(".codex").join("auth.json");
        let backup_dir = temp_dir
            .path()
            .join(".cc-use")
            .join("backups")
            .join("codex");
        let runtime_dir = temp_dir.path().join(".cc-use").join("runtime");

        let manager = CodexConfigManager {
            config_path,
            auth_path,
            backup_dir,
            model_catalog_path: runtime_dir.join("codex-deepseek-models.json"),
            model_catalog_state_path: runtime_dir.join("codex-model-catalog-state.json"),
        };

        (manager, temp_dir)
    }

    #[test]
    fn test_takeover_writes_bearer_token_into_config() {
        let (manager, _temp) = create_test_manager();

        manager.takeover("session-abc123", 22345).unwrap();

        let text = fs::read_to_string(&manager.config_path).unwrap();
        assert!(text.contains("model_provider = \"cc-use\""));
        assert!(text.contains("model = \"gpt-5.5\""));
        assert!(text.contains("disable_response_storage = true"));
        assert!(text.contains("[model_providers.cc-use]"));
        assert!(text.contains("base_url = \"http://127.0.0.1:22345/v1\""));
        assert!(text.contains("wire_api = \"responses\""));
        assert!(text.contains("experimental_bearer_token = \"session-abc123\""));
        // 不设 requires_openai_auth(那会让 Codex 走 OAuth 直连官方)
        assert!(!text.contains("requires_openai_auth"));
    }

    #[test]
    fn test_takeover_does_not_touch_auth_json() {
        let (manager, _temp) = create_test_manager();
        fs::create_dir_all(manager.auth_path.parent().unwrap()).unwrap();
        let original_auth = r#"{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": { "access_token": "real-oauth" },
  "last_refresh": "2026-06-26T00:00:00Z"
}"#;
        fs::write(&manager.auth_path, original_auth).unwrap();

        manager.takeover("session-keep", 22345).unwrap();

        assert_eq!(
            fs::read_to_string(&manager.auth_path).unwrap(),
            original_auth
        );
        let cfg = fs::read_to_string(&manager.config_path).unwrap();
        assert!(cfg.contains("experimental_bearer_token = \"session-keep\""));
        assert!(!cfg.contains("requires_openai_auth"));
    }

    #[test]
    fn test_matches_takeover_token() {
        let (manager, _temp) = create_test_manager();
        manager.takeover("session-fixed", 22345).unwrap();

        assert!(manager.matches_takeover_token("session-fixed").unwrap());
        assert!(!manager.matches_takeover_token("session-other").unwrap());
    }

    #[test]
    fn test_deepseek_takeover_writes_managed_catalog_and_restores_previous_catalog() {
        let (manager, _temp) = create_test_manager();
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        fs::write(
            &manager.config_path,
            "model_catalog_json = \"/custom/models.json\"\n",
        )
        .unwrap();

        manager
            .takeover_with_profile("session-deepseek", 22345, DEEPSEEK_CODEX_MODEL, true)
            .unwrap();

        let deepseek_config = fs::read_to_string(&manager.config_path).unwrap();
        assert!(deepseek_config.contains("model = \"deepseek-v4-flash\""));
        assert!(deepseek_config.contains(manager.model_catalog_path.to_string_lossy().as_ref()));
        let catalog = fs::read_to_string(&manager.model_catalog_path).unwrap();
        assert!(catalog.contains("\"slug\": \"deepseek-v4-flash\""));
        assert!(manager
            .matches_takeover_profile("session-deepseek", 22345, DEEPSEEK_CODEX_MODEL, true,)
            .unwrap());
        fs::remove_file(&manager.model_catalog_path).unwrap();
        assert!(!manager
            .matches_takeover_profile("session-deepseek", 22345, DEEPSEEK_CODEX_MODEL, true,)
            .unwrap());

        manager
            .takeover_with_profile("session-deepseek", 22345, DEFAULT_CODEX_MODEL, false)
            .unwrap();
        let normal_config = fs::read_to_string(&manager.config_path).unwrap();
        assert!(normal_config.contains("model_catalog_json = \"/custom/models.json\""));
        assert!(!manager.model_catalog_state_path.exists());
    }

    #[test]
    fn test_takeover_preserves_other_config_file_content() {
        let (manager, _temp) = create_test_manager();

        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original = r#"
some_other_field = "value"

[mcp_servers.node_repl]
command = "/x/node_repl"
"#;
        fs::write(&manager.config_path, original).unwrap();

        manager.takeover("session-abc", 12345).unwrap();

        let text = fs::read_to_string(&manager.config_path).unwrap();
        assert!(text.contains("some_other_field"));
        assert!(text.contains("[mcp_servers.node_repl]"));
        assert!(text.contains("[model_providers.cc-use]"));
        assert!(text.contains("experimental_bearer_token"));
    }

    #[test]
    fn test_restore_strips_cc_use_when_no_prior_config() {
        let (manager, _temp) = create_test_manager();

        manager.takeover("session-abc", 12345).unwrap();
        assert!(manager.is_taken_over().unwrap());

        manager.restore(None).unwrap();

        let text = fs::read_to_string(&manager.config_path).unwrap();
        assert!(!text.contains("model_provider = \"cc-use\""));
        assert!(!text.contains("[model_providers.cc-use]"));
        assert!(!text.contains("model = \"gpt-5.5\""));
        assert!(!text.contains("requires_openai_auth"));
    }

    #[test]
    fn test_backup_and_restore_roundtrip() {
        let (manager, _temp) = create_test_manager();

        // 原始 config.toml
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        let original_config = "model_provider = \"openai\"\n";
        fs::write(&manager.config_path, original_config).unwrap();
        let original_auth = r#"{"tokens":{"id_token":"oauth"}}"#;
        fs::write(&manager.auth_path, original_auth).unwrap();

        // 接管(自动备份)
        manager.takeover("session-xyz", 22345).unwrap();
        assert!(fs::read_to_string(&manager.config_path)
            .unwrap()
            .contains("experimental_bearer_token = \"session-xyz\""));
        fs::write(&manager.auth_path, r#"{"OPENAI_API_KEY":"session-bad"}"#).unwrap();

        // 恢复:从备份还原
        manager.restore(None).unwrap();

        assert_eq!(
            fs::read_to_string(&manager.config_path).unwrap(),
            original_config
        );
        assert_eq!(
            fs::read_to_string(&manager.auth_path).unwrap(),
            original_auth
        );
    }

    #[test]
    fn test_restore_without_backup_leaves_auth_json_alone() {
        let (manager, _temp) = create_test_manager();
        fs::create_dir_all(manager.config_path.parent().unwrap()).unwrap();
        fs::write(
            &manager.config_path,
            r#"
model_provider = "cc-use"

[model_providers.cc-use]
experimental_bearer_token = "session-old"
"#,
        )
        .unwrap();
        let original_auth = r#"{"OPENAI_API_KEY":"sk-real-user-key"}"#;
        fs::write(&manager.auth_path, original_auth).unwrap();

        manager
            .restore(Some(manager.backup_dir.join("missing").as_path()))
            .unwrap();

        assert_eq!(
            fs::read_to_string(&manager.auth_path).unwrap(),
            original_auth
        );
    }

    #[test]
    fn test_is_taken_over() {
        let (manager, _temp) = create_test_manager();

        assert!(!manager.is_taken_over().unwrap());

        manager.takeover("session-abc", 12345).unwrap();
        assert!(manager.is_taken_over().unwrap());

        manager.restore(None).unwrap();
        assert!(!manager.is_taken_over().unwrap());
    }
}
