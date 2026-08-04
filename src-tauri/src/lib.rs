pub mod auto_launch;
pub mod commands;
pub mod daemon_client;
pub mod db;
pub mod models;
pub mod proxy;
pub mod services;
pub mod shared_runtime;
pub mod statusline_config;
pub mod terminal;
pub mod tray;
pub mod usage_stats;

use db::Database;
use models::ProxyStatus;
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Arc::new(Mutex::new(db)))
        .invoke_handler(tauri::generate_handler![
            // Provider commands
            commands::providers::provider_list,
            commands::providers::provider_get,
            commands::providers::provider_create,
            commands::providers::provider_update,
            commands::providers::provider_delete,
            commands::providers::provider_reorder,
            commands::providers::provider_model_list,
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
            commands::projects::project_binding_upsert,
            commands::projects::project_delete,
            commands::projects::project_open,
            // Settings commands
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::delete_setting,
            // System commands
            commands::system::system_get_platform,
            commands::system::system_open_external,
            // Statistics commands
            commands::statistics::usage_log_get_stats,
            commands::statistics::usage_log_get_recent,
            commands::statistics::usage_log_today_quick_stats,
            commands::statistics::request_log_get_daily_trend,
            commands::statistics::request_log_get_monthly_trend,
            commands::statistics::request_log_get_statistics,
            commands::statistics::request_log_get_recent_paginated,
            commands::statistics::request_log_get_overview,
            commands::statistics::request_log_get_key_token_stats,
            // CLI tool + statusline (v3.7.0)
            commands::cli_tool::cli_tool_status,
            commands::cli_tool::cli_tool_install,
            commands::cli_tool::cli_tool_uninstall,
            commands::cli_tool::statusline_status,
            commands::cli_tool::statusline_enable,
            commands::cli_tool::statusline_restore,
            commands::statistics::gateway_metrics_get_recent,
            commands::statistics::gateway_metrics_get_by_provider,
            // Balance commands
            commands::balance::balance_refresh,
            commands::balance::usage_refresh,
            commands::balance::key_usage_refresh,
            // Import/Export commands
            commands::import_export::export_providers,
            commands::import_export::import_providers,
            commands::import_export::validate_import_data,
            commands::import_export::export_to_file,
            commands::import_export::import_from_file,
            commands::import_export::check_electron_migration,
            commands::import_export::migrate_from_electron,
            // Proxy commands
            commands::proxy::proxy_restart,
            commands::proxy::proxy_status,
            commands::proxy::proxy_start,
            commands::proxy::proxy_stop,
            commands::proxy::console_detail_mode_set,
            commands::proxy::session_create,
            commands::proxy::session_get,
            commands::proxy::session_update_key,
            commands::proxy::session_update_by_project,
            commands::proxy::session_delete,
            commands::proxy::session_list,
            // Terminal commands
            commands::terminal::terminal_launch,
            commands::terminal::terminal_launch_with_path,
            commands::terminal::terminal_get_launch_preview,
            commands::terminal::terminal_prepare_grok_config,
            // Session commands
            commands::sessions::scan_sessions,
            commands::sessions::delete_sessions,
            commands::sessions::clean_old_sessions,
            commands::sessions::keep_recent_sessions,
            // Managed instance commands
            commands::managed_instances::managed_instance_list,
            commands::managed_instances::managed_instance_get,
            commands::managed_instances::managed_instance_update_assignment,
            commands::managed_instances::managed_instance_cleanup,
            // Icon commands
            commands::system::icon_upload,
            commands::system::icon_list,
            // Codex config commands
            commands::codex_config::codex_config_read,
            commands::codex_config::codex_config_is_taken_over,
            commands::codex_config::codex_config_takeover,
            commands::codex_config::codex_config_restore,
            commands::codex_config::codex_config_list_backups,
            // Claude Desktop config commands
            commands::claude_desktop_config::claude_desktop_config_read,
            commands::claude_desktop_config::claude_desktop_schema_detect,
            commands::claude_desktop_config::claude_desktop_config_takeover,
            commands::claude_desktop_config::claude_desktop_config_restore,
            commands::claude_desktop_config::claude_desktop_config_list_backups,
            // App commands
            commands::system::app_get_version,
            // Auto-launch + global shortcut commands
            commands::system_ext::auto_launch_is_enabled,
            commands::system_ext::auto_launch_set_enabled,
            commands::system_ext::show_window_get_shortcut,
            commands::system_ext::show_window_set_shortcut,
        ])
        .setup(|app| {
            // Keep legacy behavior: close button hides to tray by default unless user explicitly changed it.
            let should_init_close_to_tray = {
                let db_state = app.state::<Arc<Mutex<Database>>>();
                let has_no_setting = match db_state.lock() {
                    Ok(db) => db
                        .settings_get_value("closeToTray")
                        .ok()
                        .flatten()
                        .is_none(),
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
                let default_port = if cfg!(debug_assertions) {
                    "22345"
                } else {
                    "12345"
                };
                let db_state = app.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.lock() {
                    let _ = db.settings_set_value("proxyPort", default_port);
                };
            }

            let handle = app.handle().clone();

            // Install the app-side log adapter as early as possible in setup
            // so every `log::*` from subsequent bootstrap work (bridge spawn,
            // daemon start, tray setup) is already observable on the Console
            // page once the user opens it.
            services::app_logger::install(handle.clone());
            log::info!(
                "app booted; version {}, mode {}",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) {
                    "dev"
                } else {
                    "prod"
                }
            );

            // Production upgrades keep the existing Desktop route token but
            // rewrite CC Use's profile to the current schema. In particular,
            // this removes the legacy fixed inferenceModels/labelOverride list
            // and enables gateway model discovery.
            if !cfg!(debug_assertions) {
                let db_state = handle.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.lock() {
                    match commands::claude_desktop_config::refresh_taken_over_profile(&db) {
                        Ok(true) => log::info!("refreshed taken-over Claude Desktop profile"),
                        Ok(false) => {}
                        Err(error) => {
                            log::warn!("failed to refresh Claude Desktop profile: {}", error)
                        }
                    }
                };
            }

            // Start the realtime console SSE bridge to the daemon. Must happen
            // before the daemon-start spawn below so the bridge is already up
            // and waiting when the daemon first binds. `.manage()` stores the
            // handle so `console_stream_restart` and `settings_update` can
            // force a reconnect later.
            {
                let db_state = handle.state::<Arc<Mutex<Database>>>();
                let db_for_bridge: Arc<Mutex<Database>> = (*db_state).clone();
                let bridge_handle =
                    services::console_bridge::spawn_console_bridge(handle.clone(), db_for_bridge);
                handle.manage(bridge_handle);
            }

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

            // Re-arm the user's previously chosen "show window" global
            // shortcut (if any) so it works immediately after a cold boot,
            // not only after the user re-opens Settings.
            {
                let db_state = handle.state::<Arc<Mutex<Database>>>();
                let db_arc = db_state.inner().clone();
                drop(db_state);
                if let Ok(db) = db_arc.lock() {
                    commands::system_ext::restore_shortcut(&handle, &db);
                };
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

            // Ensure daemon is running unless the user disabled it via the
            // daemon toggle (daemonEnabled defaults to true).
            let handle2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                let db_state = handle2.state::<Arc<Mutex<Database>>>();

                // Clean up stale sessions (older than 30 days)
                // Clean up old request & usage logs (older than 90 days)
                if let Ok(db) = db_state.lock() {
                    let _ = db.proxy_session_cleanup_stale(30);
                    let _ = db.request_log_cleanup_old(90);
                    let _ = db.usage_log_cleanup_old(90);
                }

                let daemon_enabled = {
                    if let Ok(db) = db_state.lock() {
                        db.settings_get().map(|s| s.daemon_enabled).unwrap_or(true)
                    } else {
                        true
                    }
                };

                if !daemon_enabled {
                    log::info!("Daemon disabled by setting; skipping auto-start");
                    tray::refresh_tray_menu(&handle2);
                    return;
                }

                // Version-based restart: if app version changed, restart daemon
                let current_version = env!("CARGO_PKG_VERSION").to_string();
                let last_version = {
                    if let Ok(db) = db_state.lock() {
                        db.settings_get_value("lastDaemonVersion").ok().flatten()
                    } else {
                        None
                    }
                };

                let version_changed = last_version.as_deref() != Some(&current_version);
                let already_running = commands::proxy::is_proxy_running(&*db_state);

                if already_running && version_changed {
                    // Version upgrade: restart daemon
                    log::info!(
                        "App version changed ({} -> {}), restarting daemon",
                        last_version.as_deref().unwrap_or("unknown"),
                        current_version,
                    );
                    let _ = commands::proxy::proxy_restart_inner(&*db_state).await;
                } else if !already_running {
                    // Not running: start daemon
                    log::info!("Daemon not running, starting");
                    let _ = commands::proxy::proxy_start_inner(&*db_state).await;
                }

                // Persist current version
                if version_changed {
                    if let Ok(db) = db_state.lock() {
                        let _ = db.settings_set_value("lastDaemonVersion", &current_version);
                    }
                }

                tray::refresh_tray_menu(&handle2);
            });

            // Daemon watchdog: periodically check health and auto-recover on crash
            {
                let handle_wd = handle.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        let db_state = handle_wd.state::<Arc<Mutex<Database>>>();

                        // Respect the daemon toggle: never resurrect a daemon
                        // the user has explicitly turned off.
                        let daemon_enabled = {
                            if let Ok(db) = db_state.lock() {
                                db.settings_get().map(|s| s.daemon_enabled).unwrap_or(true)
                            } else {
                                true
                            }
                        };
                        if !daemon_enabled {
                            continue;
                        }

                        if !commands::proxy::is_proxy_running(&*db_state) {
                            log::warn!("Daemon watchdog detected stopped daemon, auto-restarting");
                            if let Err(e) = commands::proxy::proxy_start_inner(&*db_state).await {
                                log::error!("Daemon watchdog restart failed: {}", e);
                                continue;
                            }
                            let status = commands::proxy::proxy_status_inner(&*db_state).unwrap_or(
                                ProxyStatus {
                                    is_running: false,
                                    port: 12345,
                                    request_count: 0,
                                    last_error: None,
                                },
                            );
                            let _ = handle_wd.emit("proxy:statusChanged", &status);
                            tray::refresh_tray_menu(&handle_wd);
                            log::info!("Daemon watchdog auto-restart succeeded");
                        }
                    }
                });
            }

            // Handle close-to-tray and window focus events
            let handle3 = handle.clone();
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
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
                        tauri::WindowEvent::Focused(true) => {
                            // Refresh tray badge when window gains focus
                            tray::refresh_tray_badge(&handle3);
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
