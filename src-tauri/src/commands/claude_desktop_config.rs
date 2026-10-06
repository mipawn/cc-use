//! Claude Desktop 配置级接管
//!
//! 基于 cc-switch 实现的正确路由:写入 profile + meta + deploymentMode
//!
//! ## 接管策略
//!
//! macOS 路径:
//! - `~/Library/Application Support/Claude/claude_desktop_config.json`
//! - `~/Library/Application Support/Claude-3p/claude_desktop_config.json`
//! - `~/Library/Application Support/Claude-3p/configLibrary/<profile-id>.json`
//! - `~/Library/Application Support/Claude-3p/configLibrary/_meta.json`
//!
//! ## 写入内容
//!
//! 1. 两个 claude_desktop_config.json 都设置 `deploymentMode: "3p"`
//! 2. 创建 profile JSON（`inferenceModels` 由目录的角色档生成，见
//!    `inference_models_for_key`；全部为完整 ID 时 Claude Desktop 自动跳过
//!    发现请求，因此不再写 `modelDiscoveryEnabled`）:
//!    ```json
//!    {
//!      "inferenceProvider": "gateway",
//!      "inferenceGatewayBaseUrl": "http://127.0.0.1:12345/claude-desktop",
//!      "inferenceGatewayApiKey": "<route-token>",
//!      "inferenceGatewayAuthScheme": "bearer",
//!      "disableDeploymentModeChooser": true,
//!      "inferenceModels": [{ "name": "claude-opus-5", "labelOverride": "GLM-5.2" }]
//!    }
//!    ```
//! 3. 更新 _meta.json,添加 profile entry 并设置 appliedId

use crate::models::ApiKey;
use crate::shared_runtime::model_mapping;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

const PROFILE_ID: &str = "00000000-0000-4000-8000-000000157210";
const PROFILE_NAME: &str = "CC Use";
const CLAUDE_DESKTOP_PROXY_PREFIX: &str = "/claude-desktop";
const GATEWAY_TOKEN_SETTING_KEY: &str = "claudeDesktopGatewayToken";

/// One entry of the profile's `inferenceModels`. The name is a canonical
/// Claude route id — Claude Desktop only grants effort control and tier
/// resolution to ids it recognizes — while `labelOverride` carries the real
/// model name the person sees in the picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InferenceModelSpec {
    pub name: String,
    pub label_override: Option<String>,
    pub supports_1m: bool,
    /// The provider model this route stands for. Never written to the profile;
    /// it lets the menu dedupe and the alias table be built from one list.
    pub upstream: String,
}

fn inference_model_json(spec: &InferenceModelSpec) -> Value {
    let mut item = json!({ "name": spec.name });
    if let Some(label) = spec.label_override.as_deref() {
        item["labelOverride"] = json!(label);
    }
    if spec.supports_1m {
        item["supports1m"] = json!(true);
    }
    item
}

/// The Desktop menu this key exposes: one canonical route per assigned role,
/// in the stable sonnet/opus/haiku/fable order. A role with no model, or a
/// model the catalog no longer contains, contributes nothing.
pub fn desktop_menu_for_key(
    api_key: &ApiKey,
) -> (
    Vec<InferenceModelSpec>,
    std::collections::BTreeMap<String, String>,
) {
    let entries =
        model_mapping::client_role_entries(api_key.model_mapping.as_deref(), "claude_desktop");
    // Every route stays resolvable — a Desktop session may still ask for a
    // tier whose entry is not listed — while the menu shows one row per model.
    let aliases = entries
        .iter()
        .map(|entry| (entry.route.clone(), entry.upstream.clone()))
        .collect();
    let mut listed = std::collections::HashSet::new();
    let models = entries
        .into_iter()
        .filter(|entry| listed.insert(entry.upstream.clone()))
        .map(|entry| InferenceModelSpec {
            name: entry.route,
            // The route id is not what the person picked, so the picker has to
            // carry the catalog's own name.
            label_override: Some(entry.display_name),
            supports_1m: entry.supports_1m,
            upstream: entry.upstream,
        })
        .collect();
    (models, aliases)
}

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
    #[error("Platform not supported")]
    UnsupportedPlatform,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
