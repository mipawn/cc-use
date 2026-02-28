use crate::db::Database;
use crate::models::{ProxySession, ProxyStatus};
use crate::proxy::ProxyState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tauri::State;
use tokio::sync::watch;

/// Global proxy shutdown channel
static PROXY_SHUTDOWN: std::sync::OnceLock<Mutex<Option<watch::Sender<bool>>>> = std::sync::OnceLock::new();
static PROXY_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PROXY_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(12345);

fn get_shutdown_lock() -> &'static Mutex<Option<watch::Sender<bool>>> {
    PROXY_SHUTDOWN.get_or_init(|| Mutex::new(None))
}

/// Public helper for tray module to check proxy status
pub fn is_proxy_running() -> bool {
    PROXY_RUNNING.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
pub async fn proxy_start(
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    proxy_start_inner(&*db).await
}

/// Inner implementation callable from both command handler and tray
pub async fn proxy_start_inner(
    db: &Mutex<Database>,
) -> Result<(), String> {
    if PROXY_RUNNING.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(());
    }

    let settings = {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.settings_get().map_err(|e| e.to_string())?
    };

    let port = settings.proxy_port as u16;
    PROXY_PORT.store(port, std::sync::atomic::Ordering::Relaxed);

    // Restore sessions from DB
    let sessions = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let db_sessions = db.proxy_session_list().map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for s in db_sessions {
            map.insert(s.session_token.clone(), s);
        }
        Arc::new(Mutex::new(map))
    };

    // Create a new DB connection for the proxy (runs on separate task)
    let proxy_db = Arc::new(Mutex::new(
        crate::db::Database::new().map_err(|e| e.to_string())?
    ));

    let state = Arc::new(ProxyState {
        db: proxy_db,
        sessions,
        request_count: Arc::new(AtomicU64::new(0)),
        last_error: Arc::new(Mutex::new(None)),
    });

    let app = axum::Router::new()
        .fallback(axum::routing::any(crate::proxy::handler::proxy_handler))
        .with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind port {}: {}", port, e))?;

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    *get_shutdown_lock().lock().unwrap() = Some(shutdown_tx);
    PROXY_RUNNING.store(true, std::sync::atomic::Ordering::Relaxed);

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.changed().await;
            })
            .await
            .ok();
        PROXY_RUNNING.store(false, std::sync::atomic::Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
pub async fn proxy_stop() -> Result<(), String> {
    let should_sleep = {
        let mut lock = get_shutdown_lock().lock().unwrap();
        if let Some(tx) = lock.take() {
            let _ = tx.send(true);
            true
        } else {
            false
        }
    }; // MutexGuard dropped here before await
    if should_sleep {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    PROXY_RUNNING.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn proxy_status() -> Result<ProxyStatus, String> {
    Ok(ProxyStatus {
        is_running: PROXY_RUNNING.load(std::sync::atomic::Ordering::Relaxed),
        port: PROXY_PORT.load(std::sync::atomic::Ordering::Relaxed) as i32,
        request_count: 0,
        last_error: None,
    })
}

#[tauri::command]
pub fn session_create(
    db: State<'_, Mutex<Database>>,
    provider_id: String,
    api_key_id: String,
) -> Result<ProxySession, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    let session = ProxySession {
        session_token: format!("session-{}", nanoid::nanoid!(16)),
        provider_id,
        api_key_id,
        project_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    db.proxy_session_create(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
pub fn session_get(
    db: State<'_, Mutex<Database>>,
    session_token: String,
) -> Result<Option<ProxySession>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_get(&session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_update_key(
    db: State<'_, Mutex<Database>>,
    session_token: String,
    api_key_id: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_update_key(&session_token, &api_key_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_delete(
    db: State<'_, Mutex<Database>>,
    session_token: String,
) -> Result<bool, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_delete(&session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_list(
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<ProxySession>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.proxy_session_list().map_err(|e| e.to_string())
}
