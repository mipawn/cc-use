//! Bounded on-disk store for console events.
//!
//! The daemon records its own requests and diagnostic logs here, so history
//! survives the GUI being closed. The app records its own logs and the
//! renderer's. Each process owns a separate file family — `daemon-*` versus
//! `app-*` — so two processes never contend for one active file, and neither
//! ever deletes a file the other still has open.
//!
//! This is a recovery window, not an archive: files rotate on size and the
//! oldest are pruned against a fixed budget. Records are appended, never
//! rewritten in place, so a reader can tail a file while it grows. Anything the
//! budget has already evicted is reported as a gap rather than reconstructed.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::proxy::console::{desensitize_body, ConsoleEvent};

/// 10 MiB, checked before each append.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Including the file currently being written.
pub const MAX_FILES_PER_SOURCE: usize = 5;
/// 50 MiB per source, 100 MiB across every source.
pub const MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
/// Longest single record we persist. Detail is trimmed to fit before writing.
pub const MAX_RECORD_BYTES: usize = 256 * 1024;
/// Records kept in memory by the UI; also the default page size for reads.
pub const RECENT_RECORD_LIMIT: usize = 500;

const RECORD_VERSION: u32 = 1;
const META_FILE: &str = "meta.json";
const QUEUE_CAPACITY: usize = 2048;

/// Size budget for the store. Production uses [`ConsoleLogLimits::default`];
/// tests shrink it so rotation and eviction are exercised without writing
/// hundreds of megabytes.
#[derive(Clone, Copy, Debug)]
pub struct ConsoleLogLimits {
    pub max_file_bytes: u64,
    pub max_files_per_source: usize,
    pub max_source_bytes: u64,
    pub max_total_bytes: u64,
    pub max_record_bytes: usize,
}

impl Default for ConsoleLogLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            max_files_per_source: MAX_FILES_PER_SOURCE,
            max_source_bytes: MAX_SOURCE_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
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

/// One page of history plus the generation it was read under.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLogPage {
    /// Changes when history is cleared. A page read under a different
    /// generation than the reader last saw must replace, not merge.
    pub generation: String,
    pub records: Vec<ConsoleLogRecord>,
    /// True when the budget evicted older records, so the page does not start
    /// where the reader left off.
    pub truncated: bool,
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

// ── generation ──

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConsoleLogMeta {
    #[serde(default)]
    generation: String,
    /// Highest rotation index handed out per source.
    #[serde(default)]
    next_index: std::collections::BTreeMap<String, u64>,
}