struct ClaudeDesktopPaths {
    normal_config_path: PathBuf,
    threep_config_path: PathBuf,
    config_library_path: PathBuf,
    profile_path: PathBuf,
    meta_path: PathBuf,
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    path: PathBuf,
    content: Option<Vec<u8>>,
}

/// Claude Desktop 配置状态
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopConfigStatus {
    NotFound,
    Official,
    TakenOver,
}

/// Claude Desktop 配置管理器
pub struct ClaudeDesktopConfigManager {
    paths: ClaudeDesktopPaths,
}

impl ClaudeDesktopConfigManager {
    /// 创建新的配置管理器
    pub fn new() -> Result<Self, ClaudeDesktopConfigError> {
        let paths = current_platform_paths()?;
        Ok(Self { paths })
    }

    /// 探测配置状态
    pub fn detect_status(&self) -> DesktopConfigStatus {
        if let Some(applied_id) = self.read_applied_id() {
            if applied_id == PROFILE_ID {
                return DesktopConfigStatus::TakenOver;
            }
        }

        if self.paths.profile_path.exists() || self.meta_has_profile_entry() {
            return DesktopConfigStatus::TakenOver;
        }

        if self.paths.normal_config_path.exists() || self.paths.threep_config_path.exists() {
            return DesktopConfigStatus::Official;
        }

        DesktopConfigStatus::NotFound
    }

    /// 接管配置:写入 profile + meta
    pub fn takeover(
        &self,
        route_token: &str,
        proxy_port: u16,
        models: &[InferenceModelSpec],
    ) -> Result<(), ClaudeDesktopConfigError> {
        // 1. 拍摄所有文件快照用于回滚
        let snapshots = self.snapshot_files()?;

        // 2. 尝试写入所有配置
        let result = self.takeover_inner(route_token, proxy_port, models);

        // 3. 失败则回滚
        if result.is_err() {
            let _ = self.restore_snapshots(&snapshots);
        }

        result
    }

    fn takeover_inner(
        &self,
        route_token: &str,
        proxy_port: u16,
        models: &[InferenceModelSpec],
    ) -> Result<(), ClaudeDesktopConfigError> {
        // 1. 写入 deploymentMode: "3p" 到两个配置文件
        self.write_deployment_mode(&self.paths.normal_config_path, "3p")?;
        self.write_deployment_mode(&self.paths.threep_config_path, "3p")?;
        self.sanitize_threep_config_for_takeover()?;

        // 2. 创建 profile
        let profile = self.build_gateway_profile(route_token, proxy_port, models);
        self.write_json_file(&self.paths.profile_path, &profile)?;

        // 3. 更新 _meta.json
        self.write_meta(Some(PROFILE_ID))?;

        Ok(())
    }

    /// 恢复配置:移除 cc-use profile
    pub fn restore(&self) -> Result<(), ClaudeDesktopConfigError> {
        // 1. 拍摄所有文件快照用于回滚
        let snapshots = self.snapshot_files()?;

        // 2. 尝试恢复所有配置
        let result = self.restore_inner();

        // 3. 失败则回滚
        if result.is_err() {
            let _ = self.restore_snapshots(&snapshots);
        }

        result
    }

    fn restore_inner(&self) -> Result<(), ClaudeDesktopConfigError> {
        // 1. 写入 deploymentMode: "1p" 到两个配置文件
        self.write_deployment_mode(&self.paths.normal_config_path, "1p")?;
        self.write_deployment_mode(&self.paths.threep_config_path, "1p")?;

        // 2. 删除 profile 文件
        if self.paths.profile_path.exists() {
            fs::remove_file(&self.paths.profile_path)?;
        }

        // 3. 更新 _meta.json,移除 cc-use profile entry
        self.write_meta(None)?;

        Ok(())
    }

    fn build_gateway_profile(
        &self,
        route_token: &str,
        proxy_port: u16,
        models: &[InferenceModelSpec],
    ) -> Value {
        let mut profile = json!({
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": format!("http://127.0.0.1:{}{}", proxy_port, CLAUDE_DESKTOP_PROXY_PREFIX),
            "inferenceGatewayApiKey": route_token,
            "inferenceGatewayAuthScheme": "bearer",
            "disableDeploymentModeChooser": true,
            "coworkEgressAllowedHosts": ["*"]
        });
        if !models.is_empty() {
            profile["inferenceModels"] =
                Value::Array(models.iter().map(inference_model_json).collect());
        }
        profile
    }

