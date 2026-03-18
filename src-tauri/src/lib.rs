pub mod commands;
pub mod db;
pub mod models;
pub mod proxy;
pub mod services;
pub mod terminal;
pub mod tray;

use db::Database;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, LogicalSize, Manager, Size};

pub fn run() {
    let db = Database::new().expect("Failed to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(Mutex::new(db)))
        .invoke_handler(tauri::generate_handler![
            // Provider commands
            commands::providers::provider_list,
            commands::providers::provider_get,
            commands::providers::provider_create,
            commands::providers::provider_update,
            commands::providers::provider_delete,
            // API Key commands
            commands::api_keys::api_key_list,
            commands::api_keys::api_key_create,
            commands::api_keys::api_key_update,
            commands::api_keys::api_key_delete,
            commands::api_keys::api_key_reorder,
            // Project commands
            commands::projects::project_list,
            commands::projects::project_get,
            commands::projects::project_get_by_path,
            commands::projects::project_create,
            commands::projects::project_update,
            commands::projects::project_delete,
            commands::projects::project_open,
            // Settings commands
            commands::settings::settings_get,
            commands::settings::settings_update,
            // System commands
            commands::system::system_get_platform,
            commands::system::system_open_external,
            // Statistics commands
            commands::statistics::usage_log_get_stats,
            commands::statistics::usage_log_get_recent,
            commands::statistics::usage_log_today_quick_stats,
            commands::statistics::request_log_get_cost_stats,
            commands::statistics::request_log_get_key_costs,
            commands::statistics::request_log_get_daily_trend,
            commands::statistics::request_log_get_cost_statistics,
            commands::statistics::request_log_get_dashboard_stats,
            commands::statistics::model_pricing_get_all,
            commands::statistics::model_pricing_get_custom,
            commands::statistics::model_pricing_update_custom,
            commands::statistics::model_pricing_get_default,
            // Balance commands
            commands::balance::balance_refresh,
            commands::balance::usage_refresh,
            commands::balance::key_usage_refresh,
            commands::balance::provider_sync_pricing,
            commands::balance::provider_update_pricing,
            // Import/Export commands
            commands::import_export::export_providers,
            commands::import_export::import_providers,
            commands::import_export::validate_import_data,
            commands::import_export::export_to_file,
            commands::import_export::import_from_file,
            commands::import_export::check_electron_migration,
            commands::import_export::migrate_from_electron,
            // Proxy commands
            commands::proxy::proxy_start,
            commands::proxy::proxy_stop,
            commands::proxy::proxy_status,
            commands::proxy::session_create,
            commands::proxy::session_get,
            commands::proxy::session_update_key,
            commands::proxy::session_update_by_project,
            commands::proxy::session_delete,
            commands::proxy::session_list,
            // Terminal commands
            commands::terminal::terminal_launch,
            commands::terminal::terminal_launch_with_path,
            // Icon commands
            commands::system::icon_upload,
            commands::system::icon_list,
            // App commands
            commands::system::app_get_version,
        ])
        .setup(|app| {
            // Keep legacy behavior: close button hides to tray by default unless user explicitly changed it.
            let should_init_close_to_tray = {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                let has_no_setting = match db_state.lock() {
                    Ok(db) => db.settings_get_value("closeToTray").ok().flatten().is_none(),
                    Err(_) => false,
                };
                has_no_setting
            };
            if should_init_close_to_tray {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.lock() {
                    let _ = db.settings_set_value("closeToTray", "true");
                };
            }

            // Ensure dev/prod can run side-by-side without proxy port collision.
            let should_init_proxy_port = {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                let has_no_setting = match db_state.lock() {
                    Ok(db) => db.settings_get_value("proxyPort").ok().flatten().is_none(),
                    Err(_) => false,
                };
                has_no_setting
            };
            if should_init_proxy_port {
                let default_port = if cfg!(debug_assertions) { "22345" } else { "12345" };
                let db_state = app.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.lock() {
                    let _ = db.settings_set_value("proxyPort", default_port);
                };
            }

            // Keep legacy behavior: auto start proxy is enabled by default unless user explicitly changed it.
            let should_init_auto_start_proxy = {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                let has_no_setting = match db_state.lock() {
                    Ok(db) => db.settings_get_value("autoStartProxy").ok().flatten().is_none(),
                    Err(_) => false,
                };
                has_no_setting
            };
            if should_init_auto_start_proxy {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.lock() {
                    let _ = db.settings_set_value("autoStartProxy", "true");
                };
            }

            let handle = app.handle().clone();

            // Keep legacy startup geometry: fixed default size + minimum size + centered.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_size(Size::Logical(LogicalSize::new(1200.0, 800.0)));
                let _ = win.set_min_size(Some(Size::Logical(LogicalSize::new(900.0, 600.0))));
                let _ = win.center();
            }

            // Setup system tray
            if let Err(e) = tray::setup_tray(&handle) {
                log::error!("Failed to setup tray: {}", e);
            }

            // Check if Electron migration is available
            {
                let electron_path = Database::get_electron_db_path();
                let migrated_marker = electron_path.with_extension("db.migrated");
                let migration_needed = electron_path.exists() && !migrated_marker.exists();

                if migration_needed {
                    let handle_migration = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        // Small delay to ensure frontend is ready to listen
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let _ = handle_migration.emit("app:migrationAvailable", true);
                    });
                }
            }

            // Auto-start proxy if configured
            let handle2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                let db_state = handle2.state::<Arc<Mutex<Database>>>();
                let should_start = {
                    let db = db_state.lock().unwrap();
                    db.settings_get()
                        .map(|s| s.auto_start_proxy)
                        .unwrap_or(false)
                };
                if should_start {
                    let _ = commands::proxy::proxy_start_inner(&*db_state).await;
                    tray::refresh_tray_menu(&handle2);
                }
            });

            // Handle close-to-tray: intercept window close event
            let handle3 = handle.clone();
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if tray::should_close_to_tray(&handle3) {
                            api.prevent_close();
                            if let Some(w) = handle3.get_webview_window("main") {
                                #[cfg(target_os = "macos")]
                                {
                                    let _ = handle3.set_dock_visibility(false);
                                }
                                let _ = w.hide();
                            }
                            tray::refresh_tray_menu(&handle3);
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
