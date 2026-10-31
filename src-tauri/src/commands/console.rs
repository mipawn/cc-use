//! Console history commands.
//!
//! The renderer keeps a small live buffer; these read the bounded on-disk
//! history back after a reload or restart. Reading is cheap and never touches
//! the network or the daemon's proxy path.
//!
//! Three owners write console history: the daemon (its own `daemon-*` files),
//! the app process (`app-*`) and the renderer via [`console_log_append_renderer`]
//! (which the backend persists under the app owner). A process only ever
//! deletes its own files, so clearing asks the daemon over the management API
//! instead of unlinking files it is still appending to.

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::db::Database;
use crate::proxy::console::{desensitize_body, ConsoleEvent};
use crate::services::console_log_store::{
    read_recent, ConsoleLogHandle, ConsoleLogPage, ConsoleLogSource, ConsoleLogSourceStatus,
    SOURCES,
};

/// Hard limits for the renderer persistence bridge. The bridge already batches
/// to these sizes; the backend re-validates because an IPC payload is not a
/// trust boundary.
pub const RENDERER_BATCH_MAX_RECORDS: usize = 50;
pub const RENDERER_BATCH_MAX_BYTES: usize = 64 * 1024;
pub const RENDERER_MESSAGE_MAX_BYTES: usize = 16 * 1024;
pub const RENDERER_TARGET_MAX_BYTES: usize = 1024;
pub const RENDERER_ID_MAX_BYTES: usize = 128;
/// A renderer record stamped further into the future than this is invalid.
const RENDERER_FUTURE_TOLERANCE_MINUTES: i64 = 60;

const RENDERER_LEVELS: [&str; 4] = ["error", "warn", "info", "debug"];

/// Per-owner writer state returned by `console_log_status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogStatus {
    /// Legacy total kept for older callers; equals the sum of the per-owner
    /// counters that are reachable (an offline owner contributes nothing).
    pub dropped: u64,
    pub app: ConsoleLogSourceStatus,
    /// `available: false` when the daemon is offline; never pretend it is zero.
    pub daemon: ConsoleLogSourceStatus,
}

/// Per-owner result of an explicit clear. One owner failing is visible instead
/// of being collapsed into a global success.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogClearResult {
    pub ok: bool,
    pub app: bool,
    pub daemon: bool,
}

/// Enqueue result of one renderer batch; it is *not* a disk acknowledgement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogAppendResult {
    pub accepted: usize,
    pub rejected: usize,
}

/// One renderer `console.*` line as sent by the persistence bridge. The
/// backend forces `source: "renderer"`; there is deliberately no source field
/// here, so a caller cannot forge another owner's records.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererLogRecordInput {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    #[serde(default)]
    pub target: Option<String>,
    pub message: String,
}

/// Sources to include. Unknown names are rejected rather than silently ignored,
/// so a typo cannot quietly hide half the history.
fn resolve_sources(sources: &[String]) -> Result<Vec<ConsoleLogSource>, String> {
    if sources.is_empty() {
        return Ok(SOURCES.to_vec());
    }
    sources
        .iter()
        .map(|name| {
            ConsoleLogSource::parse(name)
                .ok_or_else(|| format!("Unknown console log source: {}", name))
        })
        .collect()
}

/// Most recent records, oldest first. `truncated` and `retention` describe why
/// the page might not contain the whole recovery window.
#[tauri::command]
pub fn console_log_read_recent(
    sources: Vec<String>,
    limit: Option<usize>,
) -> Result<ConsoleLogPage, String> {
    let dir = crate::services::console_log_store::console_log_dir()
        .ok_or_else(|| "Cannot locate the console log directory".to_string())?;
    let sources = resolve_sources(&sources)?;
    Ok(read_recent(
        &dir,
        &sources,
        limit.unwrap_or(500).clamp(1, 5_000),
    ))
}

/// Per-owner writer state: enqueue drops, write failures, trims, size-budget
/// eviction and the daemon's availability. The daemon is queried over its
/// management API so an offline daemon is reported as unavailable rather than
/// as a healthy zero.
#[tauri::command]
pub async fn console_log_status(
    db: State<'_, Arc<Mutex<Database>>>,
    state: State<'_, Arc<ConsoleLogHandle>>,
) -> Result<ConsoleLogStatus, String> {
    let app = state.status();
    let daemon = request_daemon_log_status(db.inner())
        .await
        .unwrap_or_else(ConsoleLogSourceStatus::unavailable);
    Ok(ConsoleLogStatus {
        dropped: app.dropped.saturating_add(daemon.dropped),
        app,
        daemon,
    })
}