    fn gateway_profile_is_current(
        &self,
        route_token: &str,
        proxy_port: u16,
        models: &[InferenceModelSpec],
    ) -> bool {
        let Ok(content) = fs::read_to_string(&self.paths.profile_path) else {
            return false;
        };
        let Ok(profile) = serde_json::from_str::<Value>(&content) else {
            return false;
        };
        let expected_base_url = format!(
            "http://127.0.0.1:{}{}",
            proxy_port, CLAUDE_DESKTOP_PROXY_PREFIX
        );
        let expected_models = Value::Array(models.iter().map(inference_model_json).collect());

        profile.get("inferenceProvider").and_then(Value::as_str) == Some("gateway")
            && profile
                .get("inferenceGatewayBaseUrl")
                .and_then(Value::as_str)
                == Some(expected_base_url.as_str())
            && profile
                .get("inferenceGatewayApiKey")
                .and_then(Value::as_str)
                == Some(route_token)
            && profile
                .get("inferenceGatewayAuthScheme")
                .and_then(Value::as_str)
                == Some("bearer")
            && match (profile.get("inferenceModels"), models.is_empty()) {
                (None, true) => true,
                (Some(current), false) => current == &expected_models,
                _ => false,
            }
    }

    fn snapshot_files(&self) -> Result<Vec<FileSnapshot>, ClaudeDesktopConfigError> {
        [
            &self.paths.normal_config_path,
            &self.paths.threep_config_path,
            &self.paths.profile_path,
            &self.paths.meta_path,
        ]
        .into_iter()
        .map(|path| {
            let content = if path.exists() {
                Some(fs::read(path)?)
            } else {
                None
            };
            Ok(FileSnapshot {
                path: path.clone(),
                content,
            })
        })
        .collect()
    }

