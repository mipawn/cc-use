//! Bounded on-disk store for console events.
//!
//! The daemon records its own requests and diagnostic logs here, so history
//! survives the GUI being closed. The app records its own logs and the
//! renderer's. Each process owns a separate file family — `daemon-*` versus
//! `app-*` — so two processes never contend for one active file, and neither
//! ever deletes a file the other still has open.
//!
//! # Retention
//!
//! This is a bounded recovery window, not an archive. Records are kept for the
//! current local natural day plus the two before it (three local days in
//! total). The record timestamp is UTC (`YYYY-MM-DD HH:MM:SS`), so every
//! comparison converts the event time into the *current* system time-zone
//! offset before taking its natural day; a UTC string is never parsed as if it
//! were local. A maintenance pass runs when a writer starts (catching up after
//! the machine was asleep or the app was closed), whenever the local date or
//! the UTC offset changes (checked before every append and on an idle timer),
//! and compacts closed files record-by-record. Records whose timestamp is
//! unparseable or implausibly far in the future are counted as corrupt and
//! dropped, so a bogus timestamp cannot survive the retention window forever.
//!
//! # Ownership and concurrency
//!
//! A writer never reuses a previous process's active file: every process start
//! allocates a fresh epoch identity, while the old records stay replayable.
//! Day rollover flushes and closes the current active file before a new one is
//! created. The active file is protected from TTL and capacity eviction;
//! corrupt lines are skipped and counted; a mixed-day closed file is rewritten
//! through a unique temp file and atomically renamed, preserving every kept
//! record's id/epoch/seq.
//!
//! Directory-level mutations (rotation, compaction, clear, meta rewrites) are
//! serialized in-process and then across processes with an advisory `flock`
//! (via `libc`, no extra crate) on `<dir>/.maintenance.lock`. Lock failures are
//! exposed as maintenance state instead of being written back into the log
//! channel — a logger that logs its own failure would recurse.
//!
//! # Capacity
//!
//! The previous size budget is unchanged: 10 MiB per file, at most 5 files per
//! source (including the active one), 50 MiB per source. Two sources fit the
//! historical 100 MiB total by construction, so no cross-source deletion is
//! attempted. TTL maintenance runs before capacity eviction so a normal day
//! rollover is not misreported as the size budget evicting data.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::proxy::console::{desensitize_body, ConsoleEvent};

/// 10 MiB, checked before each append.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Including the file currently being written.
pub const MAX_FILES_PER_SOURCE: usize = 5;
/// 50 MiB per source, 100 MiB across every source.
pub const MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;
/// Budget shared by both sources. Each source already enforces half of it, so
/// the store never deletes another source's files to satisfy this number.
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
/// Longest single record we persist. Detail is trimmed to fit before writing.
pub const MAX_RECORD_BYTES: usize = 256 * 1024;
/// Records kept in memory by the UI; also the default page size for reads.
pub const RECENT_RECORD_LIMIT: usize = 500;
/// Current local natural day plus the two before it.
pub const RETENTION_LOCAL_DAYS: i64 = 3;
/// A record stamped further than this into the future is corrupt data, not a
/// fresher record; treating it as such keeps the TTL meaningful.
pub const FUTURE_TOLERANCE_MINUTES: i64 = 60;

const RECORD_VERSION: u32 = 1;
const META_FILE: &str = "meta.json";
const LOCK_FILE: &str = ".maintenance.lock";
const QUEUE_CAPACITY: usize = 2048;
const DEFAULT_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(10);
const DEFAULT_DIR_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const READ_LOCK_TIMEOUT: Duration = Duration::from_millis(500);

/// Size budget for the store. Production uses [`ConsoleLogLimits::default`];
/// tests shrink it so rotation and eviction are exercised without writing
/// hundreds of megabytes.
#[derive(Clone, Copy, Debug)]
pub struct ConsoleLogLimits {
    pub max_file_bytes: u64,
    pub max_files_per_source: usize,
    pub max_source_bytes: u64,
    pub max_record_bytes: usize,
}

impl Default for ConsoleLogLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            max_files_per_source: MAX_FILES_PER_SOURCE,
            max_source_bytes: MAX_SOURCE_BYTES,
            max_record_bytes: MAX_RECORD_BYTES,
        }
    }
}

/// Which process owns a set of files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleLogSource {
    Daemon,
    App,
}

pub const SOURCES: [ConsoleLogSource; 2] = [ConsoleLogSource::Daemon, ConsoleLogSource::App];

impl ConsoleLogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ConsoleLogSource::Daemon => "daemon",
            ConsoleLogSource::App => "app",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "daemon" => Some(ConsoleLogSource::Daemon),
            "app" => Some(ConsoleLogSource::App),
            _ => None,
        }
    }
}

// ── clock ──

/// One wall-clock reading: the UTC instant plus the system time-zone offset at
/// that instant. Tests inject their own [`Clock`] so local-day boundaries can
/// be exercised without sleeping or mutating the process-wide `TZ`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClockSnapshot {
    pub utc: DateTime<Utc>,
    /// Minutes east of UTC (`local - utc`).
    pub local_offset_minutes: i32,
}

/// Source of the current time and local offset. Must be cheap: it is called on
/// every append.
pub trait Clock: Send + Sync {
    fn now(&self) -> ClockSnapshot;
}

/// Production clock backed by the operating system.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> ClockSnapshot {
        ClockSnapshot {
            utc: Utc::now(),
            local_offset_minutes: Local::now().offset().local_minus_utc() / 60,
        }
    }
}

/// The local natural day an instant belongs to, derived from its UTC value.
pub fn local_date_of(utc: DateTime<Utc>, offset_minutes: i32) -> NaiveDate {
    (utc + chrono::Duration::minutes(offset_minutes as i64)).date_naive()
}

fn parse_console_timestamp(value: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|naive| DateTime::from_naive_utc_and_offset(naive, Utc))
}

fn format_console_timestamp(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn event_timestamp(event: &ConsoleEvent) -> &str {
    match event {
        ConsoleEvent::Request { timestamp, .. } | ConsoleEvent::Log { timestamp, .. } => timestamp,
    }
}

/// Timestamp a record should be aged by: its event time, falling back to the
/// record's own `at` for legacy records that never carried one.
fn record_timestamp(record: &ConsoleLogRecord) -> &str {
    let event_time = event_timestamp(&record.event);
    if event_time.trim().is_empty() {
        record.at.as_str()
    } else {
        event_time
    }
}

/// The local day a record belongs to, or `None` when the timestamp is invalid
/// or anomalously in the future (both are corrupt data, never "keep forever").
fn record_local_day(record: &ConsoleLogRecord, now: ClockSnapshot) -> Option<NaiveDate> {
    let parsed = parse_console_timestamp(record_timestamp(record))
        .or_else(|| parse_console_timestamp(&record.at))?;
    if parsed > now.utc + chrono::Duration::minutes(FUTURE_TOLERANCE_MINUTES) {
        return None;
    }
    Some(local_date_of(parsed, now.local_offset_minutes))
}

/// Inclusive lower bound of the retention window: the oldest local day kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RetentionWindow {
    local_date: NaiveDate,
    offset_minutes: i32,
    start: NaiveDate,
}

impl RetentionWindow {
    fn from_snapshot(now: ClockSnapshot) -> Self {
        let local_date = local_date_of(now.utc, now.local_offset_minutes);
        Self {
            local_date,
            offset_minutes: now.local_offset_minutes,
            start: local_date - chrono::Duration::days(RETENTION_LOCAL_DAYS - 1),
        }
    }

    fn start_date_string(self) -> String {
        self.start.format("%Y-%m-%d").to_string()
    }
}

// ── records and pages ──

/// One persisted event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLogRecord {
    /// Format version. Readers skip records they do not understand.
    pub v: u32,
    pub source: String,
    /// Writer instance; changes when the owning process restarts, so a cursor
    /// from a previous writer is recognised as stale rather than wrong.
    pub epoch: String,
    /// Monotonic per writer, starting at 1. With `epoch` it forms the cursor.
    pub seq: u64,
    /// UTC `YYYY-MM-DD HH:MM:SS`.
    pub at: String,
    /// Dedup key shared with the live stream; empty when the event has none.
    #[serde(default)]
    pub id: String,
    pub event: ConsoleEvent,
}

impl ConsoleLogRecord {
    /// Key for merging a replayed record with the live stream. Falls back to
    /// the writer position for events that never had a stable identity, so
    /// those at least stay unique within the file.
    pub fn dedup_key(&self) -> String {
        if self.id.is_empty() {
            format!("{}:{}:{}", self.source, self.epoch, self.seq)
        } else {
            self.id.clone()
        }
    }
}

/// Retention state of the on-disk recovery window, carried on every read so
/// the UI can explain a short page instead of silently showing a gap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogRetention {
    /// Oldest local `YYYY-MM-DD` still kept; `None` when nothing is stored.
    pub retention_start_date: Option<String>,
    /// Older records were evicted by the size budget, not by the day window.
    pub capacity_evicted: bool,
    /// A record was cut down to the size limit before it was written.
    pub trimmed: bool,
    /// Lines skipped while reading/compacting because they were corrupt.
    pub corrupted: u64,
    /// This read was capped by `limit`, so older records may still exist.
    pub limited: bool,
}

/// One page of history plus the generation it was read under.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLogPage {
    /// Changes when history is cleared. A page read under a different
    /// generation than the reader last saw must replace, not merge.
    pub generation: String,
    pub records: Vec<ConsoleLogRecord>,
    /// True when something is missing from this page: the size budget evicted
    /// records, a corrupt stretch was skipped, or the read hit its limit.
    pub truncated: bool,
    /// Present for new readers; omitted only when the store is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<ConsoleLogRetention>,
}

/// Per-owner writer state. `available: false` means the owner is offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogSourceStatus {
    pub available: bool,
    pub dropped: u64,
    pub write_failed: u64,
    pub trimmed: u64,
    pub capacity_evicted: bool,
}