/// Persist one renderer log batch.
///
/// Validation happens here, at the trust boundary: the whole batch is rejected
/// when it exceeds the count/serialized-size limits, invalid items are counted
/// individually, `source` is forced to `renderer`, and every accepted record is
/// redacted before it is handed to the app writer's bounded queue. The result
/// counts *enqueues*, not disk writes, and the batch is never broadcast back to
/// the renderer (it already displayed those lines live).
#[tauri::command]
pub fn console_log_append_renderer(
    state: State<'_, Arc<ConsoleLogHandle>>,
    records: Vec<RendererLogRecordInput>,
) -> ConsoleLogAppendResult {
    append_renderer_records(state.inner(), &records, Utc::now())
}

/// Drop the console history of both processes.
///
/// The app closes and removes its own files and waits for that to finish; the
/// daemon owns its files, so it is asked over the management API and the call
/// only succeeds after the daemon confirmed its own clear. Statistics and Auto
/// mode audit rows live in the database and are untouched. When one owner
/// fails, the per-owner result is returned instead of a blanket success.
#[tauri::command]
pub async fn console_log_clear(
    db: State<'_, Arc<Mutex<Database>>>,
    state: State<'_, Arc<ConsoleLogHandle>>,
) -> Result<ConsoleLogClearResult, String> {
    // `clear_and_wait` blocks on the writer thread for up to 5 s. This command
    // is async, so run it on the blocking pool instead of stalling the async
    // runtime (the daemon already does the same in its management handler).
    let handle = Arc::clone(state.inner());
    let app = tokio::task::spawn_blocking(move || {
        handle
            .clear_and_wait(std::time::Duration::from_secs(5))
            .is_ok()
    })
    .await
    .unwrap_or(false);
    let daemon = request_daemon_clear(db.inner()).await;
    Ok(ConsoleLogClearResult {
        ok: app && daemon,
        app,
        daemon,
    })
}

// ── daemon round-trips ──

fn daemon_target(db: &Arc<Mutex<Database>>) -> Option<(i32, String)> {
    let port = {
        let db = db.lock().ok()?;
        db.settings_get().ok()?.proxy_port
    };
    let home = dirs::home_dir()?;
    let paths = crate::shared_runtime::ManagementTokenPaths::from_home(&home);
    let token = crate::shared_runtime::read_management_token(&paths).ok()??;
    Some((port, token))
}

fn daemon_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .unwrap_or_default()
}

