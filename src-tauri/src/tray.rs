use crate::db::Database;
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "macos"))]
use std::sync::OnceLock;
#[cfg(not(target_os = "macos"))]
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

/// Tray menu labels for i18n
struct TrayLabels {
    show: &'static str,
    hide: &'static str,
    quit: &'static str,
    proxy_running: &'static str,
    proxy_stopped: &'static str,
    start_proxy: &'static str,
    stop_proxy: &'static str,
    recent_projects: &'static str,
    no_recent_projects: &'static str,
}

const ZH_LABELS: TrayLabels = TrayLabels {
    show: "显示窗口",
    hide: "隐藏窗口",
    quit: "退出",
    proxy_running: "代理: ● 运行中",
    proxy_stopped: "代理: ○ 已停止",
    start_proxy: "启动代理",
    stop_proxy: "停止代理",
    recent_projects: "最近项目",
    no_recent_projects: "暂无最近项目",
};

const EN_LABELS: TrayLabels = TrayLabels {
    show: "Show Window",
    hide: "Hide Window",
    quit: "Quit",
    proxy_running: "Proxy: ● Running",
    proxy_stopped: "Proxy: ○ Stopped",
    start_proxy: "Start Proxy",
    stop_proxy: "Stop Proxy",
    recent_projects: "Recent Projects",
    no_recent_projects: "No Recent Projects",
};

#[cfg(not(target_os = "macos"))]
// Ignore duplicate tray click events fired too close together
static LAST_TRAY_CLICK: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn get_labels() -> &'static TrayLabels {
    let locale = sys_locale::get_locale().unwrap_or_default();
    if locale.starts_with("zh") {
        &ZH_LABELS
    } else {
        &EN_LABELS
    }
}

#[cfg(not(target_os = "macos"))]
fn should_handle_click() -> bool {
    let now = Instant::now();
    let lock = LAST_TRAY_CLICK.get_or_init(|| Mutex::new(None));
    let mut last = lock.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(prev) = *last {
        if now.duration_since(prev) < Duration::from_millis(220) {
            return false;
        }
    }

    *last = Some(now);
    true
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

    // Proxy status
    let proxy_running = crate::commands::proxy::is_proxy_running();
    let status_label = if proxy_running {
        labels.proxy_running
    } else {
        labels.proxy_stopped
    };
    let proxy_status_item = MenuItem::with_id(app, "proxy_status", status_label, false, None::<&str>)?;

    let proxy_toggle_label = if proxy_running {
        labels.stop_proxy
    } else {
        labels.start_proxy
    };
    let proxy_toggle_item = MenuItem::with_id(app, "toggle_proxy", proxy_toggle_label, true, None::<&str>)?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    // Recent projects
    let projects_submenu = build_projects_submenu(app, labels)?;

    let sep3 = PredefinedMenuItem::separator(app)?;

    // Quit
    let quit_item = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle_item,
            &sep1,
            &proxy_status_item,
            &proxy_toggle_item,
            &sep2,
            &projects_submenu,
            &sep3,
            &quit_item,
        ],
    )?;

    Ok(menu)
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
    #[cfg(target_os = "macos")]
    let _ = tray.set_show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let _ = tray.set_show_menu_on_left_click(false);

    // Handle menu events
    let app_handle = app.clone();
    tray.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        handle_menu_event(&app_handle, id);
    });

    // Handle tray icon click on Windows/Linux: left click toggles window.
    #[cfg(not(target_os = "macos"))]
    {
        let app_handle = app.clone();
        tray.on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left
                    && (button_state == MouseButtonState::Up
                        || button_state == MouseButtonState::Down)
                    && should_handle_click()
                {
                    toggle_window(&app_handle);
                    refresh_tray_menu(&app_handle);
                }
            }
        });
    }

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
        "toggle_proxy" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let running = crate::commands::proxy::is_proxy_running();
                if running {
                    let _ = crate::commands::proxy::proxy_stop().await;
                } else {
                    let db_state = app_handle.state::<Arc<Mutex<Database>>>();
                    let _ = crate::commands::proxy::proxy_start_inner(&*db_state).await;
                }
                // Emit proxy status change to frontend
                let status = crate::commands::proxy::proxy_status().unwrap_or(crate::models::ProxyStatus {
                    is_running: false,
                    port: 12345,
                    request_count: 0,
                    last_error: None,
                });
                let _ = app_handle.emit("proxy:statusChanged", &status);
                refresh_tray_menu(&app_handle);
            });
        }
        "quit" => {
            // Stop proxy before quitting
            tauri::async_runtime::spawn(async {
                let _ = crate::commands::proxy::proxy_stop().await;
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
