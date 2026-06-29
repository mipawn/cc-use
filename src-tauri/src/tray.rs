use crate::db::Database;
use crate::models::ApiKey;
use crate::shared_runtime::session_token::CODEX_SESSION_TOKEN_SETTING_KEY;
use crate::usage_stats::UsageAggregator;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

const CODEX_LAST_API_KEY_SETTING_KEY: &str = "codex_last_api_key_id";
const CLAUDE_DESKTOP_LAST_API_KEY_SETTING_KEY: &str = "claude_desktop_last_api_key_id";
const CLAUDE_DESKTOP_GATEWAY_TOKEN_SETTING_KEY: &str = "claudeDesktopGatewayToken";

/// Tray menu labels for i18n
struct TrayLabels {
    show: &'static str,
    hide: &'static str,
    quit: &'static str,
    proxy_running: &'static str,
    proxy_stopped: &'static str,
    restart_proxy: &'static str,
    codex_desktop: &'static str,
    claude_desktop: &'static str,
    no_desktop_keys: &'static str,
    restore_official: &'static str,
    recent_projects: &'static str,
    no_recent_projects: &'static str,
}

const ZH_LABELS: TrayLabels = TrayLabels {
    show: "显示窗口",
    hide: "隐藏窗口",
    quit: "退出",
    proxy_running: "代理: ● 运行中",
    proxy_stopped: "代理: ○ 已停止",
    restart_proxy: "重启代理",
    codex_desktop: "Codex Desktop",
    claude_desktop: "Claude Desktop",
    no_desktop_keys: "暂无可用密钥",
    restore_official: "恢复官方配置",
    recent_projects: "Claude Code",
    no_recent_projects: "暂无最近项目",
};

const EN_LABELS: TrayLabels = TrayLabels {
    show: "Show Window",
    hide: "Hide Window",
    quit: "Quit",
    proxy_running: "Proxy: ● Running",
    proxy_stopped: "Proxy: ○ Stopped",
    restart_proxy: "Restart Proxy",
    codex_desktop: "Codex Desktop",
    claude_desktop: "Claude Desktop",
    no_desktop_keys: "No Available Keys",
    restore_official: "Restore Official Config",
    recent_projects: "Claude Code",
    no_recent_projects: "No Recent Projects",
};

fn get_labels() -> &'static TrayLabels {
    let locale = sys_locale::get_locale().unwrap_or_default();
    if locale.starts_with("zh") {
        &ZH_LABELS
    } else {
        &EN_LABELS
    }
}

fn is_window_visible(app: &AppHandle) -> bool {
    if let Some(win) = app.get_webview_window("main") {
        win.is_visible().unwrap_or(false)
    } else {
        false
    }
}

pub fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let labels = get_labels();
    let visible = is_window_visible(app);

    // Show/Hide toggle
    let toggle_label = if visible { labels.hide } else { labels.show };
    let toggle_item = MenuItem::with_id(app, "toggle_window", toggle_label, true, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    let db_state = app.state::<Arc<Mutex<Database>>>();
    let db_arc = db_state.inner().clone();
    let proxy_running = crate::commands::proxy::is_proxy_running(&db_arc);
    let status_label = if proxy_running {
        labels.proxy_running
    } else {
        labels.proxy_stopped
    };
    let proxy_status_item =
        MenuItem::with_id(app, "proxy_status", status_label, false, None::<&str>)?;

    let proxy_restart_item = MenuItem::with_id(
        app,
        "restart_proxy",
        labels.restart_proxy,
        true,
        None::<&str>,
    )?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    let codex_submenu = build_desktop_client_submenu(
        app,
        "codex",
        labels.codex_desktop,
        labels,
        collect_desktop_key_menu_items(app, "codex"),
    )?;
    let claude_desktop_submenu = build_desktop_client_submenu(
        app,
        "claude_desktop",
        labels.claude_desktop,
        labels,
        collect_desktop_key_menu_items(app, "claude_desktop"),
    )?;

    let sep3 = PredefinedMenuItem::separator(app)?;

    // Recent projects
    let projects_submenu = build_projects_submenu(app, labels)?;

    let sep4 = PredefinedMenuItem::separator(app)?;

    // Quit
    let quit_item = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle_item,
            &sep1,
            &proxy_status_item,
            &proxy_restart_item,
            &sep2,
            &codex_submenu,
            &claude_desktop_submenu,
            &sep3,
            &projects_submenu,
            &sep4,
            &quit_item,
        ],
    )?;

    Ok(menu)
}

#[derive(Clone)]
struct DesktopKeyMenuItem {
    provider_id: String,
    provider_name: String,
    key_id: String,
    key_label: String,
    is_current: bool,
}