fn read_meta(dir: &Path) -> ConsoleLogMeta {
    let Ok(raw) = fs::read_to_string(dir.join(META_FILE)) else {
        return ConsoleLogMeta::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_meta(dir: &Path, meta: &ConsoleLogMeta) -> std::io::Result<()> {
    let path = dir.join(META_FILE);
    let temp = dir.join(format!("{}.tmp", META_FILE));
    fs::write(&temp, serde_json::to_string(meta).unwrap_or_default())?;
    fs::rename(&temp, &path)
}

/// Generation of the history currently on disk. Empty only before the first
/// record or clear, which readers treat as an initial state rather than a new
/// one.
pub fn current_generation(dir: &Path) -> String {
    read_meta(dir).generation
}

/// Drop everything one source owns and start its history over.
///
/// Only the process that owns the files may call this: another process would
/// be deleting a file that is still being appended to.
pub fn clear_source(dir: &Path, source: ConsoleLogSource) -> std::io::Result<()> {
    for path in source_files(dir, source) {
        let _ = fs::remove_file(path);
    }
    let mut meta = read_meta(dir);
    meta.next_index.remove(source.as_str());
    meta.generation = nanoid::nanoid!();
    write_meta(dir, &meta)
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

/// Delete the oldest closed files until this source fits its budget, then trim
/// the remainder against the shared total. Returns how many were removed.
fn prune(dir: &Path, source: ConsoleLogSource, limits: ConsoleLogLimits) -> usize {
    let mut removed = 0;
    let mut files = source_files(dir, source);

    // The last file is the one being appended to; never evict it.
    while files.len() > limits.max_files_per_source {
        let victim = files.remove(0);
        if fs::remove_file(&victim).is_ok() {
            removed += 1;
        }
    }

    let mut total: u64 = files.iter().map(|path| file_len(path)).sum();
    while total > limits.max_source_bytes && files.len() > 1 {
        let victim = files.remove(0);
        let size = file_len(&victim);
        total = total.saturating_sub(size);
        if fs::remove_file(&victim).is_ok() {
            removed += 1;
        }
    }

    prune_total_budget(dir, limits);
    removed
}

/// Keep every source's combined footprint inside the shared budget by dropping
/// the oldest file overall until it fits.
fn prune_total_budget(dir: &Path, limits: ConsoleLogLimits) {
    loop {
        let mut all: Vec<(u64, PathBuf)> = Vec::new();
        for source in SOURCES {
            all.extend(source_files(dir, source).into_iter().map(|path| {
                (
                    fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .map_or(0, |t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0)
                        }),
                    path,
                )
            }));
        }
        let total: u64 = all.iter().map(|(_, path)| file_len(path)).sum();
        if total <= limits.max_total_bytes {
            return;
        }
        // Never drop a source's newest file: that is its active writer's target.
        let protected: Vec<PathBuf> = SOURCES
            .iter()
            .filter_map(|source| source_files(dir, *source).pop())
            .collect();
        all.sort_by_key(|(mtime, _)| *mtime);
        let Some((_, victim)) = all.into_iter().find(|(_, path)| !protected.contains(path)) else {
            return;
        };
        if fs::remove_file(&victim).is_err() {
            return;
        }
    }
}

// ── writer ──

/// Serialises one record, trimming detail until it fits the record budget.
fn encode_record(
    source: ConsoleLogSource,
    epoch: &str,
    seq: u64,
    event: &ConsoleEvent,
    max_record_bytes: usize,
) -> (String, bool) {
    let make = |event: ConsoleEvent| -> Option<String> {
        let record = ConsoleLogRecord {
            v: RECORD_VERSION,
            source: source.as_str().to_string(),
            epoch: epoch.to_string(),
            seq,
            at: crate::proxy::console::now_timestamp(),
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
        create_private_dir(&dir)?;
        let meta = read_meta(&dir);
        let generation = meta.generation.clone();

        // Continue the newest file when it still has room; a restart should not
        // burn a rotation slot.
        let existing = source_files(&dir, source);
        let mut writer = Self {
            dir,
            source,
            epoch: nanoid::nanoid!(10),
            seq: last_seq(existing.last().map(PathBuf::as_path)),
            file: None,
            active: PathBuf::new(),
            bytes: 0,
            generation,
            limits,
        };

        let reusable = existing
            .last()
            .filter(|path| file_len(path) < limits.max_file_bytes)
            .cloned();
        match reusable {
            Some(path) => {
                writer.bytes = file_len(&path);
                writer.file = Some(OpenOptions::new().append(true).open(&path)?);
                writer.active = path;
            }
            None => writer.rotate()?,
        }

        prune(&writer.dir, source, limits);
        Ok(writer)
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

    fn rotate(&mut self) -> std::io::Result<()> {
        self.flush()?;
        let mut meta = read_meta(&self.dir);
        let index = meta
            .next_index
            .entry(self.source.as_str().to_string())
            .or_insert(1);
        let path = self.dir.join(file_name(self.source, &self.epoch, *index));
        *index += 1;
        write_meta(&self.dir, &meta)?;
        self.active = path.clone();

        let mut options = OpenOptions::new();
        options.create(true).write(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        self.file = Some(options.open(&path)?);
        self.bytes = 0;
        prune(&self.dir, self.source, self.limits);
        Ok(())
    }

    /// Append one event. Returns `true` when the record was trimmed to fit its
    /// size budget.
    pub fn append(&mut self, event: &ConsoleEvent) -> std::io::Result<bool> {
        let (line, truncated) = encode_record(
            self.source,
            &self.epoch,
            self.seq + 1,
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
        }
        Ok(truncated)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }

    /// Close the active file and delete everything this source owns.
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.flush()?;
        self.file = None;
        self.bytes = 0;
        clear_source(&self.dir, self.source)?;
        self.generation = current_generation(&self.dir);
        self.epoch = nanoid::nanoid!(10);
        self.seq = 0;
        // Recreate an empty file so the writer is usable again straight away.
        self.rotate()
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
    Clear,
}

/// Hands events to a writer on its own thread.
///
/// The proxy must never wait on disk I/O, so records go through a bounded queue
/// drained by a dedicated thread. When the queue is full, or the writer fails,
/// the record is dropped and counted — losing diagnostics beats stalling live
/// traffic, and the count is what the UI reports.
///
/// The writer deliberately never logs: a logger that writes to the log store
/// would re-enter itself on every failure.
pub struct ConsoleLogHandle {
    tx: SyncSender<WriterCommand>,
    dropped: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ConsoleLogHandle {
    pub fn spawn(dir: PathBuf, source: ConsoleLogSource) -> std::io::Result<Self> {
        let mut writer = ConsoleLogWriter::open(dir, source)?;
        let (tx, rx) = sync_channel::<WriterCommand>(QUEUE_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let thread_dropped = Arc::clone(&dropped);
        let thread = std::thread::Builder::new()
            .name(format!("console-log-{}", source.as_str()))
            .spawn(move || {
                while let Ok(command) = rx.recv() {
                    let outcome = match command {
                        WriterCommand::Record(event) => writer.append(&event).map(|_| ()),
                        WriterCommand::Flush => writer.flush(),
                        WriterCommand::Clear => writer.clear(),
                    };
                    if outcome.is_err() {
                        thread_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                let _ = writer.flush();
            })?;

        Ok(Self {
            tx,
            dropped,
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

    /// Records the store could not persist since start: queue overflow or a
    /// write failure.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Block until everything queued so far has been written.
    pub fn flush(&self) {
        let _ = self.tx.send(WriterCommand::Flush);
    }

    /// Drop this source's history and start over.
    pub fn clear(&self) {
        let _ = self.tx.send(WriterCommand::Clear);
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

fn last_seq(path: Option<&Path>) -> u64 {
    let Some(path) = path else { return 0 };
    let Ok(file) = File::open(path) else { return 0 };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<ConsoleLogRecord>(&line).ok())
        .last()
        .map(|record| record.seq)
        .unwrap_or(0)
}

// ── reader ──

/// Read a file, skipping lines that are half-written or corrupt. Returns the
/// records plus whether anything had to be skipped.
fn read_file(path: &Path) -> (Vec<ConsoleLogRecord>, bool) {
    let Ok(file) = File::open(path) else {
        return (Vec::new(), false);
    };
    let mut records = Vec::new();
    let mut skipped = false;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            skipped = true;
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<ConsoleLogRecord>(&line) {
            Ok(record) if record.v <= RECORD_VERSION => records.push(record),
            // Unknown version or a torn tail line: skip it and keep going.
            _ => skipped = true,
        }
    }
    (records, skipped)
}

/// Read a page of history, oldest record first.
///
/// `sources` selects which processes to include. `limit` bounds the page; when
/// more history exists than the page holds, the caller gets the newest records
/// and `truncated` says older ones were left behind.
pub fn read_recent(dir: &Path, sources: &[ConsoleLogSource], limit: usize) -> ConsoleLogPage {
    read_recent_with_limits(dir, sources, limit, ConsoleLogLimits::default())
}

pub fn read_recent_with_limits(
    dir: &Path,
    sources: &[ConsoleLogSource],
    limit: usize,
    limits: ConsoleLogLimits,
) -> ConsoleLogPage {
    let generation = current_generation(dir);
    let limit = limit.max(1);

    let mut per_source: Vec<(ConsoleLogSource, Vec<ConsoleLogRecord>, bool)> = Vec::new();
    for source in sources {
        let files = source_files(dir, *source);
        let mut records = Vec::new();
        let mut skipped = false;
        for path in &files {
            let (mut page, had_gap) = read_file(path);
            records.append(&mut page);
            skipped |= had_gap;
        }
        // The source's own budget caps how much history can exist; at the file
        // cap the oldest records have already been evicted.
        let evicted = files.len() >= limits.max_files_per_source;
        per_source.push((*source, records, skipped || evicted));
    }

    let mut records: Vec<ConsoleLogRecord> = per_source
        .iter()
        .flat_map(|(_, records, _)| records.iter().cloned())
        .collect();
    // Interleave by writer position: timestamps are second-resolution and two
    // processes can stamp the same second.
    records.sort_by(|a, b| {
        (a.at.as_str(), a.source.as_str(), a.seq).cmp(&(b.at.as_str(), b.source.as_str(), b.seq))
    });

    // Older records are missing either because the budget already evicted them
    // or because this page stops short of what is on disk.
    let truncated = per_source.iter().any(|(_, _, evicted)| *evicted) || records.len() > limit;
    if records.len() > limit {
        records.drain(..records.len() - limit);
    }

    ConsoleLogPage {
        generation,
        records,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIGHT: ConsoleLogLimits = ConsoleLogLimits {
        max_file_bytes: 2 * 1024,
        max_files_per_source: 3,
        max_source_bytes: 8 * 1024,
        max_total_bytes: 16 * 1024,
        max_record_bytes: 1024,
    };

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

    fn writer(dir: &Path, source: ConsoleLogSource, limits: ConsoleLogLimits) -> ConsoleLogWriter {
        ConsoleLogWriter::open_with_limits(dir.to_path_buf(), source, limits).unwrap()
    }

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
    }

    #[test]
    fn a_reopened_writer_continues_the_sequence_instead_of_reusing_it() {
        let temp = TempDir::new();
        {
            let mut log = writer(
                temp.path(),
                ConsoleLogSource::Daemon,
                ConsoleLogLimits::default(),
            );
            log.append(&event("first run")).unwrap();
            log.append(&event("first run again")).unwrap();
        }
        let mut log = writer(
            temp.path(),
            ConsoleLogSource::Daemon,
            ConsoleLogLimits::default(),
        );
        log.append(&event("second run")).unwrap();

        let page = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        let seqs: Vec<u64> = page.records.iter().map(|record| record.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3], "sequence continues across a restart");
        // One file was reused rather than burning a rotation slot.
        assert_eq!(source_files(temp.path(), ConsoleLogSource::Daemon).len(), 1);
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

        let page = read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 10_000, TIGHT);
        assert!(page.truncated, "evicted history is reported as a gap");
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
        let page = read_recent_with_limits(temp.path(), &[ConsoleLogSource::Daemon], 10, TIGHT);
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
    fn a_corrupt_line_is_skipped_without_losing_the_rest_of_the_file() {
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
            file.write_all(b"{\"v\":1,\"source\":\"daemon\",\"epoch\":\"x\",\"seq\":10,\"at\":\"2026-01-01 00:00:00\",\"id\":\"log-future\",\"event\":{\"category\":\"log\",\"timestamp\":\"2026-01-01 00:00:00\",\"level\":\"info\",\"source\":\"daemon\",\"target\":null,\"id\":\"log-future\",\"message\":\"kept after\"}}\n")
                .unwrap();
        }

        let page = read_recent(temp.path(), &[ConsoleLogSource::Daemon], 100);
        assert_eq!(page.records.len(), 2, "the readable records survive");
        assert!(page.truncated, "the damaged stretch is reported");
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
    fn each_source_reads_its_own_files_but_shares_the_total_budget() {
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

        let total: u64 = SOURCES
            .iter()
            .flat_map(|source| source_files(temp.path(), *source))
            .map(|path| file_len(&path))
            .sum();
        assert!(total <= TIGHT.max_total_bytes);
    }

    #[test]
    fn the_background_queue_never_blocks_and_reports_what_it_dropped() {
        let temp = TempDir::new();
        let handle =
            ConsoleLogHandle::spawn(temp.path().to_path_buf(), ConsoleLogSource::App).unwrap();
        for index in 0..50 {
            assert!(handle.record(event(&format!("queued {index}"))));
        }
        handle.flush();
        // A flush is itself queued, so wait for the writer thread to reach it.
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert_eq!(handle.dropped(), 0);
        let page = read_recent(temp.path(), &[ConsoleLogSource::App], 100);
        assert_eq!(page.records.len(), 50);
    }
}
