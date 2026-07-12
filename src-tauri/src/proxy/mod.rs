use crate::db::Database;
use crate::models::GatewayRequestEvent;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{mpsc, Arc, Mutex};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};

pub mod console;
pub mod handler;
pub mod key_selector;
pub mod usage_parser;

pub use console::{now_timestamp, ConsoleEvent};

/// Broadcast buffer for the live console. Sized for a burst of concurrent
/// requests while a subscriber catches up, but small enough that a
/// disconnected subscriber just loses history rather than pinning memory.
const CONSOLE_CHANNEL_CAPACITY: usize = 256;
const GLOBAL_CONCURRENCY_LIMIT: usize = 64;
const SESSION_CONCURRENCY_LIMIT: usize = 16;

#[derive(Debug)]
pub struct RequestPermits {
    _global: OwnedSemaphorePermit,
    _session: Option<OwnedSemaphorePermit>,
}

/// Shared state for the proxy server
pub struct ProxyState {
    pub db: Arc<Mutex<Database>>,
    pub request_count: Arc<AtomicU64>,
    pub last_error: Arc<Mutex<Option<String>>>,
    metrics_tx: mpsc::SyncSender<GatewayRequestEvent>,
    /// Fan-out channel for realtime console events. Always present; if
    /// no subscriber is listening, `send` is a cheap no-op (Err dropped).
    pub console_tx: broadcast::Sender<ConsoleEvent>,
    /// Whether the console detail mode is enabled. When true, the handler
    /// captures request/response body + headers (desensitised) and attaches
    /// them to ConsoleEvent::Request. Toggled via the management endpoint.
    pub detail_mode: Arc<AtomicBool>,
    global_concurrency: Arc<Semaphore>,
    session_concurrency: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl ProxyState {
    /// Best-effort broadcast to the realtime console. Returning `Err` from
    /// `send` means nobody is subscribed right now — in that case the event
    /// is dropped on purpose; the console never tries to replay history.
    pub fn emit_console(&self, event: ConsoleEvent) {
        if let ConsoleEvent::Request {
            request_id,
            timestamp,
            kind,
            method,
            path,
            status,
            latency_ms,
            provider,
            key_alias,
            message,
            ..
        } = &event
        {
            if kind != "pending" {
                let metric = GatewayRequestEvent {
                    id: request_id.clone().unwrap_or_else(|| nanoid::nanoid!()),
                    created_at: timestamp.clone(),
                    kind: kind.clone(),
                    method: method.clone(),
                    path: path.clone(),
                    status_code: status.map(i32::from),
                    latency_ms: latency_ms.map(|value| value as i64),
                    provider_name: provider.clone(),
                    key_alias: key_alias.clone(),
                    is_streaming: method == "WS" || message.as_deref() == Some("streaming"),
                };
                match self.metrics_tx.try_send(metric) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => {
                        log::debug!("Gateway request metric queue is full; event dropped");
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        log::warn!("Gateway request metric writer is unavailable");
                    }
                }
            }
        }
        let _ = self.console_tx.send(event);
    }

    pub fn try_acquire_request_permits(
        &self,
        session_token: Option<&str>,
    ) -> Result<RequestPermits, &'static str> {
        let global = self
            .global_concurrency
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Local gateway global concurrency limit reached")?;

        let session = if let Some(session_token) = session_token {
            let semaphore = {
                let mut semaphores = self
                    .session_concurrency
                    .lock()
                    .map_err(|_| "Local gateway concurrency state unavailable")?;
                if semaphores.len() >= 1024 {
                    semaphores.retain(|_, semaphore| Arc::strong_count(semaphore) > 1);
                }
                semaphores
                    .entry(session_token.to_string())
                    .or_insert_with(|| Arc::new(Semaphore::new(SESSION_CONCURRENCY_LIMIT)))
                    .clone()
            };
            Some(
                semaphore
                    .try_acquire_owned()
                    .map_err(|_| "Local gateway session concurrency limit reached")?,
            )
        } else {
            None
        };

        Ok(RequestPermits {
            _global: global,
            _session: session,
        })
    }
}

