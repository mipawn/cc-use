use serde::{Deserialize, Serialize};

/// Everything the realtime console streams. Tagged union so the frontend
/// can branch on `category` to render request lines vs log lines with the
/// same transport. Not persisted anywhere — if no subscriber is listening
/// when we broadcast, the event is dropped and that's fine.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum ConsoleEvent {
    /// A single proxy request crossing the handler.
    #[serde(rename_all = "camelCase")]
    Request {
        /// UTC timestamp `YYYY-MM-DD HH:MM:SS`.
        timestamp: String,
        /// Classification: "ok" | "upstream_error" | "rejected" | "ws".
        kind: String,
        /// HTTP method, or "WS" for websocket upgrades.
        method: String,
        /// Incoming request path + query.
        path: String,
        /// Upstream response status; null when we never dispatched.
        status: Option<u16>,
        /// Wall-clock latency, entry → emit.
        latency_ms: Option<u64>,
        /// Final upstream URL we forwarded to.
        upstream: Option<String>,
        /// Provider display name.
        provider: Option<String>,
        /// API key alias.
        key_alias: Option<String>,
        /// Optional note (error text, "streaming" hint, ...).
        message: Option<String>,
    },
    /// A log record captured from the Rust `log` facade or patched renderer
    /// console. Shares the same stream so the UI is "one pane for everything".
    #[serde(rename_all = "camelCase")]
    Log {
        timestamp: String,
        /// "error" | "warn" | "info" | "debug" | "trace".
        level: String,
        /// Where the log came from: "daemon" | "app" | "renderer".
        source: String,
        /// Module path / log target (e.g. "cc_use_lib::proxy::handler").
        target: Option<String>,
        message: String,
    },
}

impl ConsoleEvent {
    /// Successful non-streaming or streaming response.
    pub fn ok(
        method: &str,
        path: &str,
        status: u16,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        is_streaming: bool,
    ) -> Self {
        Self::Request {
            timestamp: now_timestamp(),
            kind: "ok".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: Some(status),
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: if is_streaming {
                Some("streaming".to_string())
            } else {
                None
            },
        }
    }

    /// Upstream contact failed or response could not be read.
    pub fn upstream_error(
        method: &str,
        path: &str,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
        error: &str,
    ) -> Self {
        Self::Request {
            timestamp: now_timestamp(),
            kind: "upstream_error".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: Some(error.to_string()),
        }
    }

    /// Rejection before we could dispatch (auth missing, unknown path, ...).
    pub fn rejected(method: &str, path: &str, latency_ms: u64, reason: &str) -> Self {
        Self::Request {
            timestamp: now_timestamp(),
            kind: "rejected".to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: None,
            provider: None,
            key_alias: None,
            message: Some(reason.to_string()),
        }
    }

    /// Websocket upgrade accepted; relay continues in a spawned task.
    pub fn ws_upgraded(
        path: &str,
        latency_ms: u64,
        upstream: &str,
        provider: Option<&str>,
        key_alias: Option<&str>,
    ) -> Self {
        Self::Request {
            timestamp: now_timestamp(),
            kind: "ws".to_string(),
            method: "WS".to_string(),
            path: path.to_string(),
            status: None,
            latency_ms: Some(latency_ms),
            upstream: Some(upstream.to_string()),
            provider: provider.map(String::from),
            key_alias: key_alias.map(String::from),
            message: Some("upgraded".to_string()),
        }
    }

    /// Generic log record from the Rust log facade or the patched renderer console.
    pub fn log(level: &str, source: &str, target: Option<&str>, message: &str) -> Self {
        Self::Log {
            timestamp: now_timestamp(),
            level: level.to_string(),
            source: source.to_string(),
            target: target.map(String::from),
            message: message.to_string(),
        }
    }
}

pub fn now_timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
