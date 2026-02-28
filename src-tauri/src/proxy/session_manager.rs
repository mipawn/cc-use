use crate::models::ProxySession;
use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory session manager backed by SQLite persistence
pub struct SessionManager {
    sessions: Mutex<HashMap<String, ProxySession>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn restore(&self, sessions: Vec<ProxySession>) {
        let mut map = self.sessions.lock().unwrap();
        for s in sessions {
            map.insert(s.session_token.clone(), s);
        }
    }

    pub fn get(&self, token: &str) -> Option<ProxySession> {
        self.sessions.lock().unwrap().get(token).cloned()
    }

    pub fn create(&self, session: ProxySession) {
        self.sessions.lock().unwrap().insert(session.session_token.clone(), session);
    }

    pub fn update_key(&self, token: &str, api_key_id: &str) -> bool {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(token) {
            s.api_key_id = api_key_id.to_string();
            true
        } else {
            false
        }
    }

    pub fn delete(&self, token: &str) -> bool {
        self.sessions.lock().unwrap().remove(token).is_some()
    }

    pub fn list(&self) -> Vec<ProxySession> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

/// Parse session token from auth header
pub fn parse_session_token(auth_header: &str) -> Option<String> {
    let token = auth_header.strip_prefix("Bearer ").unwrap_or(auth_header);
    if token.starts_with("session-") {
        Some(token.to_string())
    } else {
        None
    }
}
