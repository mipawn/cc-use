use crate::db::Database;
use crate::models::{
    PaginatedRecentRequests, ProviderGatewayMetrics, RecentGatewayMetrics, ResourceUsageStatistics,
    UsageOverview, UsageStatistics, UsageStats,
};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
pub fn usage_log_get_stats(
    db: State<'_, Arc<Mutex<Database>>>,
    time_range: String,
) -> Result<UsageStats, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_get_stats(&time_range)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_log_get_recent(
    db: State<'_, Arc<Mutex<Database>>>,
    limit: Option<i64>,
) -> Result<Vec<crate::models::UsageLog>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_get_recent(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_log_today_quick_stats(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<serde_json::Value, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_today_quick_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_daily_trend(
    db: State<'_, Arc<Mutex<Database>>>,
    days: Option<i64>,
) -> Result<Vec<crate::models::DailyTrendItem>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_daily_trend(days.unwrap_or(30))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_statistics(
    db: State<'_, Arc<Mutex<Database>>>,
    time_range: String,
) -> Result<UsageStatistics, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_statistics(&time_range)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_resource_statistics(
    db: State<'_, Arc<Mutex<Database>>>,
    time_range: String,
    provider_id: Option<String>,
    api_key_id: Option<String>,
) -> Result<ResourceUsageStatistics, String> {
    if provider_id.is_none() && api_key_id.is_none() {
        return Err("A provider or API key scope is required".to_string());
    }
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_resource_statistics(
        &time_range,
        provider_id.as_deref(),
        api_key_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_recent_paginated(
    db: State<'_, Arc<Mutex<Database>>>,
    time_range: String,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<PaginatedRecentRequests, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_recent_paginated(&time_range, page.unwrap_or(1), page_size.unwrap_or(10))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_monthly_trend(
    db: State<'_, Arc<Mutex<Database>>>,
    year: i64,
    month: i64,
) -> Result<Vec<crate::models::DailyTrendItem>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_monthly_trend(year, month)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_overview(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<UsageOverview, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_overview().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_key_token_stats(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_key_token_stats()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_metrics_get_recent(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<RecentGatewayMetrics, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.gateway_metrics_recent().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_metrics_get_by_provider(
    db: State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<ProviderGatewayMetrics>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.gateway_metrics_by_provider().map_err(|e| e.to_string())
}
