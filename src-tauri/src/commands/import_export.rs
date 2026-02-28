use crate::db::Database;
use crate::models::{ExportData, ImportOptions, ImportResult, MigrationCheck, MigrationResult};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn export_providers(db: State<'_, Mutex<Database>>) -> Result<ExportData, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    crate::services::import_export::export_all(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_providers(
    db: State<'_, Mutex<Database>>,
    data: ExportData,
    options: Option<ImportOptions>,
) -> Result<ImportResult, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let opts = options.unwrap_or(ImportOptions { overwrite: false });
    crate::services::import_export::import_all(&db, &data, &opts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn validate_import_data(data: serde_json::Value) -> Result<bool, String> {
    Ok(crate::services::import_export::validate(&data))
}

#[tauri::command]
pub fn check_electron_migration(_db: State<'_, Mutex<Database>>) -> Result<MigrationCheck, String> {
    let electron_path = Database::get_electron_db_path();
    // Check if old DB exists and hasn't been migrated yet
    let electron_exists = electron_path.exists();
    let migrated_marker = electron_path.with_extension("db.migrated");
    let already_migrated = migrated_marker.exists();

    Ok(MigrationCheck {
        needed: electron_exists && !already_migrated,
        electron_db_path: electron_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn migrate_from_electron(db: State<'_, Mutex<Database>>) -> Result<MigrationResult, String> {
    let electron_path = Database::get_electron_db_path();
    if !electron_path.exists() {
        return Err("Electron database not found".to_string());
    }

    // Open the old Electron DB (read-only)
    let old_db = Database::open_at(&electron_path)
        .map_err(|e| format!("Failed to open Electron DB: {}", e))?;

    // Get current DB lock
    let new_db = db.lock().map_err(|e| e.to_string())?;

    // Migrate data table by table
    migrate_table(&old_db, &new_db, "providers")?;
    migrate_table(&old_db, &new_db, "api_keys")?;
    migrate_table(&old_db, &new_db, "projects")?;
    migrate_table(&old_db, &new_db, "settings")?;
    migrate_table(&old_db, &new_db, "usage_logs")?;
    migrate_table(&old_db, &new_db, "request_logs")?;
    migrate_table(&old_db, &new_db, "proxy_sessions")?;

    // Get migration stats
    let (providers, api_keys, projects, request_logs, usage_logs) = new_db.get_migration_stats();

    // Mark as migrated by creating a marker file (keep original DB intact)
    drop(old_db);
    drop(new_db);
    let migrated_marker = electron_path.with_extension("db.migrated");
    std::fs::write(&migrated_marker, "migrated")
        .map_err(|e| format!("Failed to mark migration complete: {}", e))?;

    Ok(MigrationResult {
        success: true,
        providers,
        api_keys,
        projects,
        request_logs,
        usage_logs,
    })
}

fn migrate_table(
    old_db: &Database,
    new_db: &Database,
    table_name: &str,
) -> Result<(), String> {
    // Get all column names from the new DB schema
    let columns: Vec<String> = new_db
        .conn
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(|e| format!("Failed to get table info for {}: {}", table_name, e))?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query table info: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    if columns.is_empty() {
        return Ok(()); // Table doesn't exist in new schema, skip
    }

    // Get all rows from old DB
    let column_list = columns.join(", ");
    let mut stmt = old_db
        .conn
        .prepare(&format!("SELECT {} FROM {}", column_list, table_name))
        .map_err(|e| format!("Failed to prepare select for {}: {}", table_name, e))?;

    let rows: Vec<Vec<rusqlite::types::Value>> = stmt
        .query_map([], |row| {
            let mut values = Vec::new();
            for i in 0..columns.len() {
                values.push(row.get::<_, rusqlite::types::Value>(i)?);
            }
            Ok(values)
        })
        .map_err(|e| format!("Failed to query {}: {}", table_name, e))?
        .filter_map(|r| r.ok())
        .collect();

    // Insert into new DB
    let placeholders = (0..columns.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let insert_sql = format!(
        "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
        table_name, column_list, placeholders
    );

    for row_values in rows {
        new_db
            .conn
            .execute(
                &insert_sql,
                rusqlite::params_from_iter(row_values.iter()),
            )
            .map_err(|e| format!("Failed to insert into {}: {}", table_name, e))?;
    }

    Ok(())
}
