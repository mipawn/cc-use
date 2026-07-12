use crate::db::Database;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub mod console;
pub mod handler;
pub mod key_selector;
pub mod usage_parser;

pub use console::{now_timestamp, ConsoleEvent};

/// Broadcast buffer for the live console. Sized for a burst of concurrent
/// requests while a subscriber catches up, but small enough that a
/// disconnected subscriber just loses history rather than pinning memory.
const CONSOLE_CHANNEL_CAPACITY: usize = 256;

/// Shared state for the proxy server
pub struct ProxyState {
    pub db: Arc<Mutex<Database>>,
    pub request_count: Arc<AtomicU64>,
    pub last_error: Arc<Mutex<Option<String>>>,
    /// Fan-out channel for realtime console events. Always present; if
    /// no subscriber is listening, `send` is a cheap no-op (Err dropped).
    pub console_tx: broadcast::Sender<ConsoleEvent>,
    /// Whether the console detail mode is enabled. When true, the handler
    /// captures request/response body + headers (desensitised) and attaches
    /// them to ConsoleEvent::Request. Toggled via the management endpoint.
    pub detail_mode: Arc<AtomicBool>,
}

impl ProxyState {
    /// Best-effort broadcast to the realtime console. Returning `Err` from
    /// `send` means nobody is subscribed right now — in that case the event
    /// is dropped on purpose; the console never tries to replay history.
    pub fn emit_console(&self, event: ConsoleEvent) {
        let _ = self.console_tx.send(event);
    }
}

pub fn build_proxy_state(db: Arc<Mutex<Database>>) -> Result<Arc<ProxyState>, String> {
    let (console_tx, _rx) = broadcast::channel(CONSOLE_CHANNEL_CAPACITY);

    Ok(Arc::new(ProxyState {
        db,
        request_count: Arc::new(AtomicU64::new(0)),
        last_error: Arc::new(Mutex::new(None)),
        console_tx,
        detail_mode: Arc::new(AtomicBool::new(false)),
    }))
}

pub fn build_proxy_router(state: Arc<ProxyState>) -> axum::Router {
    axum::Router::new()
        .fallback(axum::routing::any(crate::proxy::handler::proxy_handler))
        .with_state(state)
}