/// Read the daemon's own per-owner counters. `None` means offline/unauthorized,
/// which the caller reports as `available: false`.
async fn request_daemon_log_status(db: &Arc<Mutex<Database>>) -> Option<ConsoleLogSourceStatus> {
    let (port, token) = daemon_target(db)?;
    let response = daemon_client()
        .get(format!(
            "http://127.0.0.1:{}/_management/console/log-status",
            port
        ))
        .header("x-cc-use-management-token", &token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<ConsoleLogSourceStatus>().await.ok()
}

/// Ask the daemon to drop its own files. It owns them; deleting a file another
/// process is still appending to would corrupt its writer. The request only
/// resolves when the daemon has finished clearing.
async fn request_daemon_clear(db: &Arc<Mutex<Database>>) -> bool {
    let Some((port, token)) = daemon_target(db) else {
        return false;
    };
    daemon_client()
        .post(format!(
            "http://127.0.0.1:{}/_management/console/clear",
            port
        ))
        .header("x-cc-use-management-token", &token)
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

// ── renderer batch validation ──

fn parse_renderer_timestamp(value: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|naive| DateTime::from_naive_utc_and_offset(naive, Utc))
}

fn valid_renderer_id(id: &str) -> bool {
    if id.is_empty() || id.len() > RENDERER_ID_MAX_BYTES || !id.starts_with("renderer-") {
        return false;
    }
    id.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

/// Validate and normalise one renderer record into the event the store writes.
/// The returned event always has `source: "renderer"`, whatever the caller sent.
fn prepare_renderer_event(
    input: &RendererLogRecordInput,
    now: DateTime<Utc>,
) -> Result<ConsoleEvent, ()> {
    if !valid_renderer_id(&input.id) {
        return Err(());
    }
    let timestamp = parse_renderer_timestamp(&input.timestamp).ok_or(())?;
    if timestamp > now + chrono::Duration::minutes(RENDERER_FUTURE_TOLERANCE_MINUTES) {
        return Err(());
    }
    if !RENDERER_LEVELS.contains(&input.level.as_str()) {
        return Err(());
    }
    let target = match input.target.as_deref() {
        // An empty string is normalised away instead of persisted as an empty
        // target that the UI would render as if it were known.
        None | Some("") => None,
        Some(target) => {
            if target.len() > RENDERER_TARGET_MAX_BYTES {
                return Err(());
            }
            Some(target.to_string())
        }
    };
    if input.message.len() > RENDERER_MESSAGE_MAX_BYTES {
        return Err(());
    }
    // Credentials are removed before the record reaches the queue, mirroring
    // what the store does again when it serialises the line.
    let message = desensitize_body(&input.message);
    Ok(ConsoleEvent::Log {
        id: input.id.clone(),
        timestamp: input.timestamp.clone(),
        level: input.level.clone(),
        source: "renderer".to_string(),
        target,
        message,
    })
}

/// Validate one batch and enqueue every accepted record. Exposed for in-module
/// tests; the Tauri wrapper only supplies the clock and the handle.
pub fn append_renderer_records(
    handle: &ConsoleLogHandle,
    records: &[RendererLogRecordInput],
    now: DateTime<Utc>,
) -> ConsoleLogAppendResult {
    let mut result = ConsoleLogAppendResult {
        accepted: 0,
        rejected: 0,
    };
    if records.len() > RENDERER_BATCH_MAX_RECORDS {
        result.rejected = records.len();
        return result;
    }
    // Re-check the serialized UTF-8 size the bridge promised to respect. An
    // oversized batch is rejected whole rather than partially persisted.
    match serde_json::to_vec(records) {
        Ok(serialized) if serialized.len() <= RENDERER_BATCH_MAX_BYTES => {}
        _ => {
            result.rejected = records.len();
            return result;
        }
    }
    for input in records {
        match prepare_renderer_event(input, now) {
            Ok(event) => {
                if handle.record(event) {
                    result.accepted += 1;
                } else {
                    // Bounded queue full: the record never entered the store.
                    result.rejected += 1;
                }
            }
            Err(()) => result.rejected += 1,
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::console_log_store::{
        read_recent, ConsoleLogDirLock, ConsoleLogHandle, ConsoleLogLimits, ConsoleLogOptions,
        ConsoleLogSource, ConsoleLogSourceStatus,
    };
    use std::time::Duration;

    fn utc_now_timestamp() -> String {
        Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
    }

    fn record(id: &str, message: &str) -> RendererLogRecordInput {
        RendererLogRecordInput {
            id: id.to_string(),
            timestamp: utc_now_timestamp(),
            level: "info".to_string(),
            target: Some("renderer:test".to_string()),
            message: message.to_string(),
        }
    }

    fn spawn_app(dir: &std::path::Path) -> ConsoleLogHandle {
        ConsoleLogHandle::spawn(dir.to_path_buf(), ConsoleLogSource::App)
            .expect("console log store")
    }

    fn renderer_page(dir: &std::path::Path) -> ConsoleLogPage {
        read_recent(dir, &[ConsoleLogSource::App], 10_000)
    }

    #[test]
    fn a_forged_source_field_cannot_change_the_owner_or_the_event_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        let forged: RendererLogRecordInput = serde_json::from_value(serde_json::json!({
            "id": "renderer-epoch-1",
            "timestamp": utc_now_timestamp(),
            "level": "warn",
            "target": "renderer:forged",
            "message": "forged owner",
            "source": "daemon",
            "requestId": "req-forged",
        }))
        .expect("unknown fields are ignored, not trusted");

        let result = append_renderer_records(&handle, &[forged], Utc::now());
        assert_eq!(
            result,
            ConsoleLogAppendResult {
                accepted: 1,
                rejected: 0
            }
        );
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();

        let page = renderer_page(dir.path());
        let stored = page.records.first().expect("persisted");
        assert_eq!(stored.source, "app", "the file belongs to the app owner");
        match &stored.event {
            ConsoleEvent::Log { source, level, .. } => {
                assert_eq!(source, "renderer", "source is forced by the backend");
                assert_eq!(level, "warn");
            }
            other => panic!("expected a log event, got {:?}", other),
        }
        assert_eq!(page.records.len(), 1);
    }

    #[test]
    fn the_fifty_record_batch_boundary_is_enforced_with_multibyte_text() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        let records: Vec<RendererLogRecordInput> = (0..50)
            .map(|index| record(&format!("renderer-epoch-{index}"), "日志记录 log line"))
            .collect();
        let result = append_renderer_records(&handle, &records, Utc::now());
        assert_eq!(result.accepted, 50, "exactly 50 records are accepted");
        assert_eq!(result.rejected, 0);

        let too_many: Vec<RendererLogRecordInput> = (0..51)
            .map(|index| record(&format!("renderer-epoch-x{index}"), "one line"))
            .collect();
        let rejected = append_renderer_records(&handle, &too_many, Utc::now());
        assert_eq!(
            rejected,
            ConsoleLogAppendResult {
                accepted: 0,
                rejected: 51
            },
            "an oversized whole batch is rejected before item validation"
        );
    }

    #[test]
    fn a_batch_over_64_kib_of_serialized_utf8_is_rejected_whole() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        // Each body is inside the 16 KiB per-record limit, but six of them push
        // the serialized batch past 64 KiB.
        let body = "界".repeat(4_096); // 3 bytes each => 12 KiB
        let records: Vec<RendererLogRecordInput> = (0..6)
            .map(|index| record(&format!("renderer-epoch-b{index}"), &body))
            .collect();
        let result = append_renderer_records(&handle, &records, Utc::now());
        assert_eq!(result.accepted, 0);
        assert_eq!(result.rejected, 6);
        assert!(
            renderer_page(dir.path()).records.is_empty(),
            "nothing partial is persisted"
        );
    }

    #[test]
    fn a_message_over_16_kib_is_rejected_individually_with_utf8_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        // 8192 two-byte characters are exactly 16 KiB; one more byte is over.
        let at_limit = "é".repeat(RENDERER_MESSAGE_MAX_BYTES / 2);
        let over_limit = format!("{}x", at_limit);
        assert_eq!(at_limit.len(), 16 * 1024);
        let records = vec![
            record("renderer-epoch-ok", &at_limit),
            record("renderer-epoch-over", &over_limit),
        ];
        let result = append_renderer_records(&handle, &records, Utc::now());
        assert_eq!(
            result,
            ConsoleLogAppendResult {
                accepted: 1,
                rejected: 1
            }
        );
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        let page = renderer_page(dir.path());
        assert_eq!(page.records.len(), 1);
        match &page.records[0].event {
            ConsoleEvent::Log { message, .. } => {
                assert_eq!(message.len(), RENDERER_MESSAGE_MAX_BYTES);
            }
            other => panic!("expected a log event, got {:?}", other),
        }
    }

    #[test]
    fn invalid_items_are_counted_individually_and_valid_ones_still_land() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        let mut bad_id = record("unused", "bad id");
        bad_id.id = "daemon-1".to_string();
        let mut bad_level = record("renderer-epoch-level", "bad level");
        bad_level.level = "trace".to_string();
        let mut bad_timestamp = record("renderer-epoch-time", "bad time");
        bad_timestamp.timestamp = "yesterday".to_string();
        let mut forged_target = record("renderer-epoch-target", "huge target");
        forged_target.target = Some("t".repeat(RENDERER_TARGET_MAX_BYTES + 1));
        let mut future = record("renderer-epoch-future", "future time");
        future.timestamp = (Utc::now() + chrono::Duration::hours(4))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();

        let records = vec![
            record("renderer-epoch-good", "kept"),
            bad_id,
            bad_level,
            bad_timestamp,
            forged_target,
            future,
        ];
        let result = append_renderer_records(&handle, &records, Utc::now());
        assert_eq!(
            result,
            ConsoleLogAppendResult {
                accepted: 1,
                rejected: 5
            }
        );
    }

    #[test]
    fn a_full_queue_counts_as_rejected_and_never_blocks() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Tiny file budget forces a rotation (which needs the directory lock)
        // for every record, so the writer drains slowly enough to fill a
        // two-slot queue while the directory lock is held.
        let mut limits = ConsoleLogLimits::default();
        limits.max_file_bytes = 64;
        let options = ConsoleLogOptions {
            limits,
            queue_capacity: 2,
            dir_lock_timeout: Duration::from_millis(20),
            maintenance_interval: Duration::from_secs(30),
            ..ConsoleLogOptions::default()
        };
        let handle =
            ConsoleLogHandle::spawn_with(dir.path().to_path_buf(), ConsoleLogSource::App, options)
                .expect("console log store");

        let held = ConsoleLogDirLock::acquire(dir.path(), Duration::from_secs(1))
            .expect("hold directory lock");
        let records: Vec<RendererLogRecordInput> = (0..20)
            .map(|index| record(&format!("renderer-epoch-q{index}"), "queue test"))
            .collect();
        let result = append_renderer_records(&handle, &records, Utc::now());
        assert!(
            result.rejected >= 15,
            "the bounded queue refuses rather than blocking, got {:?}",
            result
        );
        assert!(handle.dropped() > 0, "queue overflow is counted");
        drop(held);
    }

    #[test]
    fn a_disk_write_failure_is_counted_and_never_panics() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut limits = ConsoleLogLimits::default();
        // Every record forces a rotation, which will fail once the directory is
        // unusable.
        limits.max_file_bytes = 64;
        let handle = ConsoleLogHandle::spawn_with(
            dir.path().to_path_buf(),
            ConsoleLogSource::App,
            ConsoleLogOptions {
                limits,
                ..ConsoleLogOptions::default()
            },
        )
        .expect("console log store");

        // Replace the directory with a plain file: the writer still holds its
        // open descriptor, but a rotation cannot recreate the directory.
        let blocked_dir = dir.path().to_path_buf();
        for entry in std::fs::read_dir(&blocked_dir).unwrap().flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        std::fs::remove_dir(&blocked_dir).unwrap();
        std::fs::write(&blocked_dir, b"not a directory").unwrap();

        let result = append_renderer_records(
            &handle,
            &[record("renderer-epoch-disk", "disk failure")],
            Utc::now(),
        );
        assert_eq!(result.accepted, 1, "the enqueue itself succeeded");
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        assert!(
            handle.write_failed() > 0,
            "a failed write is counted, not panicked"
        );
        assert!(handle.status().available, "status is still safe to read");
        // Keep the handle alive past the temp dir cleanup, which cannot remove
        // the (now file) path anyway.
        std::mem::forget(handle);
        let _ = std::fs::remove_file(blocked_dir);
    }

    #[test]
    fn credentials_in_a_renderer_message_are_redacted_on_disk() {
        let dir = tempfile::tempdir().expect("temp dir");
        let handle = spawn_app(dir.path());
        let result = append_renderer_records(
            &handle,
            &[record(
                "renderer-epoch-secret",
                "provider rejected key sk-live-abcdef123456",
            )],
            Utc::now(),
        );
        assert_eq!(result.accepted, 1);
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();

        let active = dir
            .path()
            .read_dir()
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().ends_with(".jsonl"))
                    .unwrap_or(false)
            })
            .expect("active file");
        let raw = std::fs::read_to_string(active).unwrap();
        assert!(
            !raw.contains("sk-live-abcdef123456"),
            "the renderer's credential-looking token never reaches the file"
        );
        assert!(raw.contains("provider rejected key"));
    }

    #[test]
    fn status_reports_an_unavailable_owner_instead_of_a_healthy_zero() {
        let unavailable = ConsoleLogSourceStatus::unavailable();
        assert!(!unavailable.available);
        assert_eq!(unavailable.dropped, 0);
        // The legacy total survives for older callers.
        let status = ConsoleLogStatus {
            dropped: 3,
            app: ConsoleLogSourceStatus {
                available: true,
                dropped: 3,
                write_failed: 1,
                trimmed: 2,
                capacity_evicted: true,
            },
            daemon: unavailable,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["dropped"], serde_json::json!(3));
        assert_eq!(value["app"]["writeFailed"], serde_json::json!(1));
        assert_eq!(value["app"]["capacityEvicted"], serde_json::json!(true));
        assert_eq!(value["daemon"]["available"], serde_json::json!(false));
    }

    #[test]
    fn read_recent_rejects_unknown_source_names() {
        assert!(resolve_sources(&["daemon".to_string()]).is_ok());
        assert!(resolve_sources(&["renderer".to_string()]).is_err());
    }
}