    fn restore_snapshots(
        &self,
        snapshots: &[FileSnapshot],
    ) -> Result<(), ClaudeDesktopConfigError> {
        for snapshot in snapshots {
            match &snapshot.content {
                Some(content) => {
                    if let Some(parent) = snapshot.path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&snapshot.path, content)?;
                }
                None => {
                    if snapshot.path.exists() {
                        fs::remove_file(&snapshot.path)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn write_deployment_mode(
        &self,
        path: &Path,
        mode: &str,
    ) -> Result<(), ClaudeDesktopConfigError> {
        let mut value = self.read_json_or_empty(path)?;
        if !value.is_object() {
            value = json!({});
        }
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "deploymentMode".to_string(),
                Value::String(mode.to_string()),
            );
        }
        self.write_json_file(path, &value)
    }

    fn sanitize_threep_config_for_takeover(&self) -> Result<(), ClaudeDesktopConfigError> {
        let mut value = self.read_json_or_empty(&self.paths.threep_config_path)?;
        if let Some(obj) = value.as_object_mut() {
            // Claude Desktop 1.15200 can hang before creating a window when this
            // legacy flag is carried into the 3P profile.
            obj.remove("isHardwareAccelerationDisabled");
        }
        self.write_json_file(&self.paths.threep_config_path, &value)
    }

    fn write_meta(&self, applied_profile_id: Option<&str>) -> Result<(), ClaudeDesktopConfigError> {
        let mut value = self.read_json_or_empty(&self.paths.meta_path)?;
        if !value.is_object() {
            value = json!({});
        }

        let obj = value.as_object_mut().expect("just normalized to object");
        let mut entries = obj
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        // 移除旧的 cc-use entry
        entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(PROFILE_ID));

        match applied_profile_id {
            Some(id) => {
                // 添加 cc-use entry
                entries.push(json!({
                    "id": PROFILE_ID,
                    "name": PROFILE_NAME
                }));
                obj.insert("appliedId".to_string(), Value::String(id.to_string()));
            }
            None => {
                // 清理 appliedId
                let should_clear_applied = obj
                    .get("appliedId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == PROFILE_ID);

                if should_clear_applied {
                    // 尝试找下一个可用的 profile
                    if let Some(next_id) = entries
                        .iter()
                        .find_map(|entry| entry.get("id").and_then(Value::as_str))
                    {
                        obj.insert("appliedId".to_string(), Value::String(next_id.to_string()));
                    } else {
                        obj.remove("appliedId");
                    }
                }
            }
        }

        obj.insert("entries".to_string(), Value::Array(entries));
        self.write_json_file(&self.paths.meta_path, &value)
    }

    fn read_applied_id(&self) -> Option<String> {
        self.read_json_or_empty(&self.paths.meta_path)
            .ok()
            .and_then(|value| {
                value
                    .get("appliedId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    }

    fn meta_has_profile_entry(&self) -> bool {
        self.read_json_or_empty(&self.paths.meta_path)
            .ok()
            .and_then(|value| value.get("entries").and_then(Value::as_array).cloned())
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.get("id").and_then(Value::as_str) == Some(PROFILE_ID))
            })
    }

    fn read_json_or_empty(&self, path: &Path) -> Result<Value, ClaudeDesktopConfigError> {
        let value = if path.exists() {
            let content = fs::read_to_string(path).map_err(|e| {
                ClaudeDesktopConfigError::ReadError(format!("{}: {}", path.display(), e))
            })?;
            serde_json::from_str(&content).map_err(|e| {
                ClaudeDesktopConfigError::ParseError(format!("{}: {}", path.display(), e))
            })?
        } else {
            json!({})
        };

        if value.is_object() {
            Ok(value)
        } else {
            Ok(json!({}))
        }
    }

    fn write_json_file(&self, path: &Path, value: &Value) -> Result<(), ClaudeDesktopConfigError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(value).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to serialize: {}", e))
        })?;

        let temp_path = path.with_extension("json.tmp");
        fs::write(&temp_path, content).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to write temp file: {}", e))
        })?;

        fs::rename(&temp_path, path).map_err(|e| {
            ClaudeDesktopConfigError::WriteError(format!("Failed to rename temp file: {}", e))
        })?;

        Ok(())
    }

    /// 获取 config library 路径
    pub fn config_library_path(&self) -> PathBuf {
        self.paths.config_library_path.clone()
    }

    fn read_config_preview(&self) -> Value {
        json!({
            "status": self.detect_status(),
            "files": [
                self.preview_file("Claude/claude_desktop_config.json", &self.paths.normal_config_path),
                self.preview_file("Claude-3p/claude_desktop_config.json", &self.paths.threep_config_path),
                self.preview_file("Claude-3p/configLibrary/_meta.json", &self.paths.meta_path),
                self.preview_file(
                    &format!("Claude-3p/configLibrary/{}.json", PROFILE_ID),
                    &self.paths.profile_path,
                ),
            ],
        })
    }

    fn preview_file(&self, label: &str, path: &Path) -> Value {
        if !path.exists() {
            return json!({
                "label": label,
                "path": path.display().to_string(),
                "exists": false,
            });
        }

        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<Value>(&content) {
                Ok(parsed) => json!({
                    "label": label,
                    "path": path.display().to_string(),
                    "exists": true,
                    "json": parsed,
                }),
                Err(error) => json!({
                    "label": label,
                    "path": path.display().to_string(),
                    "exists": true,
                    "parseError": error.to_string(),
                    "content": content,
                }),
            },
            Err(error) => json!({
                "label": label,
                "path": path.display().to_string(),
                "exists": true,
                "readError": error.to_string(),
            }),
        }
    }
}

impl Default for ClaudeDesktopConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to create ClaudeDesktopConfigManager")
    }
}

fn current_platform_paths() -> Result<ClaudeDesktopPaths, ClaudeDesktopConfigError> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| {
            ClaudeDesktopConfigError::NotFound("Could not find home directory".to_string())
        })?;
        let app_support = home.join("Library").join("Application Support");
        return Ok(paths_from_dirs(
            app_support.join("Claude"),
            app_support.join("Claude-3p"),
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(ClaudeDesktopConfigError::UnsupportedPlatform)
    }
}