fn build_desktop_client_submenu(
    app: &AppHandle,
    client_kind: &str,
    label: &str,
    labels: &TrayLabels,
    keys: Vec<DesktopKeyMenuItem>,
) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let submenu = Submenu::with_id(app, format!("desktop:{client_kind}"), label, true)?;

    if keys.is_empty() {
        let empty_item = MenuItem::with_id(
            app,
            format!("desktop:{client_kind}:empty"),
            labels.no_desktop_keys,
            false,
            None::<&str>,
        )?;
        submenu.append(&empty_item)?;
    } else {
        for key in keys {
            let item = CheckMenuItem::with_id(
                app,
                format!(
                    "desktop_switch:{}:{}:{}",
                    client_kind, key.provider_id, key.key_id
                ),
                format!("{} / {}", key.provider_name, key.key_label),
                true,
                key.is_current,
                None::<&str>,
            )?;
            submenu.append(&item)?;
        }
    }

    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    let restore_item = MenuItem::with_id(
        app,
        format!("desktop_restore:{client_kind}"),
        labels.restore_official,
        true,
        None::<&str>,
    )?;
    submenu.append(&restore_item)?;

    Ok(submenu)
}

fn collect_desktop_key_menu_items(app: &AppHandle, client_kind: &str) -> Vec<DesktopKeyMenuItem> {
    let db_state = app.state::<Arc<Mutex<Database>>>();
    let db_arc = db_state.inner().clone();
    let Ok(db) = db_arc.lock() else {
        return Vec::new();
    };

    let providers = db.provider_list().unwrap_or_default();
    let current_key_id = current_desktop_key_id(&db, client_kind);
    let mut items = Vec::new();

    for provider in providers.into_iter().filter(|p| p.is_active) {
        let keys = db.api_key_list(&provider.id).unwrap_or_default();
        for key in keys {
            if !key_available_for_client(&key, client_kind) {
                continue;
            }
            items.push(DesktopKeyMenuItem {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                key_id: key.id.clone(),
                key_label: key
                    .alias
                    .clone()
                    .unwrap_or_else(|| mask_key_value(&key.value)),
                is_current: current_key_id.as_deref() == Some(key.id.as_str()),
            });
        }
    }

    items
}

fn current_desktop_key_id(db: &Database, client_kind: &str) -> Option<String> {
    let setting_key = match client_kind {
        "codex" => CODEX_LAST_API_KEY_SETTING_KEY,
        "claude_desktop" => CLAUDE_DESKTOP_LAST_API_KEY_SETTING_KEY,
        _ => return None,
    };
    if let Ok(Some(key_id)) = db.settings_get_value(setting_key) {
        if !key_id.trim().is_empty() {
            return Some(key_id);
        }
    }

    let token_key = match client_kind {
        "codex" => CODEX_SESSION_TOKEN_SETTING_KEY,
        "claude_desktop" => CLAUDE_DESKTOP_GATEWAY_TOKEN_SETTING_KEY,
        _ => return None,
    };
    let expected_cli_type = match client_kind {
        "codex" => "codex-app",
        "claude_desktop" => "claude_desktop",
        _ => return None,
    };

    let token = db.settings_get_value(token_key).ok().flatten()?;
    let session = db.proxy_session_get(&token).ok().flatten()?;
    if session.cli_type.as_deref() == Some(expected_cli_type) {
        Some(session.api_key_id)
    } else {
        None
    }
}

fn key_available_for_client(key: &ApiKey, client_kind: &str) -> bool {
    key.is_active
        && !key.is_exhausted
        && key
            .types
            .iter()
            .any(|type_name| normalize_client_kind(type_name) == client_kind)
}

fn normalize_client_kind(type_name: &str) -> &'static str {
    match type_name {
        "claude" | "claude_code" => "claude_code",
        "codex" => "codex",
        "claude_desktop" => "claude_desktop",
        _ => "claude_code",
    }
}

fn mask_key_value(value: &str) -> String {
    let trimmed = value.trim();
    let tail: String = trimmed
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail.len() < 6 {
        "Untitled Key".to_string()
    } else {
        format!("...{}", tail)
    }
}

