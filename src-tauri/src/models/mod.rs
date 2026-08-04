use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Provider ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub http_proxy: Option<String>,
    pub website: Option<String>,
    pub remark: Option<String>,
    pub token: Option<String>,
    pub icon: Option<String>,
    // Balance
    pub wallet_balance_type: String,
    pub wallet_balance_url: Option<String>,
    pub wallet_balance_path: Option<String>,
    pub wallet_balance_headers: Option<String>,
    pub wallet_balance_user_id: Option<String>,
    pub cached_wallet_balance: Option<f64>,
    pub last_balance_checked_at: Option<String>,
    // Usage
    pub usage_type: String,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub cached_usage: Option<UsageData>,
    pub last_usage_checked_at: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProviderInput {
    pub name: String,
    pub base_url: String,
    pub http_proxy: Option<String>,
    pub website: Option<String>,
    pub remark: Option<String>,
    pub token: Option<String>,
    pub icon: Option<String>,
    pub wallet_balance_type: Option<String>,
    pub wallet_balance_url: Option<String>,
    pub wallet_balance_path: Option<String>,
    pub wallet_balance_headers: Option<String>,
    pub wallet_balance_user_id: Option<String>,
    pub usage_type: Option<String>,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProviderInput {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub http_proxy: Option<String>,
    pub website: Option<String>,
    pub remark: Option<String>,
    pub token: Option<String>,
    pub icon: Option<String>,
    pub wallet_balance_type: Option<String>,
    pub wallet_balance_url: Option<String>,
    pub wallet_balance_path: Option<String>,
    pub wallet_balance_headers: Option<String>,
    pub wallet_balance_user_id: Option<String>,
    pub usage_type: Option<String>,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub is_active: Option<bool>,
    pub cached_wallet_balance: Option<f64>,
    pub last_balance_checked_at: Option<String>,
    pub cached_usage: Option<UsageData>,
    pub last_usage_checked_at: Option<String>,
}

// ── API Key ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: String,
    pub provider_id: String,
    pub alias: Option<String>,
    pub value: String,
    pub types: Vec<String>,
    pub priority: i32,
    pub is_exhausted: bool,
    pub is_active: bool,
    pub config: Option<serde_json::Value>,
    // Key-level usage
    pub usage_type: String,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub cached_usage: Option<UsageData>,
    pub last_usage_checked_at: Option<String>,
    pub model_mapping: Option<String>,
    pub client_configs: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyInput {
    pub provider_id: String,
    pub alias: Option<String>,
    pub value: String,
    pub types: Option<Vec<String>>,
    pub priority: Option<i32>,
    pub is_active: Option<bool>,
    pub config: Option<serde_json::Value>,
    pub usage_type: Option<String>,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub model_mapping: Option<String>,
    pub client_configs: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApiKeyInput {
    pub id: String,
    pub alias: Option<String>,
    pub value: Option<String>,
    pub types: Option<Vec<String>>,
    pub priority: Option<i32>,
    pub is_exhausted: Option<bool>,
    pub is_active: Option<bool>,
    pub config: Option<serde_json::Value>,
    pub usage_type: Option<String>,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub cached_usage: Option<UsageData>,
    pub last_usage_checked_at: Option<String>,
    pub model_mapping: Option<String>,
    pub client_configs: Option<serde_json::Value>,
}

// ── Project ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub group_name: Option<String>,
    pub remark: Option<String>,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub cli_type: String,
    pub terminal_type: String,
    pub prelaunch_command: Option<String>,
    pub last_opened_at: Option<String>,
    pub bindings: HashMap<String, ProjectClientBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectClientBinding {
    pub cli_type: String,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub terminal_type: String,
    pub prelaunch_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProjectBindingInput {
    pub cli_type: String,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub terminal_type: Option<String>,
    pub prelaunch_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub path: String,
    pub group_name: Option<String>,
    pub remark: Option<String>,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub cli_type: Option<String>,
    pub terminal_type: Option<String>,
    pub prelaunch_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub id: String,
    pub name: Option<String>,
    pub group_name: Option<String>,
    pub remark: Option<String>,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub cli_type: Option<String>,
    pub terminal_type: Option<String>,
    pub prelaunch_command: Option<String>,
}

// ── Settings ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub default_provider_type: String,
    pub proxy_port: i32,
    pub default_terminal_type: String,
    pub close_to_tray: bool,
    /// Whether the local daemon should run. When false, the daemon is not
    /// started on launch and is not auto-restarted by the watchdog.
    pub daemon_enabled: bool,
    pub claude_config: Option<serde_json::Value>,
    pub codex_config: Option<serde_json::Value>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            default_provider_type: "claude".to_string(),
            proxy_port: 12345,
            default_terminal_type: "iterm2".to_string(),
            close_to_tray: true,
            daemon_enabled: true,
            claude_config: None,
            codex_config: None,
        }
    }
}