fn paths_from_dirs(normal_dir: PathBuf, threep_dir: PathBuf) -> ClaudeDesktopPaths {
    let config_library_path = threep_dir.join("configLibrary");
    let profile_path = config_library_path.join(format!("{}.json", PROFILE_ID));
    let meta_path = config_library_path.join("_meta.json");

    ClaudeDesktopPaths {
        normal_config_path: normal_dir.join("claude_desktop_config.json"),
        threep_config_path: threep_dir.join("claude_desktop_config.json"),
        config_library_path,
        profile_path,
        meta_path,
    }
}

// ── Tauri commands ──

use crate::db::Database;
use crate::models::ProxySession;
use crate::shared_runtime::session_token::{new_session_token, SESSION_TOKEN_PREFIX};
use std::sync::{Arc, Mutex};
use tauri::State;

fn get_desktop_proxy_port(db: &Database) -> i32 {
    db.settings_get()
        .ok()
        .and_then(|s| s.proxy_port.to_string().parse().ok())
        .unwrap_or(12345)
}

pub fn refresh_taken_over_profile(db: &Database) -> Result<bool, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    if mgr.read_applied_id().as_deref() != Some(PROFILE_ID) {
        return Ok(false);
    }

    let Some(session_token) = db
        .settings_get_value(GATEWAY_TOKEN_SETTING_KEY)
        .map_err(|e| format!("读取 Claude Desktop 网关 token 失败: {}", e))?
    else {
        return Ok(false);
    };
    let session_token = session_token.trim();
    if !session_token.starts_with(SESSION_TOKEN_PREFIX) {
        return Ok(false);
    }

    let proxy_port = get_desktop_proxy_port(db) as u16;
    let key = db
        .proxy_session_get(session_token)
        .ok()
        .flatten()
        .and_then(|session| db.api_key_get(&session.api_key_id).ok().flatten());
    let (models, aliases) = match key.as_ref() {
        Some(key) => desktop_menu_for_key(key),
        None => (Vec::new(), std::collections::BTreeMap::new()),
    };
    if let Some(key) = key.as_ref() {
        // Desktop skips the discovery request once the profile carries a model
        // list, so this is the only chance to record how its ids decode.
        write_desktop_alias_table(db, &key.id, &aliases)?;
    }
    if mgr.gateway_profile_is_current(session_token, proxy_port, &models) {
        return Ok(false);
    }

    mgr.takeover(session_token, proxy_port, &models)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// The daemon decodes a Desktop request by reading this table, and Desktop
/// never asks for a model list while its profile lists models, so the app has
/// to publish it here.
fn write_desktop_alias_table(
    db: &Database,
    api_key_id: &str,
    aliases: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let key = model_mapping::alias_table_key(api_key_id, "claude_desktop");
    if aliases.is_empty() {
        db.settings_delete_value(&key).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let value = serde_json::to_string(aliases).map_err(|e| e.to_string())?;
    db.settings_set_value(&key, &value)
        .map_err(|e| e.to_string())
}

fn get_or_create_gateway_session_token(db: &Database) -> Result<String, String> {
    if let Some(token) = db
        .settings_get_value(GATEWAY_TOKEN_SETTING_KEY)
        .map_err(|e| format!("读取 Claude Desktop 网关 token 失败: {}", e))?
    {
        let token = token.trim();
        if token.starts_with(SESSION_TOKEN_PREFIX) {
            return Ok(token.to_string());
        }
    }

    let token = new_session_token();
    db.settings_set_value(GATEWAY_TOKEN_SETTING_KEY, &token)
        .map_err(|e| format!("保存 Claude Desktop 网关 token 失败: {}", e))?;
    Ok(token)
}

#[tauri::command]
pub fn claude_desktop_config_read() -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&mgr.read_config_preview()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_desktop_schema_detect() -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    let status = mgr.detect_status();
    match status {
        DesktopConfigStatus::NotFound => Ok("not_found".to_string()),
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
    claude_desktop_config_takeover_inner(&db, provider_id, api_key_id)
}

pub fn claude_desktop_config_takeover_inner(
    db: &Arc<Mutex<Database>>,
    provider_id: String,
    api_key_id: String,
) -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    claude_desktop_config_takeover_with_manager(db, provider_id, api_key_id, &mgr)
}

