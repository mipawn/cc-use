//! App-side log::Log adapter. Mirrors `console_logger` in the daemon crate,
//! but the transport is Tauri event emit instead of a broadcast channel
//! because we're already inside the app process that owns the webview.
//!
//! Every `log::info!` / `warn!` / `error!` call from cc_use* crates becomes
//! a `ConsoleEvent::Log` visible on the Console page, alongside daemon logs
//! forwarded via SSE and proxy request events. Third-party dependency noise
//! (hyper, rustls, rusqlite, ...) is still written to stderr but not
//! broadcast to the UI.

use crate::proxy::console::ConsoleEvent;
use log::{Log, Metadata, Record};
use tauri::{AppHandle, Emitter};

/// Tauri event name — same channel as the SSE bridge, so the renderer can
/// subscribe once and get both daemon-forwarded events and app-local logs.
pub const CONSOLE_EVENT_NAME: &str = "proxy:consoleEvent";

pub struct AppLogger {
    handle: AppHandle,
}

impl AppLogger {
    pub fn new(handle: AppHandle) -> Self {
        Self { handle }
    }
}

impl Log for AppLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        true
    }

    fn log(&self, record: &Record) {
        // Preserve stderr so `pnpm dev` consoles and macOS unified logs
        // still see the message.
        eprintln!(
            "{} [{:>5}] {}: {}",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
            record.level(),
            record.target(),
            record.args()
        );

        let target = record.target();
        if !is_own_crate(target) {
            return;
        }

        let event = ConsoleEvent::log(
            &level_to_str(record.level()),
            "app",
            Some(target),
            &record.args().to_string(),
        );
        let _ = self.handle.emit(CONSOLE_EVENT_NAME, event);
    }

    fn flush(&self) {}
}

fn is_own_crate(target: &str) -> bool {
    target.starts_with("cc_use") || target == "cc_use_lib"
}

fn level_to_str(level: log::Level) -> String {
    match level {
        log::Level::Error => "error",
        log::Level::Warn => "warn",
        log::Level::Info => "info",
        log::Level::Debug => "debug",
        log::Level::Trace => "trace",
    }
    .to_string()
}

/// Attempt to install the logger. Called from `setup()` once the AppHandle
/// is available. If another logger was already set (shouldn't happen — we
/// don't use any tauri-plugin-log) we silently fall back to stderr only.
pub fn install(handle: AppHandle) {
    if log::set_boxed_logger(Box::new(AppLogger::new(handle))).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_crate_filter_accepts_cc_use_targets() {
        assert!(is_own_crate("cc_use::services::console_bridge"));
        assert!(is_own_crate("cc_use_lib::proxy::handler"));
    }

    #[test]
    fn own_crate_filter_rejects_third_party() {
        assert!(!is_own_crate("rusqlite"));
        assert!(!is_own_crate("tauri::runtime"));
    }
}