impl ConsoleLogSourceStatus {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            dropped: 0,
            write_failed: 0,
            trimmed: 0,
            capacity_evicted: false,
        }
    }
}

/// Maintenance health, exposed for status/tests rather than written into the
/// log channel (a failure to log must not log).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogMaintenanceState {
    pub lock_failures: u64,
    pub last_error: Option<String>,
}

/// Report of one maintenance pass. Tests use it to prove a pass ran even when
/// no record was appended.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogMaintenanceReport {
    pub ran: bool,
    pub compacted_files: usize,
    pub deleted_files: usize,
    pub dropped_expired: usize,
    pub dropped_corrupt: usize,
    /// Capacity pruning that ran after TTL maintenance.
    pub capacity_evicted: bool,
}

/// Where the daemon and the app keep their console records.
pub fn console_log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".cc-use").join("logs").join("console"))
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Only the current user may read request details.
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

// ── metadata ──

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ConsoleLogMeta {
    /// Legacy top-level generation. New writers keep per-source generations
    /// below; this field is still written so an older build can read the file.
    #[serde(default)]
    generation: String,
    /// Highest rotation index handed out per source.
    #[serde(default)]
    next_index: BTreeMap<String, u64>,
    /// Per-source state.
    #[serde(default)]
    sources: BTreeMap<String, SourceMeta>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SourceMeta {
    #[serde(default)]
    generation: String,
    /// Kept on disk so a restart can still explain a shortened recovery window.
    #[serde(default)]
    capacity_evicted: bool,
    /// Cumulative count of records trimmed to fit the record budget.
    #[serde(default)]
    trimmed: u64,
    /// Index of the newest file this owner created (diagnostics / protection).
    #[serde(default)]
    active_index: u64,
}

impl ConsoleLogMeta {
    fn source(&self, source: ConsoleLogSource) -> SourceMeta {
        self.sources
            .get(source.as_str())
            .cloned()
            .unwrap_or_default()
    }

    fn source_mut(&mut self, source: ConsoleLogSource) -> &mut SourceMeta {
        self.sources.entry(source.as_str().to_string()).or_default()
    }

    fn source_generation(&self, source: ConsoleLogSource) -> String {
        let generation = self.source(source).generation;
        if generation.is_empty() {
            self.generation.clone()
        } else {
            generation
        }
    }

    /// Stable global generation composed from every owner's own generation, so
    /// one owner clearing changes the value a reader sees without a
    /// last-writer-wins race on the shared file.
    fn composed_generation(&self) -> String {
        let mut parts = Vec::new();
        for source in SOURCES {
            parts.push(format!(
                "{}:{}",
                source.as_str(),
                self.source_generation(source)
            ));
        }
        let joined = parts.join(";");
        if joined == "daemon:;app:" {
            String::new()
        } else {
            joined
        }
    }
}

fn read_meta_unlocked(dir: &Path) -> ConsoleLogMeta {
    let Ok(raw) = fs::read_to_string(dir.join(META_FILE)) else {
        return ConsoleLogMeta::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Write the metadata through a unique temp file and an atomic rename. The
/// temp name carries a random suffix so two owners can never overwrite each
/// other's half-written copy.
fn write_meta_unlocked(dir: &Path, meta: &ConsoleLogMeta) -> std::io::Result<()> {
    let path = dir.join(META_FILE);
    let temp = dir.join(format!("{}.{}.tmp", META_FILE, nanoid::nanoid!(8)));
    let data = match serde_json::to_vec(meta) {
        Ok(data) => data,
        Err(error) => {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error));
        }
    };
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> std::io::Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(&data)?;
        file.flush()?;
        drop(file);
        fs::rename(&temp, &path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

/// Generation of the history currently on disk. Empty only before the first
/// record or clear, which readers treat as an initial state rather than a new
/// one.
pub fn current_generation(dir: &Path) -> String {
    read_meta_unlocked(dir).composed_generation()
}

// ── cross-process maintenance lock ──

static IN_PROCESS_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn in_process_lock(dir: &Path) -> Arc<Mutex<()>> {
    let map = IN_PROCESS_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .entry(dir.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn acquire_in_process<'a>(
    lock: &'a Mutex<()>,
    timeout: Duration,
) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err("console log store is busy".to_string());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

fn open_lock_file(dir: &Path) -> std::io::Result<File> {
    let path = dir.join(LOCK_FILE);
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirLockMode {
    Shared,
    Exclusive,
}

#[cfg(unix)]
fn flock_bounded(file: &File, mode: DirLockMode, timeout: Duration) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;
    let operation = match mode {
        DirLockMode::Shared => libc::LOCK_SH,
        DirLockMode::Exclusive => libc::LOCK_EX,
    };
    let fd = file.as_raw_fd();
    let deadline = Instant::now() + timeout;
    loop {
        let status = unsafe { libc::flock(fd, operation | libc::LOCK_NB) };
        if status == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock {
            return Err(format!("console log directory lock failed: {}", error));
        }
        if Instant::now() >= deadline {
            return Err("console log directory lock timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(not(unix))]
fn flock_bounded(_file: &File, _mode: DirLockMode, _timeout: Duration) -> Result<(), String> {
    // The product ships on macOS; keep the crate buildable elsewhere.
    Ok(())
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::unix::io::AsRawFd;
    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) {}

/// Cross-process maintenance lock on one console log directory.
///
/// The store takes this lock for every operation that mutates the directory
/// (rotate, compact, clear, meta rewrite) and a shared variant for history
/// reads. It is public so integration tests can hold it from an independent
/// file descriptor and prove the contention path, including its bounded
/// timeout, without spawning a second process. On macOS `flock` is attached to
/// the open file description, so two independent `File`s contend for real.
pub struct ConsoleLogDirLock {
    file: File,
}

impl ConsoleLogDirLock {
    /// Take the exclusive maintenance lock, waiting at most `timeout`.
    pub fn acquire(dir: &Path, timeout: Duration) -> Result<Self, String> {
        create_private_dir(dir)
            .map_err(|error| format!("cannot create console log directory: {}", error))?;
        let file = open_lock_file(dir)
            .map_err(|error| format!("cannot open console log lock: {}", error))?;
        flock_bounded(&file, DirLockMode::Exclusive, timeout)?;
        Ok(Self { file })
    }

    /// Try once: `Ok(None)` means the lock is held elsewhere.
    pub fn try_acquire(dir: &Path) -> Result<Option<Self>, String> {
        create_private_dir(dir)
            .map_err(|error| format!("cannot create console log directory: {}", error))?;
        let file = open_lock_file(dir)
            .map_err(|error| format!("cannot open console log lock: {}", error))?;
        match flock_bounded(&file, DirLockMode::Exclusive, Duration::from_millis(0)) {
            Ok(()) => Ok(Some(Self { file })),
            Err(error) if error.contains("timed out") => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl Drop for ConsoleLogDirLock {
    fn drop(&mut self) {
        unlock_file(&self.file);
    }
}

/// Run `operation` while holding the in-process mutex and the cross-process
/// directory lock, in that fixed order. Every caller uses the same order so two
/// owners cannot deadlock each other.
fn with_dir_operation<T>(
    dir: &Path,
    mode: DirLockMode,
    timeout: Duration,
    operation: impl FnOnce() -> T,
) -> Result<T, String> {
    let process_lock = in_process_lock(dir);
    let _process_guard = acquire_in_process(&process_lock, timeout)?;
    create_private_dir(dir)
        .map_err(|error| format!("cannot create console log directory: {}", error))?;
    let lock_file =
        open_lock_file(dir).map_err(|error| format!("cannot open console log lock: {}", error))?;
    flock_bounded(&lock_file, mode, timeout)?;
    let result = operation();
    unlock_file(&lock_file);
    Ok(result)
}

// ── file inventory ──

/// Name shape: `{source}-{epoch}-{index:05}.jsonl`. The index orders files, so
/// a directory listing is enough to page through history chronologically.
fn file_name(source: ConsoleLogSource, epoch: &str, index: u64) -> String {
    format!("{}-{}-{:05}.jsonl", source.as_str(), epoch, index)
}

fn parse_index(name: &str, source: ConsoleLogSource) -> Option<u64> {
    let rest = name.strip_prefix(source.as_str())?.strip_prefix('-')?;
    let (_epoch, index) = rest.rsplit_once('-')?;
    index.strip_suffix(".jsonl")?.parse().ok()
}

/// Every file this source owns, oldest first.
pub fn source_files(dir: &Path, source: ConsoleLogSource) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let index = parse_index(&name, source)?;
            Some((index, entry.path()))
        })
        .collect();
    found.sort_by_key(|(index, _)| *index);
    found.into_iter().map(|(_, path)| path).collect()
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// Atomically rewrite one closed file with the lines that are still inside the
/// retention window, dropping expired and corrupt records record-by-record.
fn compact_file(
    path: &Path,
    window: RetentionWindow,
    now: ClockSnapshot,
) -> std::io::Result<CompactionOutcome> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CompactionOutcome::default());
        }
        Err(error) => return Err(error),
    };
    let mut kept: Vec<String> = Vec::new();
    let mut dropped_expired = 0usize;
    let mut dropped_corrupt = 0usize;
    let mut total = 0usize;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            dropped_corrupt += 1;
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        match serde_json::from_str::<ConsoleLogRecord>(&line) {
            Ok(record) if record.v <= RECORD_VERSION => match record_local_day(&record, now) {
                Some(day) if day >= window.start => kept.push(line),
                Some(_) => dropped_expired += 1,
                None => dropped_corrupt += 1,
            },
            _ => dropped_corrupt += 1,
        }
    }

    if kept.is_empty() {
        if total == 0 {
            // An empty file is likely another process's freshly created active
            // file. It holds no data, so unlinking it would only break that
            // writer for no benefit; capacity pruning handles leftovers.
            return Ok(CompactionOutcome::default());
        }
        let _ = fs::remove_file(path);
        return Ok(CompactionOutcome {
            deleted: true,
            dropped_expired,
            dropped_corrupt,
            ..Default::default()
        });
    }
    if kept.len() == total {
        return Ok(CompactionOutcome {
            dropped_expired,
            dropped_corrupt,
            ..Default::default()
        });
    }

    // Copy the surviving lines to a unique temp file next to the original and
    // rename it over the top. A failure leaves the original untouched.
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "console".to_string());
    let temp = dir.join(format!(".{}.{}.tmp", name, nanoid::nanoid!(8)));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> std::io::Result<()> {
        let mut output = options.open(&temp)?;
        for line in &kept {
            output.write_all(line.as_bytes())?;
            output.write_all(b"\n")?;
        }
        output.flush()?;
        drop(output);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
        return write_result.map(|_| CompactionOutcome::default());
    }

    Ok(CompactionOutcome {
        rewritten: true,
        dropped_expired,
        dropped_corrupt,
        ..Default::default()
    })
}

#[derive(Debug, Default)]
struct CompactionOutcome {
    rewritten: bool,
    deleted: bool,
    dropped_expired: usize,
    dropped_corrupt: usize,
}

// ── writer ──

/// Serialises one record, trimming detail until it fits the record budget.
fn encode_record(
    source: ConsoleLogSource,
    epoch: &str,
    seq: u64,
    at: &str,
    event: &ConsoleEvent,
    max_record_bytes: usize,
) -> (String, bool) {
    let make = |event: ConsoleEvent| -> Option<String> {
        let record = ConsoleLogRecord {
            v: RECORD_VERSION,
            source: source.as_str().to_string(),
            epoch: epoch.to_string(),
            seq,
            at: at.to_string(),
            id: event.event_id().unwrap_or_default(),
            event,
        };
        serde_json::to_string(&record).ok()
    };

    let mut event = event.clone();
    let mut line = make(event.clone()).unwrap_or_default();
    if line.len() <= max_record_bytes {
        return (line, false);
    }

    // Over budget: drop the bulky detail fields before touching the summary.
    if let ConsoleEvent::Request {
        request_headers,
        request_body,
        response_headers,
        response_body,
        ..
    } = &mut event
    {
        *request_headers = None;
        *request_body = None;
        *response_headers = None;
        *response_body = None;
    }
    line = make(event.clone()).unwrap_or_default();
    if line.len() > max_record_bytes {
        // Still too long (a huge error message, say): clamp the text fields.
        match &mut event {
            ConsoleEvent::Request { message, path, .. } => {
                *message = message.as_deref().map(|m| m.chars().take(4096).collect());
                *path = path.chars().take(4096).collect();
            }
            ConsoleEvent::Log { message, .. } => {
                *message = message.chars().take(4096).collect();
            }
        }
        line = make(event).unwrap_or_default();
    }
    (line, true)
}

#[derive(Clone, Default)]
struct MaintenanceTracker {
    lock_failures: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl MaintenanceTracker {
    fn fail(&self, message: String) {
        self.lock_failures.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = Some(message);
        }
    }

    fn clear(&self) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = None;
        }
    }

    fn snapshot(&self) -> ConsoleLogMaintenanceState {
        ConsoleLogMaintenanceState {
            lock_failures: self.lock_failures.load(Ordering::Relaxed),
            last_error: self.last_error.lock().ok().and_then(|slot| slot.clone()),
        }
    }
}

/// Owns one source's active file. Synchronous on purpose: the background queue
/// lives in [`ConsoleLogHandle`], and tests drive this directly.
pub struct ConsoleLogWriter {
    dir: PathBuf,
    source: ConsoleLogSource,
    epoch: String,
    seq: u64,
    file: Option<File>,
    active: PathBuf,
    bytes: u64,
    generation: String,
    limits: ConsoleLogLimits,
    clock: Arc<dyn Clock>,
    dir_lock_timeout: Duration,
    window: Option<RetentionWindow>,
    trimmed_total: u64,
    capacity_evicted: bool,
    tracker: MaintenanceTracker,
    shared_active: Option<Arc<Mutex<PathBuf>>>,
}

impl ConsoleLogWriter {
    pub fn open(dir: PathBuf, source: ConsoleLogSource) -> std::io::Result<Self> {
        Self::open_with_limits(dir, source, ConsoleLogLimits::default())
    }

    pub fn open_with_limits(
        dir: PathBuf,
        source: ConsoleLogSource,
        limits: ConsoleLogLimits,
    ) -> std::io::Result<Self> {
        Self::open_with_options(
            dir,
            source,
            limits,
            Arc::new(SystemClock),
            DEFAULT_DIR_LOCK_TIMEOUT,
        )
    }

    pub fn open_with_options(
        dir: PathBuf,
        source: ConsoleLogSource,
        limits: ConsoleLogLimits,
        clock: Arc<dyn Clock>,
        dir_lock_timeout: Duration,
    ) -> std::io::Result<Self> {
        create_private_dir(&dir)?;
        let mut writer = Self {
            dir,
            source,
            epoch: nanoid::nanoid!(10),
            seq: 0,
            file: None,
            active: PathBuf::new(),
            bytes: 0,
            generation: String::new(),
            limits,
            clock,
            dir_lock_timeout,
            window: None,
            trimmed_total: 0,
            capacity_evicted: false,
            tracker: MaintenanceTracker::default(),
            shared_active: None,
        };
        // A new process always gets a new epoch file; a previous process's
        // still-numbered active file is never appended to. Capacity pruning is
        // deliberately left to the startup maintenance pass that follows, so
        // the retention (TTL) rule always runs before the size budget.
        writer.open_initial_active()?;
        Ok(writer)
    }

    /// Create this process's first active file without pruning. The caller runs
    /// the startup maintenance pass afterwards.
    fn open_initial_active(&mut self) -> std::io::Result<()> {
        let dir = self.dir.clone();
        let timeout = self.dir_lock_timeout;
        with_dir_operation(&dir, DirLockMode::Exclusive, timeout, || {
            let mut meta = read_meta_unlocked(&dir);
            self.load_meta_state(&meta);
            self.allocate_active_locked(&mut meta)?;
            write_meta_unlocked(&dir, &meta)
        })
        .map_err(std::io::Error::other)?
    }

    fn attach(&mut self, tracker: MaintenanceTracker, shared_active: Arc<Mutex<PathBuf>>) {
        self.tracker = tracker;
        self.shared_active = Some(shared_active);
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    /// Current active file; exposed for diagnostics and tests.
    pub fn active_path(&self) -> Option<&Path> {
        self.file.as_ref().map(|_| self.active.as_path())
    }

    pub fn trimmed_total(&self) -> u64 {
        self.trimmed_total
    }

    pub fn capacity_evicted(&self) -> bool {
        self.capacity_evicted
    }

    fn publish_active(&self) {
        if let Some(shared) = &self.shared_active {
            if let Ok(mut slot) = shared.lock() {
                *slot = self.active.clone();
            }
        }
    }

    /// Load owner state from the on-disk metadata (generation counters etc.).
    fn load_meta_state(&mut self, meta: &ConsoleLogMeta) {
        let source_meta = meta.source(self.source);
        self.generation = meta.source_generation(self.source);
        self.trimmed_total = source_meta.trimmed;
        self.capacity_evicted = source_meta.capacity_evicted;
    }

    /// Rotate to a fresh active file. Must be called while the directory lock
    /// is held (except via [`ConsoleLogWriter::rotate`]).
    fn allocate_active_locked(&mut self, meta: &mut ConsoleLogMeta) -> std::io::Result<()> {
        if let Some(file) = self.file.take() {
            let _ = file.sync_data();
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let next = meta
            .next_index
            .entry(self.source.as_str().to_string())
            .or_insert(1);
        let mut index = *next;
        loop {
            let path = self.dir.join(file_name(self.source, &self.epoch, index));
            match options.open(&path) {
                Ok(file) => {
                    *next = index + 1;
                    meta.source_mut(self.source).active_index = index;
                    self.active = path;
                    self.file = Some(file);
                    self.bytes = 0;
                    self.publish_active();
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    index += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        let dir = self.dir.clone();
        let timeout = self.dir_lock_timeout;
        with_dir_operation(&dir, DirLockMode::Exclusive, timeout, || {
            let mut meta = read_meta_unlocked(&dir);
            self.load_meta_state(&meta);
            self.allocate_active_locked(&mut meta)?;
            self.prune_locked(&mut meta);
            write_meta_unlocked(&dir, &meta)
        })
        .map_err(std::io::Error::other)?
    }

    /// Delete the oldest closed files until this source fits its budget.
    /// Returns whether anything was evicted. The current active file is never
    /// a candidate.
    fn prune_locked(&mut self, meta: &mut ConsoleLogMeta) -> bool {
        let mut evicted = false;
        let active = self.active.clone();
        let protected = self.file.is_some();
        let mut files: Vec<PathBuf> = source_files(&self.dir, self.source)
            .into_iter()
            .filter(|path| !(protected && *path == active))
            .collect();
        let mut count = source_files(&self.dir, self.source).len();

        while count > self.limits.max_files_per_source && !files.is_empty() {
            let victim = files.remove(0);
            if fs::remove_file(&victim).is_ok() {
                count = count.saturating_sub(1);
                evicted = true;
            }
        }

        let mut total: u64 = source_files(&self.dir, self.source)
            .iter()
            .map(|path| file_len(path))
            .sum();
        while total > self.limits.max_source_bytes && !files.is_empty() {
            let victim = files.remove(0);
            let size = file_len(&victim);
            // Only count the file as gone once the unlink actually succeeded;
            // otherwise a failed removal would end the loop while still over
            // budget. Capacity eviction is data-preserving here, but the
            // running total must stay truthful.
            if fs::remove_file(&victim).is_ok() {
                total = total.saturating_sub(size);
                evicted = true;
            }
        }

        if evicted {
            self.capacity_evicted = true;
            meta.source_mut(self.source).capacity_evicted = true;
        }
        evicted
    }

    fn persist_counters(&mut self) -> Result<(), String> {
        let dir = self.dir.clone();
        let timeout = self.dir_lock_timeout;
        let source = self.source;
        let trimmed = self.trimmed_total;
        let evicted = self.capacity_evicted;
        with_dir_operation(&dir, DirLockMode::Exclusive, timeout, || {
            let mut meta = read_meta_unlocked(&dir);
            let source_meta = meta.source_mut(source);
            source_meta.trimmed = trimmed;
            source_meta.capacity_evicted = evicted;
            write_meta_unlocked(&dir, &meta)
        })
        .map_err(|error| format!("cannot persist console log counters: {}", error))?
        .map_err(|error| format!("cannot persist console log counters: {}", error))
    }

    /// Append one event. Returns `true` when the record was trimmed to fit its
    /// size budget.
    pub fn append(&mut self, event: &ConsoleEvent) -> std::io::Result<bool> {
        let now = self.clock.now();
        // A date/offset change is caught here as well as on the idle timer, so
        // a constantly busy writer cannot starve maintenance.
        if let Err(message) = self.maintain_if_due(now) {
            self.tracker.fail(message);
        }

        let at = format_console_timestamp(now.utc);
        let (line, truncated) = encode_record(
            self.source,
            &self.epoch,
            self.seq + 1,
            &at,
            event,
            self.limits.max_record_bytes,
        );
        if line.is_empty() {
            return Ok(false);
        }
        // Credentials never reach the file, not even masked in the UI later.
        let line = desensitize_body(&line);
        let bytes = line.len() as u64 + 1;

        if self.file.is_none() || self.bytes + bytes > self.limits.max_file_bytes {
            self.rotate()?;
        }
        if let Some(file) = self.file.as_mut() {
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
            self.bytes += bytes;
            self.seq += 1;
            if truncated {
                self.trimmed_total += 1;
                if let Err(message) = self.persist_counters() {
                    self.tracker.fail(message);
                }
            }
        }
        Ok(truncated)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }

    /// Run maintenance only when the local date or the UTC offset changed.
    pub fn maintain_if_due(
        &mut self,
        now: ClockSnapshot,
    ) -> Result<ConsoleLogMaintenanceReport, String> {
        let window = RetentionWindow::from_snapshot(now);
        if self.window == Some(window) {
            return Ok(ConsoleLogMaintenanceReport::default());
        }
        self.maintain(now)
    }

    /// Force a full maintenance pass (startup catch-up and tests).
    pub fn maintain(&mut self, now: ClockSnapshot) -> Result<ConsoleLogMaintenanceReport, String> {
        let window = RetentionWindow::from_snapshot(now);
        let dir = self.dir.clone();
        let timeout = self.dir_lock_timeout;
        let source = self.source;
        let result = with_dir_operation(&dir, DirLockMode::Exclusive, timeout, || {
            let mut report = self.maintain_locked(window, now)?;
            report.ran = true;
            Ok::<ConsoleLogMaintenanceReport, String>(report)
        })
        .map_err(|message| {
            format!(
                "console log maintenance skipped for {}: {}",
                source.as_str(),
                message
            )
        })?;
        let report = result.map_err(|message| {
            format!(
                "console log maintenance failed for {}: {}",
                source.as_str(),
                message
            )
        })?;
        self.tracker.clear();
        Ok(report)
    }

    fn maintain_locked(
        &mut self,
        window: RetentionWindow,
        now: ClockSnapshot,
    ) -> Result<ConsoleLogMaintenanceReport, String> {
        let mut report = ConsoleLogMaintenanceReport::default();

        // Day rollover: flush/close the active file before a new one is
        // created, but only when it holds records. An empty active file (a
        // just-started process, or an idle writer crossing midnight with
        // nothing to flush) is kept, so startup does not burn a file slot.
        if self.file.is_some() && self.bytes > 0 {
            let _ = self.flush();
            self.file = None;
            self.bytes = 0;
        }

        let mut meta = read_meta_unlocked(&self.dir);
        self.load_meta_state(&meta);
        if self.file.is_none() {
            self.allocate_active_locked(&mut meta).map_err(|error| {
                format!("cannot create a new active console log file: {}", error)
            })?;
        }

        // Compaction is strictly record-by-record and only touches closed files
        // owned by this source.
        let active = self.active.clone();
        for path in source_files(&self.dir, self.source) {
            if path == active {
                continue;
            }
            match compact_file(&path, window, now) {
                Ok(outcome) => {
                    if outcome.rewritten {
                        report.compacted_files += 1;
                    }
                    if outcome.deleted {
                        report.deleted_files += 1;
                    }
                    report.dropped_expired += outcome.dropped_expired;
                    report.dropped_corrupt += outcome.dropped_corrupt;
                }
                Err(_) => {
                    // A file we cannot read is left alone; the next pass retries.
                }
            }
        }

        report.capacity_evicted = self.prune_locked(&mut meta);

        let active_index = meta
            .next_index
            .get(self.source.as_str())
            .copied()
            .unwrap_or(0)
            .saturating_sub(1);
        let source_meta = meta.source_mut(self.source);
        source_meta.trimmed = self.trimmed_total;
        source_meta.capacity_evicted = self.capacity_evicted;
        source_meta.active_index = active_index;
        write_meta_unlocked(&self.dir, &meta)
            .map_err(|error| format!("cannot persist console log metadata: {}", error))?;

        self.window = Some(window);
        Ok(report)
    }

    /// Close the active file and delete everything this source owns, then start
    /// a new generation with a fresh epoch and an empty active file.
    pub fn clear(&mut self) -> std::io::Result<()> {
        let dir = self.dir.clone();
        let timeout = self.dir_lock_timeout;
        with_dir_operation(&dir, DirLockMode::Exclusive, timeout, || {
            let _ = self.flush();
            self.file = None;
            self.bytes = 0;
            // The active file is closed before deletion; nothing is unlinked
            // while this process still appends to it.
            for path in source_files(&dir, self.source) {
                let _ = fs::remove_file(path);
            }
            let mut meta = read_meta_unlocked(&dir);
            let generation = nanoid::nanoid!();
            {
                let source_meta = meta.source_mut(self.source);
                source_meta.generation = generation.clone();
                source_meta.capacity_evicted = false;
                source_meta.trimmed = 0;
            }
            meta.generation = generation.clone();
            self.generation = generation;
            self.seq = 0;
            self.epoch = nanoid::nanoid!(10);
            self.window = Some(RetentionWindow::from_snapshot(self.clock.now()));
            self.trimmed_total = 0;
            self.capacity_evicted = false;
            self.allocate_active_locked(&mut meta)?;
            write_meta_unlocked(&dir, &meta)
        })
        .map_err(std::io::Error::other)?
    }
}

impl Drop for ConsoleLogWriter {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

// ── non-blocking front end ──

enum WriterCommand {
    Record(Box<ConsoleEvent>),
    Flush,
    FlushAndAck(Sender<Result<(), String>>),
    Clear,
    ClearAndAck(Sender<Result<(), String>>),
    MaintainAndAck {
        force: bool,
        ack: Sender<Result<ConsoleLogMaintenanceReport, String>>,
    },
}

/// Options that are not part of the size budget: queue depth, idle
/// maintenance cadence, injected clock and the bounded lock wait.
#[derive(Clone)]
pub struct ConsoleLogOptions {
    pub limits: ConsoleLogLimits,
    pub queue_capacity: usize,
    /// Idle maintenance interval. Must stay at or below 30 s.
    pub maintenance_interval: Duration,
    /// How long a directory-lock acquisition may wait before it is reported as
    /// maintenance state.
    pub dir_lock_timeout: Duration,
    pub clock: Arc<dyn Clock>,
}

impl Default for ConsoleLogOptions {
    fn default() -> Self {
        Self {
            limits: ConsoleLogLimits::default(),
            queue_capacity: QUEUE_CAPACITY,
            maintenance_interval: DEFAULT_MAINTENANCE_INTERVAL,
            dir_lock_timeout: DEFAULT_DIR_LOCK_TIMEOUT,
            clock: Arc::new(SystemClock),
        }
    }
}

/// Hands events to a writer on its own thread.
///
/// The proxy must never wait on disk I/O, so records go through a bounded queue
/// drained by a dedicated thread. When the queue is full, or the writer fails,
/// the record is dropped and counted — losing diagnostics beats stalling live
/// traffic, and the count is what the UI reports. The thread also owns the
/// clock-driven maintenance, so an idle or hidden window still rotates and
/// compacts at a local-day boundary.
///
/// The writer deliberately never logs: a logger that writes to the log store
/// would re-enter itself on every failure.
pub struct ConsoleLogHandle {
    tx: SyncSender<WriterCommand>,
    dropped: Arc<AtomicU64>,
    write_failed: Arc<AtomicU64>,
    trimmed: Arc<AtomicU64>,
    capacity_evicted: Arc<AtomicBool>,
    tracker: MaintenanceTracker,
    epoch: String,
    dir: PathBuf,
    active_path: Arc<Mutex<PathBuf>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ConsoleLogHandle {
    pub fn spawn(dir: PathBuf, source: ConsoleLogSource) -> std::io::Result<Self> {
        Self::spawn_with(dir, source, ConsoleLogOptions::default())
    }

    pub fn spawn_with(
        dir: PathBuf,
        source: ConsoleLogSource,
        options: ConsoleLogOptions,
    ) -> std::io::Result<Self> {
        let writer_dir = dir.clone();
        let mut writer = ConsoleLogWriter::open_with_options(
            dir,
            source,
            options.limits,
            Arc::clone(&options.clock),
            options.dir_lock_timeout,
        )?;
        let tracker = MaintenanceTracker::default();
        let shared_active = Arc::new(Mutex::new(writer.active.clone()));
        writer.attach(tracker.clone(), Arc::clone(&shared_active));

        // Startup catch-up: the machine may have been asleep (or the app
        // closed) across a local midnight, so scan before accepting traffic.
        if let Err(message) = writer.maintain(options.clock.now()) {
            tracker.fail(message);
        }

        let trimmed = Arc::new(AtomicU64::new(writer.trimmed_total()));
        let capacity_evicted = Arc::new(AtomicBool::new(writer.capacity_evicted()));
        let dropped = Arc::new(AtomicU64::new(0));
        let write_failed = Arc::new(AtomicU64::new(0));
        let thread_failed = Arc::clone(&write_failed);
        let thread_trimmed = Arc::clone(&trimmed);
        let thread_capacity = Arc::clone(&capacity_evicted);
        let thread_tracker = tracker.clone();
        let thread_active = Arc::clone(&shared_active);
        let maintenance_interval = options.maintenance_interval.min(Duration::from_secs(30));
        let clock = Arc::clone(&options.clock);
        let (tx, rx) = sync_channel::<WriterCommand>(options.queue_capacity.max(1));
        let epoch = writer.epoch().to_string();
        let thread = std::thread::Builder::new()
            .name(format!("console-log-{}", source.as_str()))
            .spawn(move || {
                let publish = |writer: &ConsoleLogWriter| {
                    thread_trimmed.store(writer.trimmed_total(), Ordering::Relaxed);
                    thread_capacity.store(writer.capacity_evicted(), Ordering::Relaxed);
                    if let Ok(mut slot) = thread_active.lock() {
                        *slot = writer.active.clone();
                    }
                };
                loop {
                    match rx.recv_timeout(maintenance_interval) {
                        Ok(command) => {
                            match command {
                                WriterCommand::Record(event) => {
                                    if writer.append(&event).is_err() {
                                        thread_failed.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                                WriterCommand::Flush => {
                                    if writer.flush().is_err() {
                                        thread_failed.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                                WriterCommand::FlushAndAck(ack) => {
                                    let result = writer.flush().map_err(|error| {
                                        format!("console log flush failed: {}", error)
                                    });
                                    if result.is_err() {
                                        thread_failed.fetch_add(1, Ordering::Relaxed);
                                    }
                                    let _ = ack.send(result);
                                }
                                WriterCommand::Clear => {
                                    if let Err(error) = writer.clear() {
                                        thread_tracker.fail(error.to_string());
                                    }
                                }
                                WriterCommand::ClearAndAck(ack) => {
                                    let result = writer.clear().map_err(|error| {
                                        format!("console log clear failed: {}", error)
                                    });
                                    if let Err(message) = &result {
                                        thread_tracker.fail(message.clone());
                                    }
                                    let _ = ack.send(result);
                                }
                                WriterCommand::MaintainAndAck { force, ack } => {
                                    let now = clock.now();
                                    let result = if force {
                                        writer.maintain(now)
                                    } else {
                                        writer.maintain_if_due(now)
                                    };
                                    if let Err(message) = &result {
                                        thread_tracker.fail(message.clone());
                                    }
                                    let _ = ack.send(result);
                                }
                            }
                            publish(&writer);
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            // Idle maintenance: no traffic still rolls the day
                            // over and compacts expired records.
                            let now = clock.now();
                            if let Err(message) = writer.maintain_if_due(now) {
                                thread_tracker.fail(message);
                            }
                            publish(&writer);
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                let _ = writer.flush();
            })?;

        Ok(Self {
            tx,
            dropped,
            write_failed,
            trimmed,
            capacity_evicted,
            tracker,
            epoch,
            dir: writer_dir,
            active_path: shared_active,
            thread: Some(thread),
        })
    }

    /// Queue one event. Never blocks; returns `false` when the queue is full.
    pub fn record(&self, event: ConsoleEvent) -> bool {
        match self.tx.try_send(WriterCommand::Record(Box::new(event))) {
            Ok(()) => true,
            Err(_) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Records this store could not persist because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Records that were enqueued but could not be written to disk.
    pub fn write_failed(&self) -> u64 {
        self.write_failed.load(Ordering::Relaxed)
    }

    /// Number of records trimmed to fit the size budget (persisted).
    pub fn trimmed(&self) -> u64 {
        self.trimmed.load(Ordering::Relaxed)
    }

    /// Whether the size budget evicted closed files (persisted).
    pub fn capacity_evicted(&self) -> bool {
        self.capacity_evicted.load(Ordering::Relaxed)
    }

    /// Per-owner status as exposed by both processes.
    pub fn status(&self) -> ConsoleLogSourceStatus {
        ConsoleLogSourceStatus {
            available: true,
            dropped: self.dropped(),
            write_failed: self.write_failed(),
            trimmed: self.trimmed(),
            capacity_evicted: self.capacity_evicted(),
        }
    }

    /// Maintenance health: lock failures are visible here instead of being
    /// written back into the log channel.
    pub fn maintenance_state(&self) -> ConsoleLogMaintenanceState {
        self.tracker.snapshot()
    }

    /// This process's writer identity.
    pub fn epoch(&self) -> String {
        self.epoch.clone()
    }

    pub fn active_path(&self) -> Option<PathBuf> {
        self.active_path
            .lock()
            .ok()
            .map(|slot| slot.clone())
            .filter(|path| !path.as_os_str().is_empty())
    }

    pub fn generation(&self) -> String {
        current_generation(&self.dir)
    }

    /// Block until everything queued so far has been written.
    pub fn flush(&self) {
        let _ = self.tx.send(WriterCommand::Flush);
    }

    /// Wait for the queued writes to reach the file.
    pub fn flush_and_wait(&self, timeout: Duration) -> Result<(), String> {
        let (ack, wait) = std::sync::mpsc::channel();
        self.tx
            .send(WriterCommand::FlushAndAck(ack))
            .map_err(|_| "console log writer is not running".to_string())?;
        match wait.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => Err("console log flush timed out".to_string()),
        }
    }

    /// Drop this source's history and start over (fire and forget).
    pub fn clear(&self) {
        let _ = self.tx.send(WriterCommand::Clear);
    }

    /// Clear and wait for the files to actually be gone.
    ///
    /// Used where a caller is about to read the directory back — an immediate
    /// re-read must not resurrect the history the user just deleted.
    pub fn clear_and_wait(&self, timeout: Duration) -> Result<(), String> {
        let (ack, wait) = std::sync::mpsc::channel();
        self.tx
            .send(WriterCommand::ClearAndAck(ack))
            .map_err(|_| "console log writer is not running".to_string())?;
        match wait.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => Err("console log clear timed out".to_string()),
        }
    }

    /// Force one maintenance pass and wait for it. Tests and diagnostics use
    /// it; production relies on the idle timer and the per-append check.
    pub fn maintain_now(&self, timeout: Duration) -> Result<ConsoleLogMaintenanceReport, String> {
        let (ack, wait) = std::sync::mpsc::channel();
        self.tx
            .send(WriterCommand::MaintainAndAck { force: true, ack })
            .map_err(|_| "console log writer is not running".to_string())?;
        match wait.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => Err("console log maintenance timed out".to_string()),
        }
    }
}

impl Drop for ConsoleLogHandle {
    fn drop(&mut self) {
        // Dropping the sender ends the writer loop, which flushes on the way out.
        let (tx, _) = sync_channel(0);
        let owned = std::mem::replace(&mut self.tx, tx);
        drop(owned);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ── reader ──

/// Read a file for the current window, skipping lines that are half-written or
/// corrupt. Returns the kept records plus how many corrupt/invalid lines were
/// skipped.
fn read_file_for_window(
    path: &Path,
    window: RetentionWindow,
    now: ClockSnapshot,
) -> (Vec<ConsoleLogRecord>, usize) {
    let Ok(file) = File::open(path) else {
        return (Vec::new(), 0);
    };
    let mut records = Vec::new();
    let mut corrupt = 0usize;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            corrupt += 1;
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<ConsoleLogRecord>(&line) {
            Ok(record) if record.v <= RECORD_VERSION => {
                match record_local_day(&record, now) {
                    Some(day) if day >= window.start => records.push(record),
                    // Normal TTL expiry: not corruption, just outside the
                    // guaranteed window.
                    Some(_) => {}
                    None => corrupt += 1,
                }
            }
            // Unknown version or a torn tail line: skip it and keep going.
            _ => corrupt += 1,
        }
    }
    (records, corrupt)
}

/// Read a page of history, oldest record first.
///
/// `sources` selects which processes to include. `limit` bounds the page; when
/// more history exists than the page holds, the caller gets the newest records
/// and `truncated`/`retention.limited` say older ones were left behind. Records
/// outside the local-natural-day window are filtered here as well as in the
/// physical compaction, so a not-yet-compacted file never resurrects expired
/// content.
pub fn read_recent(dir: &Path, sources: &[ConsoleLogSource], limit: usize) -> ConsoleLogPage {
    read_recent_with_clock(
        dir,
        sources,
        limit,
        ConsoleLogLimits::default(),
        &SystemClock,
    )
}

pub fn read_recent_with_limits(
    dir: &Path,
    sources: &[ConsoleLogSource],
    limit: usize,
    limits: ConsoleLogLimits,
) -> ConsoleLogPage {
    read_recent_with_clock(dir, sources, limit, limits, &SystemClock)
}

pub fn read_recent_with_clock(
    dir: &Path,
    sources: &[ConsoleLogSource],
    limit: usize,
    _limits: ConsoleLogLimits,
    clock: &dyn Clock,
) -> ConsoleLogPage {
    let now = clock.now();
    let window = RetentionWindow::from_snapshot(now);
    let limit = limit.max(1);

    let read = |dir: &Path| -> ConsoleLogPage {
        let meta = read_meta_unlocked(dir);
        let generation = meta.composed_generation();

        let mut records: Vec<ConsoleLogRecord> = Vec::new();
        let mut corrupt = 0usize;
        let mut capacity_evicted = false;
        let mut trimmed = false;
        for source in sources {
            let source_meta = meta.source(*source);
            capacity_evicted |= source_meta.capacity_evicted;
            trimmed |= source_meta.trimmed > 0;
            for path in &source_files(dir, *source) {
                let (mut page, skipped) = read_file_for_window(path, window, now);
                records.append(&mut page);
                corrupt += skipped;
            }
        }

        // Interleave by writer position: timestamps are second-resolution and
        // two processes can stamp the same second.
        records.sort_by(|a, b| {
            (a.at.as_str(), a.source.as_str(), a.seq).cmp(&(
                b.at.as_str(),
                b.source.as_str(),
                b.seq,
            ))
        });

        let limited = records.len() > limit;
        if limited {
            records.drain(..records.len() - limit);
        }
        // Reaching the file cap is not evidence by itself that data was
        // evicted: the persisted flag says whether pruning actually happened.
        let truncated = limited || capacity_evicted || corrupt > 0;
        let retention = Some(ConsoleLogRetention {
            retention_start_date: if records.is_empty() {
                None
            } else {
                Some(window.start_date_string())
            },
            capacity_evicted,
            trimmed,
            corrupted: corrupt as u64,
            limited,
        });

        ConsoleLogPage {
            generation,
            records,
            truncated,
            retention,
        }
    };

    // A shared lock keeps a consistent snapshot against a concurrent compaction
    // rename; if another owner holds it for too long the read degrades to an
    // unlocked scan rather than blocking a command thread indefinitely.
    match with_dir_operation(dir, DirLockMode::Shared, READ_LOCK_TIMEOUT, || read(dir)) {
        Ok(page) => page,
        Err(_) => read(dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_source_budgets_fit_the_total_log_budget() {
        // The store never deletes another source's files, so the documented
        // 100 MiB global budget is exactly the two per-source budgets summed.
        // Pinning it here keeps `MAX_TOTAL_BYTES` honest instead of dead text.
        assert_eq!(MAX_SOURCE_BYTES * SOURCES.len() as u64, MAX_TOTAL_BYTES);
    }

    const TIGHT: ConsoleLogLimits = ConsoleLogLimits {
        max_file_bytes: 2 * 1024,
        max_files_per_source: 3,
        max_source_bytes: 8 * 1024,
        max_record_bytes: 1024,
    };

    #[derive(Debug)]
    struct FakeClock {
        now: Mutex<DateTime<Utc>>,
        offset_minutes: Mutex<i32>,
    }

    impl FakeClock {
        fn new(utc: DateTime<Utc>, offset_minutes: i32) -> Arc<Self> {
            Arc::new(Self {
                now: Mutex::new(utc),
                offset_minutes: Mutex::new(offset_minutes),
            })
        }

        fn advance(&self, duration: chrono::Duration) {
            let mut now = self.now.lock().unwrap();
            *now += duration;
        }

        fn set_offset(&self, offset_minutes: i32) {
            *self.offset_minutes.lock().unwrap() = offset_minutes;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> ClockSnapshot {
            ClockSnapshot {
                utc: *self.now.lock().unwrap(),
                local_offset_minutes: *self.offset_minutes.lock().unwrap(),
            }
        }
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("cc-use-logs-{}", nanoid::nanoid!(8)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn event(message: &str) -> ConsoleEvent {
        ConsoleEvent::log("info", "daemon", Some("test"), message)
    }

    /// An event whose own timestamp comes from the injected clock. The store
    /// filters by event time, so tests that move a fake clock past a day
    /// boundary must move the producer timestamp too.
    fn event_at(clock: &FakeClock, message: &str) -> ConsoleEvent {
        ConsoleEvent::Log {
            id: format!("log-{}", nanoid::nanoid!(8)),
            timestamp: format_console_timestamp(clock.now().utc),
            level: "info".to_string(),
            source: "daemon".to_string(),
            target: Some("test".to_string()),
            message: message.to_string(),
        }
    }

    fn writer(dir: &Path, source: ConsoleLogSource, limits: ConsoleLogLimits) -> ConsoleLogWriter {
        ConsoleLogWriter::open_with_limits(dir.to_path_buf(), source, limits).unwrap()
    }

    fn utc(value: &str) -> DateTime<Utc> {
        parse_console_timestamp(value).expect("valid test timestamp")
    }

    /// Build one raw JSONL line with an explicit record timestamp, mimicking a
    /// file written on an earlier day by an earlier process.
    fn raw_log_record(
        source: ConsoleLogSource,
        epoch: &str,
        seq: u64,
        at: &str,
        id: &str,
        message: &str,
    ) -> String {
        let event = ConsoleEvent::Log {
            id: id.to_string(),
            timestamp: at.to_string(),
            level: "info".to_string(),
            source: source.as_str().to_string(),
            target: Some("test".to_string()),
            message: message.to_string(),
        };
        serde_json::to_string(&ConsoleLogRecord {
            v: RECORD_VERSION,
            source: source.as_str().to_string(),
            epoch: epoch.to_string(),
            seq,
            at: at.to_string(),
            id: id.to_string(),
            event,
        })
        .unwrap()
    }

    fn write_raw_file(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        let mut contents = lines.join("\n");
        if !contents.is_empty() {
            contents.push('\n');
        }
        fs::write(&path, contents).unwrap();
        path
    }

    fn write_meta_with_next_index(dir: &Path, source: ConsoleLogSource, next_index: u64) {
        let mut meta = ConsoleLogMeta::default();
        meta.next_index
            .insert(source.as_str().to_string(), next_index);
        write_meta_unlocked(dir, &meta).unwrap();
    }

    fn options(clock: Arc<dyn Clock>, limits: ConsoleLogLimits) -> ConsoleLogOptions {
        ConsoleLogOptions {
            limits,
            ..ConsoleLogOptions::default()
        }
        .with_clock(clock)
    }

    impl ConsoleLogOptions {
        fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
            self.clock = clock;
            self
        }
    }

    // ── T11: retention / clock / maintenance ──

    #[test]
    fn records_round_trip_in_order_with_a_stable_epoch_and_increasing_sequence() {
        let temp = TempDir::new();
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );

        for index in 0..5 {
            log.append(&event(&format!("line {index}"))).unwrap();
        }

        let page = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        let messages: Vec<String> = page
            .records
            .iter()
            .map(|record| match &record.event {
                ConsoleEvent::Log { message, .. } => message.clone(),
                other => panic!("expected a log record, got {:?}", other),
            })
            .collect();
        assert_eq!(
            messages,
            vec!["line 0", "line 1", "line 2", "line 3", "line 4"]
        );

        let epoch = page.records[0].epoch.clone();
        assert!(page.records.iter().all(|record| record.epoch == epoch));
        let seqs: Vec<u64> = page.records.iter().map(|record| record.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        assert!(!page.truncated);
        let retention = page.retention.expect("retention metadata present");
        assert!(!retention.limited);
        assert!(!retention.capacity_evicted);
        assert!(retention.retention_start_date.is_some());
    }

    /// The old behaviour (a restarted writer reused the newest active file and
    /// continued its sequence) is deliberately replaced: a new process gets a
    /// new epoch identity and a new file, while old records stay replayable.
    #[test]
    fn a_reopened_writer_starts_a_new_epoch_instead_of_reusing_the_active_file() {
        let temp = TempDir::new();
        let first_epoch;
        {
            let mut log = writer(
                temp.path(),
                ConsoleLogSource::Daemon,
                ConsoleLogLimits::default(),
            );
            first_epoch = log.epoch().to_string();
            log.append(&event("first run")).unwrap();
            log.append(&event("first run again")).unwrap();
        }
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );
        let second_epoch = log.epoch().to_string();
        assert_ne!(
            first_epoch, second_epoch,
            "a restart must not inherit the previous process's epoch"
        );
        log.append(&event("second run")).unwrap();

        let page = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert_eq!(page.records.len(), 3, "old records remain replayable");
        let mut epochs: Vec<String> = page
            .records
            .iter()
            .map(|record| record.epoch.clone())
            .collect();
        epochs.sort();
        epochs.dedup();
        assert_eq!(epochs.len(), 2, "two process lifetimes, two epochs");
        // Two process lifetimes mean two files: the active file was not reused.
        assert_eq!(source_files(temp.path(), ConsoleLogSource::Daemon).len(), 2);
    }

    #[test]
    fn rotation_drops_the_oldest_file_once_the_per_source_cap_is_reached() {
        let temp = TempDir::new();
        let mut log = writer(temp.path(), ConsoleLogSource::Daemon, TIGHT);

        // Each record is comfortably inside the file budget, so the cap on file
        // count is what forces eviction.
        for index in 0..200 {
            log.append(&event(&format!("record {index} {:0>400}", index)))
                .unwrap();
        }

        let files = source_files(temp.path(), ConsoleLogSource::Daemon);
        assert_eq!(
            files.len(),
            TIGHT.max_files_per_source,
            "file cap respected"
        );
        for path in &files {
            assert!(
                file_len(path) <= TIGHT.max_file_bytes,
                "no file grows past its budget"
            );
        }
        assert!(
            log.active_path()
                .map(|path| files.contains(&path.to_path_buf()))
                .unwrap_or(false),
            "the active file is one of the protected files"
        );

        let page = read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 10_000, TIGHT);
        assert!(page.truncated, "evicted history is reported as a gap");
        assert!(
            page.retention.expect("retention").capacity_evicted,
            "eviction is attributed to the size budget"
        );
        // The newest record is always the one just written.
        let last = page.records.last().unwrap();
        match &last.event {
            ConsoleEvent::Log { message, .. } => assert!(message.starts_with("record 199 ")),
            other => panic!("expected a log record, got {:?}", other),
        }
    }

    #[test]
    fn an_oversized_record_sheds_detail_before_touching_the_summary() {
        let temp = TempDir::new();
        let mut log = writer(temp.path(), ConsoleLogSource::Daemon, TIGHT);

        let mut oversized = event("short summary");
        if let ConsoleEvent::Log { message, .. } = &mut oversized {
            *message = format!("short summary {}", "x".repeat(8_000));
        }
        let truncated = log.append(&oversized).unwrap();

        assert!(truncated, "the caller learns the record was trimmed");
        assert_eq!(log.trimmed_total(), 1);
        let page = read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 10, TIGHT);
        let retention = page.retention.expect("retention");
        assert!(retention.trimmed, "the trim is visible to the reader");
        let record = page.records.first().expect("record still written");
        match &record.event {
            ConsoleEvent::Log { message, .. } => {
                assert!(message.len() <= 4096, "message clamped to fit");
            }
            other => panic!("expected a log record, got {:?}", other),
        }
    }

    #[test]
    fn a_request_record_over_budget_loses_its_detail_fields_first() {
        let temp = TempDir::new();
        let mut log = writer(temp.path(), ConsoleLogSource::Daemon, TIGHT);

        let mut bulky = ConsoleEvent::pending(
            "req-1",
            "POST",
            "/v1/messages",
            "https://upstream.example.com/v1/messages",
            Some("test provider"),
            Some("test key"),
            false,
        );
        if let ConsoleEvent::Request {
            request_headers,
            request_body,
            ..
        } = &mut bulky
        {
            *request_headers = Some(vec![format!("x-user: {}", "y".repeat(4_000))]);
            *request_body = Some("z".repeat(4_000));
        }
        let truncated = log.append(&bulky).unwrap();
        assert!(truncated);

        let page = read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 10, TIGHT);
        match &page.records[0].event {
            ConsoleEvent::Request {
                request_headers,
                request_body,
                message,
                ..
            } => {
                assert!(request_headers.is_none() && request_body.is_none());
                // The summary survives so the row is still identifiable.
                assert_eq!(page.records[0].id, "req-1:pending");
                let _ = message;
            }
            other => panic!("expected a request record, got {:?}", other),
        }
    }

    #[test]
    fn a_corrupt_line_is_skipped_and_counted_without_losing_the_rest_of_the_file() {
        let temp = TempDir::new();
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );
        log.append(&event("kept before")).unwrap();
        log.flush().unwrap();

        let path = log.active_path().unwrap().to_path_buf();
        {
            use std::io::Write as _;
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            // A torn write: valid JSON never arrives for this line.
            file.write_all(b"{\"v\":1,\"source\":\"daemon\",\"epoch\":\"x\",\"seq\":9,\"at\":\"2026-01-01 00:00:00\",\"event\":{\"category\":\"log\"\n")
                .unwrap();
        }

        let page = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert_eq!(page.records.len(), 1, "the readable records survive");
        assert!(page.truncated, "the damaged stretch is reported");
        assert_eq!(page.retention.expect("retention").corrupted, 1);
    }

    #[test]
    fn credentials_are_masked_before_they_reach_the_file() {
        let temp = TempDir::new();
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );
        log.append(&event("upstream rejected key sk-live-abcdef123456"))
            .unwrap();
        log.flush().unwrap();

        let raw = fs::read_to_string(log.active_path().unwrap()).unwrap();
        assert!(
            !raw.contains("sk-live-abcdef123456"),
            "a credential-looking token must not land on disk"
        );
        assert!(raw.contains("upstream rejected key"));
    }

    #[test]
    fn clearing_starts_a_new_generation_and_leaves_nothing_behind() {
        let temp = TempDir::new();
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );
        log.append(&event("before clear")).unwrap();
        let before = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert_eq!(before.records.len(), 1);

        log.clear().unwrap();

        let after = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert!(
            after.records.is_empty(),
            "cleared history does not come back"
        );
        assert_ne!(
            after.generation, before.generation,
            "a new generation tells readers to drop what they were holding"
        );

        log.append(&event("after clear")).unwrap();
        let resumed = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert_eq!(resumed.records.len(), 1);
        assert_eq!(resumed.generation, after.generation);
    }

    #[test]
    fn each_source_reads_its_own_files_and_never_deletes_the_others() {
        let temp = TempDir::new();
        let mut daemon = writer(temp.path(), ConsoleLogSource::Daemon, TIGHT);
        let mut app = writer(temp.path(), ConsoleLogSource::App, TIGHT);
        daemon.append(&event("from the daemon")).unwrap();
        app.append(&event("from the app")).unwrap();

        let daemon_only =
            read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 100, TIGHT);
        assert_eq!(daemon_only.records.len(), 1);
        assert_eq!(daemon_only.records[0].source, "daemon");

        let both = read_recent_with_limits(temp.path(), &SOURCES, 100, TIGHT);
        let sources: Vec<&str> = both.records.iter().map(|r| r.source.as_str()).collect();
        assert_eq!(sources, vec!["app", "daemon"]);

        // A source's own maintenance only ever touches its own file family.
        daemon
            .maintain_if_due(ClockSnapshot {
                utc: Utc::now() + chrono::Duration::days(10),
                local_offset_minutes: 0,
            })
            .unwrap();
        assert_eq!(source_files(temp.path(), ConsoleLogSource::App).len(), 1);
        assert_eq!(source_files(temp.path(), ConsoleLogSource::Daemon).len(), 1);
    }

    #[test]
    fn the_background_queue_never_blocks_and_reports_what_it_dropped() {
        let temp = TempDir::new();
        let handle =
            ConsoleLogHandle::spawn(temp.path().to_path_buf(), ConsoleLogSource::App).unwrap();
        for index in 0..50 {
            assert!(handle.record(event(&format!("queued {index}"))));
        }
        handle
            .flush_and_wait(Duration::from_secs(5))
            .expect("flush ack");

        assert_eq!(handle.dropped(), 0);
        let page = read_recent(temp.path(), &[ConsoleLogSource::App], 100);
        assert_eq!(page.records.len(), 50);
    }

    #[test]
    fn retention_uses_local_natural_days_computed_from_utc_timestamps() {
        let temp = TempDir::new();
        // 2026-10-29 04:00 UTC is 2026-10-29 12:00 in UTC+8, so the window is
        // 2026-10-27 .. 2026-10-29 (local). A UTC+0 reader would wrongly keep
        // the record from 2026-10-26 16:30 UTC (which is the 27th locally).
        let clock = FakeClock::new(utc("2026-10-29 04:00:00"), 8 * 60);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 3);
        let lines = vec![
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                1,
                "2026-10-26 16:30:00",
                "local-27th",
                "kept: local day 27",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                2,
                "2026-10-26 15:30:00",
                "local-26th",
                "dropped: local day 26",
            ),
        ];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let page =
            read_recent_with_clock(temp.path(), &[ConsoleLogSource::App], 100, TIGHT, &*clock);
        assert_eq!(
            page.records.len(),
            1,
            "only the local-day-27 record is kept"
        );
        assert_eq!(page.records[0].id, "local-27th");
        let retention = page.retention.expect("retention");
        assert_eq!(
            retention.retention_start_date.as_deref(),
            Some("2026-10-27")
        );
        assert!(!retention.capacity_evicted);
    }

    #[test]
    fn invalid_and_anomalous_future_timestamps_are_corrupt_and_cannot_bypass_the_ttl() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 4);
        let lines = vec![
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                1,
                "2999-01-01 00:00:00",
                "future",
                "future record",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                2,
                "not-a-timestamp",
                "invalid",
                "invalid record",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                3,
                "2026-10-29 10:00:00",
                "fresh",
                "fresh record",
            ),
        ];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let page =
            read_recent_with_clock(temp.path(), &[ConsoleLogSource::App], 100, TIGHT, &*clock);
        assert_eq!(
            page.records.len(),
            1,
            "only the valid fresh record survives"
        );
        assert_eq!(page.records[0].id, "fresh");
        assert_eq!(
            page.retention.expect("retention").corrupted,
            2,
            "the invalid and future records are counted as corrupt"
        );

        // A forced maintenance pass physically drops them: they never become a
        // permanent escape hatch from the TTL.
        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), TIGHT),
        )
        .unwrap();
        handle
            .maintain_now(Duration::from_secs(5))
            .expect("maintenance");
        let raw = fs::read_to_string(temp.path().join("app-old-00001.jsonl")).unwrap_or_default();
        assert!(
            !raw.contains("2999-01-01") && !raw.contains("not-a-timestamp"),
            "corrupt timestamps are removed by compaction, not kept forever"
        );
    }

    #[test]
    fn startup_catch_up_compacts_expired_closed_files_after_a_gap() {
        let temp = TempDir::new();
        // Records were written four local days ago; the app was closed since.
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 2);
        let lines = vec![
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                1,
                "2026-10-25 12:00:00",
                "expired",
                "expired record",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                2,
                "2026-10-28 12:00:00",
                "inside",
                "inside the window",
            ),
        ];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), ConsoleLogLimits::default()),
        )
        .unwrap();
        handle
            .maintain_now(Duration::from_secs(5))
            .expect("forced maintenance");

        let raw = fs::read_to_string(temp.path().join("app-old-00001.jsonl")).unwrap();
        assert!(
            !raw.contains("expired record"),
            "expired record compacted out"
        );
        assert!(raw.contains("inside the window"), "in-window record kept");

        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].id, "inside");
    }

    #[test]
    fn idle_maintenance_runs_with_no_traffic_and_rolls_the_local_day() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-28 12:00:00"), 0);
        let mut opts = options(clock.clone(), ConsoleLogLimits::default());
        opts.maintenance_interval = Duration::from_millis(20);
        let handle =
            ConsoleLogHandle::spawn_with(temp.path().to_path_buf(), ConsoleLogSource::App, opts)
                .unwrap();

        handle.record(event_at(&clock, "written on day one"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        let first_active = handle.active_path().expect("active file");
        assert!(first_active.exists());

        // Move past two local midnights without sending any other command.
        clock.advance(chrono::Duration::days(3));

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if !first_active.exists() {
                break;
            }
            if Instant::now() >= deadline {
                panic!("idle maintenance did not compact the expired file");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let second_active = handle.active_path().expect("new active file");
        assert_ne!(
            first_active, second_active,
            "the day rollover created a new active file"
        );
        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert!(page.records.is_empty(), "the old record expired");
    }

    #[test]
    fn an_append_after_a_day_change_runs_maintenance_even_without_the_idle_timer() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-28 12:00:00"), 0);
        let mut opts = options(clock.clone(), ConsoleLogLimits::default());
        // Longer than the test: only the append-time check can catch the change.
        opts.maintenance_interval = Duration::from_secs(30);
        let handle =
            ConsoleLogHandle::spawn_with(temp.path().to_path_buf(), ConsoleLogSource::App, opts)
                .unwrap();
        handle.record(event_at(&clock, "day one"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        let first_active = handle.active_path().expect("active file");

        clock.advance(chrono::Duration::days(3));
        handle.record(event_at(&clock, "day four"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();

        assert!(
            !first_active.exists(),
            "the append-time check closed and compacted the old active file"
        );
        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert_eq!(page.records.len(), 1);
        match &page.records[0].event {
            ConsoleEvent::Log { message, .. } => assert_eq!(message, "day four"),
            other => panic!("expected a log record, got {:?}", other),
        }
    }

    #[test]
    fn a_utc_offset_change_recomputes_the_window_and_compacts() {
        let temp = TempDir::new();
        // At UTC+5 the record is local 2026-10-27 00:00, inside a window that
        // starts on the 27th. At UTC+4 the same instant is local 2026-10-26
        // 23:00, outside it.
        let clock = FakeClock::new(utc("2026-10-29 04:00:00"), 5 * 60);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 2);
        let lines = vec![raw_log_record(
            ConsoleLogSource::App,
            "old",
            1,
            "2026-10-26 19:00:00",
            "boundary",
            "boundary record",
        )];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let mut opts = options(clock.clone(), ConsoleLogLimits::default());
        opts.maintenance_interval = Duration::from_secs(30);
        let handle =
            ConsoleLogHandle::spawn_with(temp.path().to_path_buf(), ConsoleLogSource::App, opts)
                .unwrap();
        let before = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert_eq!(before.records.len(), 1, "in-window under UTC+5");

        clock.set_offset(4 * 60);
        handle.record(event("trigger the offset check"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();

        assert!(
            !temp.path().join("app-old-00001.jsonl").exists(),
            "the offset change moved the record outside the window and compacted it"
        );
    }

    #[test]
    fn capacity_eviction_is_reported_and_persisted_across_a_restart() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), TIGHT),
        )
        .unwrap();
        for index in 0..40 {
            handle.record(event(&format!("record {index} {:0>400}", index)));
        }
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        assert!(handle.capacity_evicted(), "size budget evicted files");
        assert!(handle.status().capacity_evicted);

        drop(handle);
        // A restart still explains the shortened recovery window.
        let reopened = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), TIGHT),
        )
        .unwrap();
        assert!(
            reopened.capacity_evicted(),
            "the eviction flag survives the restart"
        );
        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            10_000,
            TIGHT,
            &*clock,
        );
        assert!(page.retention.expect("retention").capacity_evicted);
    }

    #[test]
    fn maintenance_rotation_never_changes_the_generation_but_clear_does() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-28 12:00:00"), 0);
        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), ConsoleLogLimits::default()),
        )
        .unwrap();
        handle.record(event_at(&clock, "day one"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        let generation = current_generation(temp.path());

        clock.advance(chrono::Duration::days(1));
        handle.record(event_at(&clock, "day two"));
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        assert_eq!(
            current_generation(temp.path()),
            generation,
            "a day rollover is not a user clear"
        );

        handle.clear_and_wait(Duration::from_secs(5)).unwrap();
        let cleared = current_generation(temp.path());
        assert_ne!(
            cleared, generation,
            "an explicit clear moves the generation"
        );
        assert!(!cleared.is_empty());
    }

    #[test]
    fn trimmed_count_is_persisted_and_reported_after_a_restart() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        let mut short = TIGHT;
        short.max_record_bytes = 512;
        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), short),
        )
        .unwrap();
        let mut oversized = event("summary");
        if let ConsoleEvent::Log { message, .. } = &mut oversized {
            *message = format!("summary {}", "x".repeat(4_000));
        }
        handle.record(oversized);
        handle.flush_and_wait(Duration::from_secs(5)).unwrap();
        assert_eq!(handle.trimmed(), 1);

        drop(handle);
        let reopened = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), short),
        )
        .unwrap();
        assert_eq!(reopened.trimmed(), 1, "trim count persisted");
        let page =
            read_recent_with_clock(temp.path(), &[ConsoleLogSource::App], 10, short, &*clock);
        assert!(page.retention.expect("retention").trimmed);
    }

    // ── T12: file ownership / compaction ──

    #[test]
    fn an_old_mixed_date_file_is_compacted_record_by_record_preserving_identity() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 2);
        let lines = vec![
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                1,
                "2026-10-26 12:00:00",
                "day-26",
                "expired",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                2,
                "2026-10-27 12:00:00",
                "day-27",
                "kept one",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                3,
                "2026-10-28 12:00:00",
                "day-28",
                "kept two",
            ),
        ];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock.clone(), ConsoleLogLimits::default()),
        )
        .unwrap();
        handle.maintain_now(Duration::from_secs(5)).unwrap();

        let raw = fs::read_to_string(temp.path().join("app-old-00001.jsonl")).unwrap();
        let parsed: Vec<ConsoleLogRecord> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(parsed.len(), 2);
        // Identity and writer position are preserved exactly.
        assert_eq!(parsed[0].id, "day-27");
        assert_eq!((parsed[0].epoch.as_str(), parsed[0].seq), ("old", 2));
        assert_eq!(parsed[1].id, "day-28");
        assert_eq!((parsed[1].epoch.as_str(), parsed[1].seq), ("old", 3));

        // No temp files are left behind by the atomic rewrite.
        let leftovers: Vec<String> = fs::read_dir(temp.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files cleaned up: {:?}",
            leftovers
        );
    }

    #[test]
    fn compaction_keeps_a_fully_expired_file_out_of_reads_and_deletes_it_later() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 2);
        let lines = vec![raw_log_record(
            ConsoleLogSource::App,
            "old",
            1,
            "2026-10-20 12:00:00",
            "gone",
            "expired",
        )];
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        // Reading filters the expired record before physical cleanup happens.
        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert!(page.records.is_empty());

        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock, ConsoleLogLimits::default()),
        )
        .unwrap();
        handle.maintain_now(Duration::from_secs(5)).unwrap();
        assert!(
            !temp.path().join("app-old-00001.jsonl").exists(),
            "an all-expired closed file is deleted"
        );
    }

    #[test]
    fn the_active_file_is_never_deleted_by_capacity() {
        let temp = TempDir::new();
        let mut log = writer(temp.path(), ConsoleLogSource::Daemon, TIGHT);
        for index in 0..120 {
            log.append(&event(&format!("record {index} {:0>400}", index)))
                .unwrap();
            let active = log.active_path().expect("active file").to_path_buf();
            assert!(
                active.exists(),
                "the active file must survive every rotation/prune ({index})"
            );
        }
        let files = source_files(temp.path(), ConsoleLogSource::Daemon);
        let active = log.active_path().unwrap().to_path_buf();
        assert!(files.contains(&active));
    }

    #[test]
    fn corrupt_lines_are_counted_and_skipped_while_compaction_keeps_valid_records() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        write_meta_with_next_index(temp.path(), ConsoleLogSource::App, 2);
        let mut lines = vec![
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                1,
                "2026-10-27 12:00:00",
                "kept",
                "kept record",
            ),
            raw_log_record(
                ConsoleLogSource::App,
                "old",
                2,
                "2026-10-20 12:00:00",
                "expired",
                "expired record",
            ),
        ];
        lines.insert(0, "{not json".to_string());
        write_raw_file(temp.path(), "app-old-00001.jsonl", &lines);

        let page = read_recent_with_clock(
            temp.path(),
            &[ConsoleLogSource::App],
            100,
            ConsoleLogLimits::default(),
            &*clock,
        );
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.retention.expect("retention").corrupted, 1);

        let handle = ConsoleLogHandle::spawn_with(
            temp.path().to_path_buf(),
            ConsoleLogSource::App,
            options(clock, ConsoleLogLimits::default()),
        )
        .unwrap();
        handle.maintain_now(Duration::from_secs(5)).unwrap();
        let raw = fs::read_to_string(temp.path().join("app-old-00001.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 1, "only the valid kept record remains");
        assert!(raw.contains("kept record"));
    }

    #[test]
    fn the_directory_lock_is_bounded_and_reported_as_maintenance_state() {
        let temp = TempDir::new();
        let clock = FakeClock::new(utc("2026-10-29 12:00:00"), 0);
        let mut opts = options(clock, ConsoleLogLimits::default());
        opts.dir_lock_timeout = Duration::from_millis(120);
        opts.maintenance_interval = Duration::from_secs(30);
        let handle =
            ConsoleLogHandle::spawn_with(temp.path().to_path_buf(), ConsoleLogSource::App, opts)
                .unwrap();

        let held = ConsoleLogDirLock::acquire(temp.path(), Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        let result = handle.maintain_now(Duration::from_secs(2));
        let elapsed = started.elapsed();
        assert!(result.is_err(), "a held lock surfaces as a failure");
        assert!(
            elapsed >= Duration::from_millis(100) && elapsed < Duration::from_secs(3),
            "lock wait is bounded, took {:?}",
            elapsed
        );
        let state = handle.maintenance_state();
        assert!(state.lock_failures >= 1);
        assert!(state.last_error.is_some());

        drop(held);
        handle
            .maintain_now(Duration::from_secs(5))
            .expect("lock released");
        assert_eq!(handle.maintenance_state().last_error, None);
    }
}