fn claude_desktop_config_takeover_with_manager(
    db: &Arc<Mutex<Database>>,
    provider_id: String,
    api_key_id: String,
    mgr: &ClaudeDesktopConfigManager,
) -> Result<String, String> {
    let (port, session_token, models) = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let port = get_desktop_proxy_port(&db);
        let api_key = db
            .api_key_get(&api_key_id)
            .map_err(|e| format!("读取密钥失败: {}", e))?
            .ok_or_else(|| "密钥不存在".to_string())?;
        let (models, aliases) = desktop_menu_for_key(&api_key);
        write_desktop_alias_table(&db, &api_key_id, &aliases)?;
        let session_token = get_or_create_gateway_session_token(&db)?;
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
            cli_type: Some("claude_desktop".to_string()),
        };
        db.proxy_session_create(&session)
            .map_err(|e| format!("创建 session 失败: {}", e))?;
        (port, session_token, models)
    };

    mgr.takeover(&session_token, port as u16, &models)
        .map_err(|e| e.to_string())?;

    Ok("接管成功".to_string())
}

#[tauri::command]
pub fn claude_desktop_config_restore(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<String, String> {
    claude_desktop_config_restore_inner(db.inner())
}

pub fn claude_desktop_config_restore_inner(db: &Arc<Mutex<Database>>) -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    mgr.restore().map_err(|e| e.to_string())?;
    let db = db.lock().map_err(|e| e.to_string())?;
    if let Some(token) = db
        .settings_get_value(GATEWAY_TOKEN_SETTING_KEY)
        .map_err(|e| e.to_string())?
    {
        db.proxy_session_revoke(&token, "desktop_restore", &chrono::Utc::now().to_rfc3339())
            .map_err(|e| e.to_string())?;
    }
    db.settings_delete_value(GATEWAY_TOKEN_SETTING_KEY)
        .map_err(|e| e.to_string())?;
    Ok("已恢复官方配置".to_string())
}

#[tauri::command]
pub fn claude_desktop_config_list_backups() -> Result<Vec<String>, String> {
    // Claude Desktop 使用快照机制,不需要单独的备份列表
    Ok(Vec::new())
}

