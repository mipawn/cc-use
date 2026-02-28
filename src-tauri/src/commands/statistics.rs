use crate::db::Database;
use crate::models::{CostStatistics, DashboardCostStats, UsageStats, ModelPricing};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn usage_log_get_stats(
    db: State<'_, Mutex<Database>>,
    time_range: String,
) -> Result<UsageStats, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_get_stats(&time_range).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_log_get_recent(
    db: State<'_, Mutex<Database>>,
    limit: Option<i64>,
) -> Result<Vec<crate::models::UsageLog>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_get_recent(limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_log_today_quick_stats(
    db: State<'_, Mutex<Database>>,
) -> Result<serde_json::Value, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.usage_log_today_quick_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_cost_stats(
    db: State<'_, Mutex<Database>>,
) -> Result<serde_json::Value, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_cost_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_key_costs(
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_key_costs().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_daily_trend(
    db: State<'_, Mutex<Database>>,
    days: Option<i64>,
) -> Result<Vec<crate::models::DailyCostTrendItem>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_daily_trend(days.unwrap_or(30)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_cost_statistics(
    db: State<'_, Mutex<Database>>,
    time_range: String,
) -> Result<CostStatistics, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_cost_statistics(&time_range).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_log_get_dashboard_stats(
    db: State<'_, Mutex<Database>>,
) -> Result<DashboardCostStats, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.request_log_get_dashboard_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_pricing_get_all(
    db: State<'_, Mutex<Database>>,
) -> Result<HashMap<String, ModelPricing>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let custom = get_custom_pricing(&db)?;
    let mut all = crate::services::cost_calculator::default_pricing();
    all.extend(custom);
    Ok(all)
}

#[tauri::command]
pub fn model_pricing_get_custom(
    db: State<'_, Mutex<Database>>,
) -> Result<HashMap<String, ModelPricing>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    get_custom_pricing(&db)
}

#[tauri::command]
pub fn model_pricing_update_custom(
    db: State<'_, Mutex<Database>>,
    pricing: HashMap<String, ModelPricing>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&pricing).map_err(|e| e.to_string())?;
    db.settings_set_value("customModelPricing", &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_pricing_get_default() -> Result<HashMap<String, ModelPricing>, String> {
    Ok(crate::services::cost_calculator::default_pricing())
}

fn get_custom_pricing(db: &Database) -> Result<HashMap<String, ModelPricing>, String> {
    match db.settings_get_value("customModelPricing").map_err(|e| e.to_string())? {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        None => Ok(HashMap::new()),
    }
}