fn build_projects_submenu(
    app: &AppHandle,
    labels: &TrayLabels,
) -> Result<Submenu<tauri::Wry>, tauri::Error> {
    let db_state = app.state::<Arc<Mutex<Database>>>();
    let db_arc = db_state.inner().clone();
    let projects = {
        if let Ok(db) = db_arc.lock() {
            db.project_list().unwrap_or_default()
        } else {
            Vec::new()
        }
    };

    let recent: Vec<_> = projects
        .into_iter()
        .filter(|p| p.last_opened_at.is_some())
        .take(10)
        .collect();

    let submenu = Submenu::with_id(app, "recent_projects", labels.recent_projects, true)?;

    if recent.is_empty() {
        let empty_item = MenuItem::with_id(
            app,
            "no_recent",
            labels.no_recent_projects,
            false,
            None::<&str>,
        )?;
        submenu.append(&empty_item)?;
    } else {
        for project in &recent {
            let item = MenuItem::with_id(
                app,
                format!("project:{}", project.id),
                &project.name,
                true,
                None::<&str>,
            )?;
            submenu.append(&item)?;
        }
    }

    Ok(submenu)
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let tray = app.tray_by_id("main").ok_or("No tray icon found")?;

    // On macOS, enforce dedicated white-plate tray icon at runtime.
    // This keeps the current larger shape while preserving the white background.
    #[cfg(target_os = "macos")]
    {
        // Using a 22x22 RGBA on Retina will be upscaled and look blurry.
        // Pick the appropriate raw asset based on monitor scale factor.
        const TRAY_1X: &[u8] = include_bytes!("../icons/tray.rgba");
        const TRAY_2X: &[u8] = include_bytes!("../icons/tray@2x.rgba");

        let scale_factor = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);

        let (bytes, w, h) = if scale_factor >= 1.5 {
            (TRAY_2X, 44, 44)
        } else {
            (TRAY_1X, 22, 22)
        };

        let img = tauri::image::Image::new(bytes, w, h);
        let _ = tray.set_icon(Some(img));
        let _ = tray.set_icon_as_template(false);
    }

    // Build initial menu
    let menu = build_tray_menu(app)?;
    tray.set_menu(Some(menu))?;
    tray.set_tooltip(Some("CC Use"))?;
    apply_tray_badge(app);
    #[cfg(target_os = "macos")]
    let _ = tray.set_show_menu_on_left_click(true);

    // Handle menu events
    let app_handle = app.clone();
    tray.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        handle_menu_event(&app_handle, id);
    });

    // Periodic refresh every 30s
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        refresh_tray_menu(&app_handle);
    });

    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "toggle_window" => {
            toggle_window(app);
            refresh_tray_menu(app);
        }
        "restart_proxy" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                let _ =
                    crate::commands::proxy::proxy_restart_inner(&db_state.inner().clone()).await;
                // Emit proxy status change to frontend
                let status = {
                    let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                    crate::commands::proxy::proxy_status_inner(&db_state.inner().clone())
                }
                .unwrap_or(crate::models::ProxyStatus {
                    is_running: false,
                    port: 12345,
                    request_count: 0,
                    last_error: None,
                });
                let _ = app_handle.emit("proxy:statusChanged", &status);
                refresh_tray(&app_handle);
            });
        }
        id if id.starts_with("desktop_switch:") => {
            let parts: Vec<&str> = id.splitn(4, ':').collect();
            if parts.len() == 4 {
                switch_desktop_key(app, parts[1], parts[2].to_string(), parts[3].to_string());
            }
        }
        id if id.starts_with("desktop_restore:") => {
            let client_kind = id.strip_prefix("desktop_restore:").unwrap_or_default();
            restore_desktop_config(app, client_kind);
        }
        "quit" => {
            // Stop proxy before quitting
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                let _ = crate::commands::proxy::proxy_stop_inner(&db_state.inner().clone()).await;
            });
            std::process::exit(0);
        }
        id if id.starts_with("project:") => {
            let project_id = id.strip_prefix("project:").unwrap().to_string();
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                let db_arc = db_state.inner().clone();
                drop(db_state);
                let lock_result = db_arc.lock();
                if let Ok(db) = lock_result {
                    let _ = crate::terminal::launch_terminal(&db, &project_id, None, None);
                }
            });
        }
        _ => {}
    }
}

fn switch_desktop_key(app: &AppHandle, client_kind: &str, provider_id: String, api_key_id: String) {
    let app_handle = app.clone();
    let client_kind = client_kind.to_string();
    tauri::async_runtime::spawn(async move {
        let result = match client_kind.as_str() {
            "codex" => {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                let db_arc = db_state.inner().clone();
                crate::commands::codex_config::codex_config_takeover_inner(
                    &db_arc,
                    provider_id,
                    api_key_id.clone(),
                )
                .map(|_| CODEX_LAST_API_KEY_SETTING_KEY)
            }
            "claude_desktop" => {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                let db_arc = db_state.inner().clone();
                crate::commands::claude_desktop_config::claude_desktop_config_takeover_inner(
                    &db_arc,
                    provider_id,
                    api_key_id.clone(),
                )
                .map(|_| CLAUDE_DESKTOP_LAST_API_KEY_SETTING_KEY)
            }
            _ => Err("Unsupported desktop client".to_string()),
        };

        match result {
            Ok(setting_key) => {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.inner().lock() {
                    let _ = db.settings_set_value(setting_key, &api_key_id);
                }
            }
            Err(error) => {
                log::error!("Desktop client switch failed: {}", error);
            }
        }
        refresh_tray(&app_handle);
    });
}