pub fn build_proxy_state(db: Arc<Mutex<Database>>) -> Result<Arc<ProxyState>, String> {
    let (console_tx, _rx) = broadcast::channel(CONSOLE_CHANNEL_CAPACITY);
    let (metrics_tx, metrics_rx) = mpsc::sync_channel::<GatewayRequestEvent>(1024);
    let metrics_db = db.clone();
    std::thread::Builder::new()
        .name("cc-use-metrics-writer".to_string())
        .spawn(move || {
            let mut persisted = 0u64;
            if let Ok(db) = metrics_db.lock() {
                if let Err(error) = db.gateway_event_cleanup() {
                    log::warn!("Failed to prune gateway request metrics at startup: {}", error);
                }
            }
            while let Ok(metric) = metrics_rx.recv() {
                let Ok(db) = metrics_db.lock() else {
                    log::warn!("Failed to lock database for gateway request metric");
                    continue;
                };
                if let Err(error) = db.gateway_event_upsert(&metric) {
                    log::warn!("Failed to persist gateway request metric: {}", error);
                    continue;
                }
                persisted += 1;
                if persisted % 256 == 0 {
                    if let Err(error) = db.gateway_event_cleanup() {
                        log::warn!("Failed to prune gateway request metrics: {}", error);
                    }
                }
            }
        })
        .map_err(|error| format!("Failed to start metrics writer: {}", error))?;

    Ok(Arc::new(ProxyState {
        db,
        request_count: Arc::new(AtomicU64::new(0)),
        last_error: Arc::new(Mutex::new(None)),
        metrics_tx,
        console_tx,
        detail_mode: Arc::new(AtomicBool::new(false)),
        global_concurrency: Arc::new(Semaphore::new(GLOBAL_CONCURRENCY_LIMIT)),
        session_concurrency: Arc::new(Mutex::new(HashMap::new())),
    }))
}

pub fn build_proxy_router(state: Arc<ProxyState>) -> axum::Router {
    axum::Router::new()
        .fallback(axum::routing::any(crate::proxy::handler::proxy_handler))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrency_limits_are_bounded_and_release_with_permits() {
        let state =
            build_proxy_state(Arc::new(Mutex::new(Database::new_in_memory().unwrap()))).unwrap();

        let mut session_permits = Vec::new();
        for _ in 0..SESSION_CONCURRENCY_LIMIT {
            session_permits.push(
                state
                    .try_acquire_request_permits(Some("session-one"))
                    .unwrap(),
            );
        }
        assert!(state
            .try_acquire_request_permits(Some("session-one"))
            .is_err());
        assert!(state
            .try_acquire_request_permits(Some("session-two"))
            .is_ok());

        session_permits.pop();
        assert!(state
            .try_acquire_request_permits(Some("session-one"))
            .is_ok());
    }

    #[test]
    fn global_concurrency_limit_applies_to_passthrough_requests() {
        let state =
            build_proxy_state(Arc::new(Mutex::new(Database::new_in_memory().unwrap()))).unwrap();
        let permits = (0..GLOBAL_CONCURRENCY_LIMIT)
            .map(|_| state.try_acquire_request_permits(None).unwrap())
            .collect::<Vec<_>>();

        assert!(state.try_acquire_request_permits(None).is_err());
        drop(permits);
        assert!(state.try_acquire_request_permits(None).is_ok());
    }

    #[test]
    fn terminal_console_events_are_persisted_but_pending_events_are_not() {
        let state =
            build_proxy_state(Arc::new(Mutex::new(Database::new_in_memory().unwrap()))).unwrap();
        state.emit_console(ConsoleEvent::pending(
            "request-one",
            "POST",
            "/v1/messages",
            "https://example.com/v1/messages",
            Some("Provider"),
            Some("Key"),
            true,
        ));
        state.emit_console(ConsoleEvent::ok(
            "request-one",
            "POST",
            "/v1/messages",
            200,
            42,
            "https://example.com/v1/messages",
            Some("Provider"),
            Some("Key"),
            true,
        ));

        let mut attempts = 0;
        let db = loop {
            let db = state.db.lock().unwrap();
            let count: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM gateway_request_events", [], |row| row.get(0))
                .unwrap();
            if count == 1 || attempts >= 50 {
                break db;
            }
            drop(db);
            attempts += 1;
            std::thread::sleep(std::time::Duration::from_millis(2));
        };
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM gateway_request_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let streaming: i64 = db
            .conn
            .query_row(
                "SELECT is_streaming FROM gateway_request_events WHERE id = 'request-one'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(streaming, 1);
    }
}