#[tauri::command]
pub fn claude_desktop_get_config_library_path() -> Result<String, String> {
    let mgr = ClaudeDesktopConfigManager::new().map_err(|e| e.to_string())?;
    Ok(mgr.config_library_path().display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CreateApiKeyInput, CreateProviderInput};
    use tempfile::TempDir;

    fn create_test_paths(temp_dir: &Path) -> ClaudeDesktopPaths {
        paths_from_dirs(temp_dir.join("Claude"), temp_dir.join("Claude-3p"))
    }

    fn key_with_mapping(mapping: &str) -> ApiKey {
        ApiKey {
            id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            alias: None,
            value: "sk-test".to_string(),
            types: vec!["claude_desktop".to_string()],
            priority: 0,
            is_exhausted: false,
            is_active: true,
            config: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            model_mapping: Some(mapping.to_string()),
            client_configs: None,
            usage_script: None,
        }
    }

    #[test]
    fn assigned_roles_become_canonical_routes_with_labels_and_1m() {
        let mapping = r#"{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2","displayName":"GLM 5.2","supports1m":true},{"id":"deepseek-v4.1-flash","displayName":"V4"}],"roles":{"sonnet":"glm-5.2","opus":"deepseek-v4.1-flash"}},"upstream":{"mode":"follow"}}}}"#;
        let (specs, aliases) = desktop_menu_for_key(&key_with_mapping(mapping));
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].name, "claude-sonnet-5");
        assert_eq!(specs[0].label_override.as_deref(), Some("GLM 5.2"));
        assert!(specs[0].supports_1m);
        assert_eq!(specs[1].name, "claude-opus-5");
        assert_eq!(specs[1].label_override.as_deref(), Some("V4"));
        assert!(!specs[1].supports_1m);
        // Every route resolves, including the ones the menu does not list.
        assert_eq!(aliases["claude-sonnet-5"], "glm-5.2");
        assert_eq!(aliases["claude-opus-5"], "deepseek-v4.1-flash");

        let shared = r#"{"version":2,"clients":{"claude_desktop":{"catalog":{"mode":"custom","models":[{"id":"glm-5.2","displayName":"GLM 5.2"}],"roles":{"sonnet":"glm-5.2","opus":"glm-5.2","haiku":"glm-5.2"}},"upstream":{"mode":"follow"}}}}"#;
        let (deduped, aliases) = desktop_menu_for_key(&key_with_mapping(shared));
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].name, "claude-sonnet-5");
        assert_eq!(aliases["claude-haiku-4-5"], "glm-5.2");
    }

    #[test]
    fn profile_tracks_assigned_roles_and_reports_drift() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        let mgr = ClaudeDesktopConfigManager { paths };
        let models = vec![InferenceModelSpec {
            name: "claude-sonnet-5".to_string(),
            label_override: Some("GLM 5.2".to_string()),
            supports_1m: true,
            upstream: "glm-5.2".to_string(),
        }];

        mgr.takeover("test-token", 12345, &models).unwrap();

        let profile: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.profile_path).unwrap()).unwrap();
        assert_eq!(profile["inferenceModels"][0]["name"], "claude-sonnet-5");
        assert_eq!(profile["inferenceModels"][0]["labelOverride"], "GLM 5.2");
        assert_eq!(profile["inferenceModels"][0]["supports1m"], true);
        assert!(profile.get("modelDiscoveryEnabled").is_none());

        assert!(mgr.gateway_profile_is_current("test-token", 12345, &models));
        assert!(!mgr.gateway_profile_is_current("test-token", 12345, &[]));
        assert!(!mgr.gateway_profile_is_current(
            "test-token",
            12345,
            &[InferenceModelSpec {
                name: "claude-opus-5".to_string(),
                label_override: None,
                supports_1m: false,
                upstream: "glm-5.2".to_string(),
            }]
        ));
    }

    #[test]
    fn test_detect_status_not_found() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        let mgr = ClaudeDesktopConfigManager { paths };

        assert_eq!(mgr.detect_status(), DesktopConfigStatus::NotFound);
    }

    #[test]
    fn test_takeover_creates_profile() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        let mgr = ClaudeDesktopConfigManager { paths };

        mgr.takeover("test-token", 12345, &[]).unwrap();

        // 检查 profile 文件
        assert!(mgr.paths.profile_path.exists());
        let profile: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.profile_path).unwrap()).unwrap();

        assert_eq!(
            profile.get("inferenceProvider").and_then(Value::as_str),
            Some("gateway")
        );
        assert_eq!(
            profile
                .get("inferenceGatewayBaseUrl")
                .and_then(Value::as_str),
            Some("http://127.0.0.1:12345/claude-desktop")
        );
        assert_eq!(
            profile
                .get("inferenceGatewayApiKey")
                .and_then(Value::as_str),
            Some("test-token")
        );
        // 没有指派角色时不写模型列表，也不写发现开关：Desktop 回到默认发现。
        assert!(profile.get("modelDiscoveryEnabled").is_none());
        assert!(profile.get("inferenceModels").is_none());

        // 检查 meta 文件
        let meta: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.meta_path).unwrap()).unwrap();

        assert_eq!(
            meta.get("appliedId").and_then(Value::as_str),
            Some(PROFILE_ID)
        );

        // 检查 deploymentMode
        let normal_config: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.normal_config_path).unwrap())
                .unwrap();
        assert_eq!(
            normal_config.get("deploymentMode").and_then(Value::as_str),
            Some("3p")
        );
        assert!(mgr.gateway_profile_is_current("test-token", 12345, &[]));
        assert!(!mgr.gateway_profile_is_current("other-token", 12345, &[]));
        assert!(!mgr.gateway_profile_is_current("test-token", 23456, &[]));
    }

    #[test]
    fn test_legacy_fixed_model_profile_needs_refresh() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        fs::create_dir_all(&paths.config_library_path).unwrap();
        fs::write(
            &paths.profile_path,
            serde_json::to_vec_pretty(&json!({
                "inferenceProvider": "gateway",
                "inferenceGatewayBaseUrl": "http://127.0.0.1:12345/claude-desktop",
                "inferenceGatewayApiKey": "test-token",
                "inferenceGatewayAuthScheme": "bearer",
                "modelDiscoveryEnabled": true,
                "inferenceModels": [
                    { "name": "claude-opus-4-8", "labelOverride": "claude-opus-4-6" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let mgr = ClaudeDesktopConfigManager { paths };

        assert!(!mgr.gateway_profile_is_current("test-token", 12345, &[]));
    }

    #[test]
    fn test_takeover_does_not_probe_provider_or_require_running_daemon() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        let mgr = ClaudeDesktopConfigManager { paths };
        let db = Database::new_in_memory().unwrap();
        let provider = db
            .provider_create(&CreateProviderInput {
                request_headers: None,
                wallet_balance_script: None,
                name: "No Probe Provider".to_string(),
                base_url: "http://127.0.0.1:1".to_string(),
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
                preset_id: None,
                default_key_config: None,
                request_adapter: None,
            })
            .unwrap();
        let api_key = db
            .api_key_create(&CreateApiKeyInput {
                usage_script: None,
                provider_id: provider.id.clone(),
                alias: Some("Claude Desktop".to_string()),
                value: "sk-test".to_string(),
                types: Some(vec!["claude_desktop".to_string()]),
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
        let db = Arc::new(Mutex::new(db));

        let result = claude_desktop_config_takeover_with_manager(
            &db,
            provider.id.clone(),
            api_key.id.clone(),
            &mgr,
        );

        assert_eq!(result.as_deref(), Ok("接管成功"));
        assert_eq!(mgr.detect_status(), DesktopConfigStatus::TakenOver);
        let db = db.lock().unwrap();
        let session_token = db
            .settings_get_value(GATEWAY_TOKEN_SETTING_KEY)
            .unwrap()
            .unwrap();
        let session = db.proxy_session_get(&session_token).unwrap().unwrap();
        assert_eq!(session.provider_id, provider.id);
        assert_eq!(session.api_key_id, api_key.id);
    }

    #[test]
    fn test_restore_removes_profile() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());
        let mgr = ClaudeDesktopConfigManager { paths };

        mgr.takeover(
            "test-token",
            12345,
            &[InferenceModelSpec {
                name: "claude-sonnet-5".to_string(),
                label_override: Some("GLM 5.2".to_string()),
                supports_1m: false,
                upstream: "glm-5.2".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(mgr.detect_status(), DesktopConfigStatus::TakenOver);

        let profile: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.profile_path).unwrap()).unwrap();
        assert_eq!(profile["inferenceModels"][0]["name"], "claude-sonnet-5");

        mgr.restore().unwrap();

        assert!(!mgr.paths.profile_path.exists());
        assert_eq!(mgr.detect_status(), DesktopConfigStatus::Official);

        // 检查 deploymentMode
        let normal_config: Value =
            serde_json::from_str(&fs::read_to_string(&mgr.paths.normal_config_path).unwrap())
                .unwrap();
        assert_eq!(
            normal_config.get("deploymentMode").and_then(Value::as_str),
            Some("1p")
        );
    }

    #[test]
    fn test_takeover_rollback_on_failure() {
        let temp_dir = TempDir::new().unwrap();
        let paths = create_test_paths(temp_dir.path());

        // 创建一个只读的配置目录来触发失败
        fs::create_dir_all(&paths.config_library_path).unwrap();

        // 在 Unix 上设置只读权限
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &paths.config_library_path,
                std::fs::Permissions::from_mode(0o444),
            )
            .unwrap();
        }

        let mgr = ClaudeDesktopConfigManager {
            paths: paths.clone(),
        };
        let result = mgr.takeover("test-token", 12345, &[]);

        // 恢复权限以便清理
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(
                &paths.config_library_path,
                std::fs::Permissions::from_mode(0o755),
            );
        }

        // Windows 不易模拟权限失败,跳过验证
        #[cfg(unix)]
        {
            assert!(result.is_err());
            // 确保回滚:profile 不应该存在
            assert!(!paths.profile_path.exists());
        }
    }
}