// ── Proxy ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub is_running: bool,
    pub port: i32,
    pub request_count: i32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySession {
    pub session_token: String,
    pub provider_id: String,
    pub api_key_id: String,
    pub project_id: Option<String>,
    pub created_at: String,
    pub session_kind: String,
    pub last_seen_at: String,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_reason: Option<String>,
    // Client marker used by config-takeover routing and request logging.
    pub cli_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunchPreview {
    pub cli_type: String,
    pub env: std::collections::HashMap<String, String>,
    pub command: String,
    pub prelaunch_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedInstance {
    pub id: String,
    pub session_token: String,
    pub project_id: Option<String>,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub cli_type: String,
    pub terminal_type: String,
    pub project_path: String,
    pub shell_pid: Option<i32>,
    pub process_pid: Option<i32>,
    pub status: String,
    pub assignment_source: Option<String>,
    pub last_seen_at: String,
    pub launched_at: String,
    pub stopped_at: Option<String>,
    pub stop_reason: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManagedInstanceAssignmentInput {
    pub id: String,
    pub provider_id: String,
    pub api_key_id: String,
    pub assignment_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedInstanceHeartbeatInput {
    pub instance_id: String,
    pub shell_pid: Option<i32>,
    pub process_pid: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedInstanceStopInput {
    pub instance_id: String,
    pub shell_pid: Option<i32>,
    pub process_pid: Option<i32>,
    pub stop_reason: Option<String>,
    pub exit_code: Option<i32>,
}

// ── Usage ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: Option<String>,
    pub is_unlimited: Option<bool>,
    pub expire_at: Option<String>,
}

// ── Usage Log ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLog {
    pub id: String,
    pub project_id: Option<String>,
    pub project_name: String,
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub api_key_id: Option<String>,
    pub api_key_alias: Option<String>,
    pub key_type: Option<String>,
    pub launched_at: String,
    pub duration: Option<i64>,
}

// ── Request Log ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub id: String,
    pub provider_id: Option<String>,
    pub api_key_id: Option<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub request_model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub latency_ms: Option<i64>,
    pub first_token_ms: Option<i64>,
    pub status_code: Option<i32>,
    pub error_message: Option<String>,
    /// v3.7.0: `success` | `client_error` | `upstream_error` | `transport_error`.
    /// See `docs/v3.7.0/failed-request-logging.md`.
    pub outcome: Option<String>,
    pub is_streaming: bool,
    pub created_at: String,
    // Snapshot columns — preserve display names after entity deletion
    pub key_alias: Option<String>,
    pub provider_name: Option<String>,
    pub project_name: Option<String>,
}

// ── Statistics ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub total_launches: i64,
    pub unique_projects: i64,
    pub unique_keys: i64,
    pub by_project: Vec<ProjectUsageCount>,
    pub by_key: Vec<KeyUsageCount>,
    pub by_date: Vec<DateCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageCount {
    pub project_id: String,
    pub project_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsageCount {
    pub key_id: String,
    pub key_alias: String,
    pub provider_name: String,
    pub key_type: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateCount {
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsSummary {
    /// Billable requests (carried tokens).
    pub total_requests: i64,
    /// Requests with outcome != success, counted over the full log.
    pub failed_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_creation_tokens: i64,
    /// input + output + cache_read + cache_creation.
    pub total_tokens: i64,
    /// cache_read / (input + cache_read + cache_creation); 0 when no input side.
    pub cache_hit_rate: f64,
    pub avg_latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTrendItem {
    pub date: String,
    /// All four buckets combined.
    pub tokens: i64,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureStatsItem {
    pub provider_name: String,
    pub key_alias: String,
    pub status_code: Option<i32>,
    pub outcome: String,
    pub count: i64,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDimensionItem {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub tokens: i64,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRequestLogDisplay {
    pub id: String,
    pub model: Option<String>,
    pub key_alias: Option<String>,
    pub provider_name: Option<String>,
    pub project_name: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub latency_ms: Option<i64>,
    pub status_code: Option<i32>,
    pub outcome: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedRecentRequests {
    pub items: Vec<RecentRequestLogDisplay>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatistics {
    pub summary: UsageStatsSummary,
    pub daily_trend: Vec<DailyTrendItem>,
    pub key_usage: Vec<UsageDimensionItem>,
    pub project_usage: Vec<UsageDimensionItem>,
    pub failures: Vec<FailureStatsItem>,
}

/// Dashboard overview: a compact view of today's activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub today_tokens: i64,
    pub today_requests: i64,
    pub today_failed_requests: i64,
}

#[derive(Debug, Clone)]
pub struct GatewayRequestEvent {
    pub id: String,
    pub created_at: String,
    pub kind: String,
    pub method: String,
    pub path: String,
    pub status_code: Option<i32>,
    pub latency_ms: Option<i64>,
    pub provider_name: Option<String>,
    pub key_alias: Option<String>,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayMetricsWindow {
    pub window: String,
    pub total_requests: i64,
    pub successful_requests: i64,
    pub upstream_errors: i64,
    pub rejected_requests: i64,
    pub active_providers: i64,
    pub avg_latency_ms: Option<f64>,
    pub p95_latency_ms: Option<i64>,
    pub last_request_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentGatewayMetrics {
    pub windows: Vec<GatewayMetricsWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGatewayMetrics {
    pub provider_name: String,
    pub total_requests: i64,
    pub successful_requests: i64,
    pub upstream_errors: i64,
    pub avg_latency_ms: Option<f64>,
    pub last_request_at: Option<String>,
}

// ── Import/Export ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    pub version: String,
    pub exported_at: String,
    pub providers: Vec<ExportProvider>,
    #[serde(default)]
    pub usage_logs: Vec<UsageLog>,
    #[serde(default)]
    pub request_logs: Vec<RequestLog>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProvider {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    pub http_proxy: Option<String>,
    pub website: Option<String>,
    pub remark: Option<String>,
    pub icon: Option<String>,
    pub wallet_balance_type: Option<String>,
    pub wallet_balance_url: Option<String>,
    pub wallet_balance_path: Option<String>,
    pub wallet_balance_headers: Option<String>,
    pub usage_type: Option<String>,
    pub usage_url: Option<String>,
    pub usage_path: Option<String>,
    pub usage_headers: Option<String>,
    pub api_keys: Vec<ExportApiKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportApiKey {
    #[serde(default)]
    pub id: String,
    pub alias: Option<String>,
    pub value: String,
    #[serde(default)]
    pub types: Option<Vec<String>>,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub overwrite: bool,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub include_providers: bool,
    #[serde(default)]
    pub include_api_keys: bool,
    pub include_usage_logs: bool,
    pub include_request_logs: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_providers: true,
            include_api_keys: false,
            include_usage_logs: true,
            include_request_logs: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: i32,
    pub skipped: i32,
    pub errors: Vec<String>,
}

// ── Migration ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCheck {
    pub needed: bool,
    pub electron_db_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub success: bool,
    pub providers: i32,
    pub api_keys: i32,
    pub projects: i32,
    pub request_logs: i32,
    pub usage_logs: i32,
}

// ── Claude Session ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub session_id: String,
    pub project_path: String,
    pub jsonl_size: u64,
    pub dir_size: u64,
    pub total_size: u64,
    pub last_modified: i64,
    pub message_count: usize,
    pub first_message: Option<String>,
}
