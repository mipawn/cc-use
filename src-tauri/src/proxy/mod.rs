use crate::db::Database;
use crate::models::ProxySession;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};

pub mod handler;
pub mod usage_parser;
pub mod key_selector;

/// Shared state for the proxy server
pub struct ProxyState {
    pub db: Arc<Mutex<Database>>,
    pub sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    pub request_count: Arc<AtomicU64>,
    pub last_error: Arc<Mutex<Option<String>>>,
}
