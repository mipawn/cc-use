//! Daemon-side log::Log adapter. Every `log::info!` / `warn!` / `error!`
//! fired by code running inside the daemon process gets:
//!   - written to stderr (preserved for launchd logs / foreground dev runs)
//!   - optionally broadcast to the realtime console as a `ConsoleEvent::Log`,
//!     so the UI's Console page surfaces daemon logs alongside request events.
//!
//! The broadcast is filtered to our own crates (`cc_use*`) to avoid flooding
//! the UI with transitive dependency noise (rusqlite, hyper, rustls, ...).
//! Third-party logs still hit stderr unchanged.

use cc_use_lib::proxy::console::ConsoleEvent;
use log::{Log, Metadata, Record};
use tokio::sync::broadcast::Sender;

pub struct ConsoleLogger {
    sender: Sender<ConsoleEvent>,
}

impl ConsoleLogger {
    pub fn new(sender: Sender<ConsoleEvent>) -> Self {
        Self { sender }
    }
}

impl Log for ConsoleLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        // Accept everything at the logger level; overall threshold is
        // controlled by `log::set_max_level` in `install`.
        true
    }

    fn log(&self, record: &Record) {
        // Always write stderr so the launchd plist log file / dev terminal
        // still receives daemon output.
        eprintln!(
            "{} [{:>5}] {}: {}",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
            record.level(),
            record.target(),
            record.args()
        );

        // Only broadcast our own crates. Filters transient tokio/hyper/rustls
        // trace spam that would otherwise bury proxy events in the UI.
        let target = record.target();
        if !is_own_crate(target) {
            return;
        }

        let event = ConsoleEvent::log(
            &level_to_str(record.level()),
            "daemon",
            Some(target),
            &record.args().to_string(),
        );
        let _ = self.sender.send(event);
    }

    fn flush(&self) {}
}

fn is_own_crate(target: &str) -> bool {
    target.starts_with("cc_use")
        || target == "cc_use_lib"
        || target == "cc_use_daemon"
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

/// Attempt to become the process-global logger. If another logger was
/// already installed (shouldn't happen in our daemon, but library code
/// could theoretically do it) we silently fall back to stderr-only.
pub fn install(sender: Sender<ConsoleEvent>) {
    let logger = ConsoleLogger::new(sender);
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_crate_filter_accepts_cc_use_targets() {
        assert!(is_own_crate("cc_use_daemon::runtime"));
        assert!(is_own_crate("cc_use_lib::proxy::handler"));
        assert!(is_own_crate("cc_use"));
    }

    #[test]
    fn own_crate_filter_rejects_third_party() {
        assert!(!is_own_crate("hyper::server"));
        assert!(!is_own_crate("rusqlite::cache"));
        assert!(!is_own_crate("tokio::runtime"));
        assert!(!is_own_crate("rustls::conn"));
    }

    #[test]
    fn log_event_carries_level_target_and_message() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let logger = ConsoleLogger::new(tx);
        logger.log(
            &Record::builder()
                .args(format_args!("ready on port 22345"))
                .level(log::Level::Info)
                .target("cc_use_daemon::runtime")
                .build(),
        );

        let event = rx.try_recv().expect("event was broadcast");
        match event {
            ConsoleEvent::Log {
                level,
                source,
                target,
                message,
                ..
            } => {
                assert_eq!(level, "info");
                assert_eq!(source, "daemon");
                assert_eq!(target.as_deref(), Some("cc_use_daemon::runtime"));
                assert_eq!(message, "ready on port 22345");
            }
            other => panic!("expected Log variant, got {:?}", other),
        }
    }

    #[test]
    fn third_party_target_is_not_broadcast() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let logger = ConsoleLogger::new(tx);
        logger.log(
            &Record::builder()
                .args(format_args!("some hyper noise"))
                .level(log::Level::Debug)
                .target("hyper::server")
                .build(),
        );
        assert!(rx.try_recv().is_err(), "third-party log must not broadcast");
    }
}