fn restore_desktop_config(app: &AppHandle, client_kind: &str) {
    let app_handle = app.clone();
    let client_kind = client_kind.to_string();
    tauri::async_runtime::spawn(async move {
        let result = match client_kind.as_str() {
            "codex" => crate::commands::codex_config::codex_config_restore_inner()
                .map(|_| CODEX_LAST_API_KEY_SETTING_KEY),
            "claude_desktop" => {
                crate::commands::claude_desktop_config::claude_desktop_config_restore_inner()
                    .map(|_| CLAUDE_DESKTOP_LAST_API_KEY_SETTING_KEY)
            }
            _ => Err("Unsupported desktop client".to_string()),
        };

        match result {
            Ok(setting_key) => {
                let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                if let Ok(db) = db_state.inner().lock() {
                    let _ = db.settings_delete_value(setting_key);
                }
            }
            Err(error) => {
                log::error!("Desktop client restore failed: {}", error);
            }
        }
        refresh_tray(&app_handle);
    });
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_dock_visibility(false);
            }
            let _ = win.hide();
        } else {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_dock_visibility(true);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

pub fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    apply_tray_badge(app);
}

fn refresh_tray(app: &AppHandle) {
    refresh_tray_menu(app);
}

fn apply_tray_badge(app: &AppHandle) {
    let badge_text = calculate_tray_badge_text(app);
    let title = if badge_text.is_empty() {
        None
    } else {
        Some(badge_text.as_str())
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(title);
    }

    // Dock badge is intentionally kept clear; the usage hint lives only in the tray.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_badge_label(None);
    }
}

fn calculate_tray_badge_text(app: &AppHandle) -> String {
    let db_state = app.state::<Arc<Mutex<Database>>>();
    let db_arc = db_state.inner().clone();

    let today_cost = {
        let Ok(db) = db_arc.lock() else {
            return UsageAggregator::calculate_badge(true, 0, 0.0, 0).to_display_text();
        };
        db.request_log_get_dashboard_stats()
            .map(|stats| stats.today_cost)
            .unwrap_or(0.0)
    };

    UsageAggregator::calculate_badge(true, 0, today_cost, 0).to_display_text()
}

/// Handle close-to-tray behavior. Returns true if the window should be hidden instead of closed.
pub fn should_close_to_tray(app: &AppHandle) -> bool {
    let db_state = app.state::<Arc<Mutex<Database>>>();
    let db_arc = db_state.inner().clone();
    drop(db_state);
    let result = if let Ok(db) = db_arc.lock() {
        let settings = db.settings_get().unwrap_or_default();
        settings.close_to_tray
    } else {
        true // Default to close-to-tray on lock failure
    };
    result
}

#[cfg(test)]
mod tests {
    use super::{key_available_for_client, mask_key_value, normalize_client_kind};
    use crate::models::ApiKey;

    fn api_key(types: Vec<&str>, is_active: bool, is_exhausted: bool) -> ApiKey {
        ApiKey {
            id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            alias: None,
            value: "sk-test-123456".to_string(),
            types: types.into_iter().map(|t| t.to_string()).collect(),
            priority: 0,
            is_exhausted,
            is_active,
            config: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            cost_multiplier: 1.0,
            model_mapping: None,
            api_format: None,
            transform_enabled: false,
            client_configs: None,
        }
    }

    #[test]
    fn desktop_key_support_requires_matching_active_non_exhausted_key() {
        assert!(key_available_for_client(
            &api_key(vec!["codex", "claude_desktop"], true, false),
            "codex"
        ));
        assert!(key_available_for_client(
            &api_key(vec!["codex", "claude_desktop"], true, false),
            "claude_desktop"
        ));
        assert!(!key_available_for_client(
            &api_key(vec!["claude_code"], true, false),
            "codex"
        ));
        assert!(!key_available_for_client(
            &api_key(vec!["codex"], false, false),
            "codex"
        ));
        assert!(!key_available_for_client(
            &api_key(vec!["codex"], true, true),
            "codex"
        ));
    }

    #[test]
    fn normalize_client_kind_matches_renderer_fallbacks() {
        assert_eq!(normalize_client_kind("claude"), "claude_code");
        assert_eq!(normalize_client_kind("unknown"), "claude_code");
        assert_eq!(normalize_client_kind("codex"), "codex");
        assert_eq!(normalize_client_kind("claude_desktop"), "claude_desktop");
    }

    #[test]
    fn key_value_mask_uses_tail_without_leaking_secret() {
        assert_eq!(mask_key_value("sk-test-123456"), "...123456");
        assert_eq!(mask_key_value("short"), "Untitled Key");
    }
}
