use crate::db::Database;
use crate::models::ProxySession;
use std::collections::HashMap;
use std::sync::{atomic::AtomicU64, Arc, Mutex};

pub mod handler;
pub mod key_selector;
pub mod usage_parser;

/// Shared state for the proxy server
pub struct ProxyState {
    pub db: Arc<Mutex<Database>>,
    pub sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    pub request_count: Arc<AtomicU64>,
    pub last_error: Arc<Mutex<Option<String>>>,
}

pub fn build_proxy_state(db: Arc<Mutex<Database>>) -> Result<Arc<ProxyState>, String> {
    let sessions = {
        let db = db.lock().map_err(|e| e.to_string())?;
        let db_sessions = db.proxy_session_list().map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for session in db_sessions {
            map.insert(session.session_token.clone(), session);
        }
        Arc::new(Mutex::new(map))
    };

    Ok(Arc::new(ProxyState {
        db,
        sessions,
        request_count: Arc::new(AtomicU64::new(0)),
        last_error: Arc::new(Mutex::new(None)),
    }))
}

pub fn build_proxy_router(state: Arc<ProxyState>) -> axum::Router {
    axum::Router::new()
        .fallback(axum::routing::any(crate::proxy::handler::proxy_handler))
        .with_state(state)
}
