//! Client side of the realtime console. Runs inside the Tauri app process,
//! keeps an SSE connection open to the local daemon's /_management/console/stream
//! endpoint, and forwards every event into a Tauri event so the renderer's
//! Console page can observe traffic live.
//!
//! Single-connection on purpose: daemon and app are both on 127.0.0.1, only
//! one Console page subscribes at a time, and reconnect on drop is cheap.
//! External signals (port change, manual restart) flip a `Notify` that
//! breaks the current loop iteration.

use crate::db::Database;
use crate::proxy::console::ConsoleEvent;
use crate::shared_runtime::{read_management_token, ManagementTokenPaths};
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Tauri event name delivered to the renderer for every console payload.
pub const CONSOLE_EVENT_NAME: &str = "proxy:consoleEvent";

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Control handle stored in Tauri state; callers (settings_update, manual
/// command) flip `restart()` to force an immediate reconnect.
#[derive(Clone)]
pub struct ConsoleBridgeHandle {
    restart: Arc<Notify>,
}

impl ConsoleBridgeHandle {
    /// Break the current SSE connection and loop back to connect again.
    /// Used when proxyPort changes or a daemon restart is expected.
    pub fn restart(&self) {
        self.restart.notify_one();
    }
}

/// Spawn the bridge. The task lives as long as the app process; it reconnects
/// forever with capped backoff. A failing daemon is silent — the Console page
/// is a diagnostic tool, not a load-bearing feature, so propagating errors
/// into the UI would just add noise.
pub fn spawn_console_bridge(handle: AppHandle, db: Arc<Mutex<Database>>) -> ConsoleBridgeHandle {
    let restart = Arc::new(Notify::new());
    let bridge_restart = restart.clone();

    tauri::async_runtime::spawn(async move {
        let mut backoff = BACKOFF_MIN;

        loop {
            let Some((port, token)) = load_config(&db) else {
                wait_for_next(&bridge_restart, backoff).await;
                backoff = bump_backoff(backoff);
                continue;
            };

            match run_once(&handle, port, &token, &bridge_restart).await {
                RunOutcome::RestartRequested => {
                    // clean break driven by external signal — reset backoff
                    backoff = BACKOFF_MIN;
                }
                RunOutcome::ConnectionLost => {
                    wait_for_next(&bridge_restart, backoff).await;
                    backoff = bump_backoff(backoff);
                }
            }
        }
    });

    ConsoleBridgeHandle { restart }
}

enum RunOutcome {
    RestartRequested,
    ConnectionLost,
}

async fn run_once(handle: &AppHandle, port: i32, token: &str, restart: &Notify) -> RunOutcome {
    let url = format!("http://127.0.0.1:{}/_management/console/stream", port);

    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return RunOutcome::ConnectionLost,
    };

    let resp = match client
        .get(&url)
        .header("x-cc-use-management-token", token)
        .header("accept", "text/event-stream")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return RunOutcome::ConnectionLost,
    };

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            _ = restart.notified() => return RunOutcome::RestartRequested,
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        if let Ok(s) = std::str::from_utf8(&bytes) {
                            buffer.push_str(s);
                            drain_complete_records(&mut buffer, |record| {
                                emit_record(handle, record);
                            });
                        }
                    }
                    Some(Err(_)) | None => return RunOutcome::ConnectionLost,
                }
            }
        }
    }
}

/// SSE frames are separated by a blank line. Each frame may contain `event:`,
/// `data:`, or comment (`:`) lines. Our daemon only emits `data: <json>\n\n`
/// plus `:keepalive` comments — we parse both correctly by splitting on the
/// blank-line boundary and then scanning each frame for `data:` prefixes.
fn drain_complete_records<F: FnMut(&str)>(buffer: &mut String, mut handler: F) {
    while let Some(idx) = buffer.find("\n\n") {
        let record = buffer[..idx].to_string();
        buffer.drain(..idx + 2);
        handler(&record);
    }
}

fn emit_record(handle: &AppHandle, record: &str) {
    for line in record.lines() {
        // `data:` lines carry the JSON payload. `:` comments (keepalive) and
        // `event:` meta lines are ignored on purpose.
        let payload = match line.strip_prefix("data: ") {
            Some(p) => p,
            None => match line.strip_prefix("data:") {
                Some(p) => p,
                None => continue,
            },
        };
        match serde_json::from_str::<ConsoleEvent>(payload) {
            Ok(event) => {
                if is_billable_request_event(&event) {
                    crate::tray::refresh_tray_badge(handle);
                }
                let _ = handle.emit(CONSOLE_EVENT_NAME, event);
            }
            Err(err) => {
                eprintln!("console_bridge: bad event JSON: {}", err);
            }
        }
    }
}

fn is_billable_request_event(event: &ConsoleEvent) -> bool {
    matches!(
        event,
        ConsoleEvent::Request {
            kind,
            status: Some(status),
            ..
        } if kind == "ok" && *status < 400
    )
}

async fn wait_for_next(restart: &Notify, backoff: Duration) {
    tokio::select! {
        _ = restart.notified() => (),
        _ = tokio::time::sleep(backoff) => (),
    }
}

fn bump_backoff(backoff: Duration) -> Duration {
    (backoff * 2).min(BACKOFF_MAX)
}

fn load_config(db: &Arc<Mutex<Database>>) -> Option<(i32, String)> {
    let port = {
        let db = db.lock().ok()?;
        db.settings_get().ok()?.proxy_port
    };
    let home = dirs::home_dir()?;
    let paths = ManagementTokenPaths::from_home(&home);
    let token = read_management_token(&paths).ok()??;
    Some((port, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(buffer: &mut String) -> Vec<String> {
        let mut out = Vec::new();
        drain_complete_records(buffer, |record| out.push(record.to_string()));
        out
    }

    #[test]
    fn drains_only_complete_frames() {
        let mut buf = String::from("data: first\n\ndata: seco");
        let records = collect(&mut buf);
        assert_eq!(records, vec!["data: first".to_string()]);
        assert_eq!(buf, "data: seco");
    }

    #[test]
    fn drains_multiple_frames_in_one_pass() {
        let mut buf = String::from("data: a\n\ndata: b\n\n:keepalive\n\n");
        let records = collect(&mut buf);
        assert_eq!(
            records,
            vec![
                "data: a".to_string(),
                "data: b".to_string(),
                ":keepalive".to_string()
            ]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn leaves_partial_frame_untouched() {
        let mut buf = String::from("data: still buffering");
        let records = collect(&mut buf);
        assert!(records.is_empty());
        assert_eq!(buf, "data: still buffering");
    }

    #[test]
    fn billable_request_event_matches_successful_request() {
        let event = ConsoleEvent::ok(
            "request-test",
            "POST",
            "/v1/messages",
            200,
            123,
            "http://127.0.0.1/upstream",
            Some("provider"),
            Some("key"),
            false,
        );

        assert!(is_billable_request_event(&event));
    }

    #[test]
    fn billable_request_event_ignores_logs_and_errors() {
        let log_event = ConsoleEvent::log("info", "daemon", None, "ready");
        let error_event = ConsoleEvent::upstream_error(
            "request-test",
            "POST",
            "/v1/messages",
            123,
            "http://127.0.0.1/upstream",
            Some("provider"),
            Some("key"),
            "boom",
        );

        assert!(!is_billable_request_event(&log_event));
        assert!(!is_billable_request_event(&error_event));
    }

    #[test]
    fn backoff_caps_at_max() {
        let mut current = BACKOFF_MIN;
        for _ in 0..20 {
            current = bump_backoff(current);
        }
        assert_eq!(current, BACKOFF_MAX);
    }
}
