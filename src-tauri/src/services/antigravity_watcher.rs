//! Event-driven, single-flight reconciliation of Antigravity usage.
//!
//! Antigravity writes its conversation databases continuously while a chat is
//! live, so the index follows the files instead of polling them. Three
//! independent triggers funnel into one serialized worker:
//!
//! 1. an FSEvents watcher on both `conversations/` directories (coalesced per
//!    conversation, debounced),
//! 2. an explicit full reconciliation requested by startup, page-open and the
//!    manual refresh shortcut, and
//! 3. a full reconciliation after the watcher attaches to a directory that did
//!    not exist when the app started (e.g. the CLI is installed later).
//!
//! The worker never holds the `cc-use.db` mutex while reading an external
//! database: conversation files are read first, then written in one short
//! per-conversation transaction.
//!
//! This module stays Tauri-free (see `backend/architecture.md`): the owner that
//! needs an `AppHandle` lifetime injects a [`SyncObserver`].

use crate::db::antigravity_usage::AntigravitySource;
use crate::db::Database;
use crate::models::AntigravitySyncSummary;
use crate::services::antigravity_sync::{
    build_conversation_batch, scan_conversations, AntigravityConversationFile,
    ConversationMetadataIndex,
};
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Events for one conversation arrive as a burst of `.db`, `.db-wal` and
/// `.db-shm` notifications while a response streams. Reconcile once the burst
/// goes quiet.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// A conversation that keeps streaming never goes quiet; still reconcile.
const MAX_COALESCE: Duration = Duration::from_secs(3);

/// Called by the worker after a pass that changed the index, so the owning
/// layer can refresh the tray badge and tell open views to reload.
pub trait SyncObserver: Send + Sync {
    fn index_updated(&self, summary: &AntigravitySyncSummary);
}

enum SyncRequest {
    /// Watcher-driven pass limited to these conversations.
    Targets(HashSet<(AntigravitySource, String)>),
    /// Scan every conversation and reconcile whatever changed. `reply` is only
    /// present for callers that wait for the result.
    Full {
        reply: Option<tokio::sync::oneshot::Sender<Result<AntigravitySyncSummary, String>>>,
    },
}

/// Owns the worker, the debounce thread and the OS watcher.
///
/// Managed as application state; the threads end when the process does.
pub struct AntigravitySyncManager {
    tx: Sender<SyncRequest>,
    watchers: Arc<Mutex<WatchRegistry>>,
}

impl AntigravitySyncManager {
    /// Starts the watcher, the debounce thread and the worker thread. Never
    /// blocks: the cold-start import is queued asynchronously.
    pub fn start(db: Arc<Mutex<Database>>, observer: Arc<dyn SyncObserver>) -> Self {
        let (event_tx, event_rx) = mpsc::channel::<Vec<PathBuf>>();
        let (sync_tx, sync_rx) = mpsc::channel::<SyncRequest>();

        let watchers = Arc::new(Mutex::new(WatchRegistry::new(event_tx)));
        {
            let mut registry = watchers.lock().unwrap_or_else(|error| error.into_inner());
            registry.attach_missing();
        }

        spawn_debounce_thread(event_rx, sync_tx.clone(), Arc::clone(&watchers));
        spawn_worker_thread(sync_rx, db, observer);

        let manager = Self {
            tx: sync_tx,
            watchers,
        };
        // Everything indexed before this boot may have moved on without us.
        manager.request_full_sync_detached();
        manager
    }

    /// Asks the worker for a full pass and waits for its result.
    pub async fn request_full_sync(&self) -> Result<AntigravitySyncSummary, String> {
        // A root may have been created since this boot (e.g. the CLI was just
        // installed). Re-attach before scanning so realtime updates resume.
        self.reattach();
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.tx
            .send(SyncRequest::Full { reply: Some(reply) })
            .map_err(|_| "Antigravity sync worker is not running".to_string())?;
        receiver
            .await
            .map_err(|_| "Antigravity sync worker stopped before replying".to_string())?
    }

    /// Fire-and-forget full pass used by startup and page-open catch-up.
    pub fn request_full_sync_detached(&self) {
        self.reattach();
        let _ = self.tx.send(SyncRequest::Full { reply: None });
    }

    /// Re-checks the watched directories and queues a catch-up pass for any
    /// directory that only now became watchable.
    pub fn reattach(&self) {
        let mut registry = self
            .watchers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if registry.attach_missing() {
            let _ = self.tx.send(SyncRequest::Full { reply: None });
        }
    }
}

struct WatchRegistry {
    event_tx: Sender<Vec<PathBuf>>,
    watcher: Option<notify::RecommendedWatcher>,
    watched: HashSet<PathBuf>,
    /// Paths that failed to attach once; retried silently to avoid log spam.
    failed: HashSet<PathBuf>,
}

impl WatchRegistry {
    fn new(event_tx: Sender<Vec<PathBuf>>) -> Self {
        Self {
            event_tx,
            watcher: None,
            watched: HashSet::new(),
            failed: HashSet::new(),
        }
    }

    /// `~/.gemini` is watched non-recursively so a later `antigravity-cli`
    /// install is noticed; each existing `<root>/conversations` is watched too.
    fn desired_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        if let Some(home) = dirs::home_dir() {
            let gemini = home.join(".gemini");
            if gemini.is_dir() {
                paths.push(gemini);
            }
        }
        for (_, conversations) in source_conversation_dirs() {
            paths.push(conversations);
        }
        paths
    }

    /// Returns `true` when at least one new directory started being watched.
    fn attach_missing(&mut self) -> bool {
        // A deleted-and-recreated `conversations/` gets a new inode; drop the
        // stale entry so it is watched again instead of silently ignored.
        self.watched.retain(|path| path.is_dir());
        self.failed.retain(|path| path.is_dir());

        if self.watcher.is_none() {
            let event_tx = self.event_tx.clone();
            let Ok(watcher) =
                notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                    match result {
                        // Bursts are coalesced downstream, so forward as-is.
                        Ok(event) => {
                            let _ = event_tx.send(event.paths);
                        }
                        Err(error) => log::debug!("Antigravity watcher error: {}", error),
                    }
                })
            else {
                log::warn!("Failed to create the Antigravity file watcher");
                return false;
            };
            self.watcher = Some(watcher);
        }
        let Some(watcher) = self.watcher.as_mut() else {
            return false;
        };
        let mut attached = false;
        for path in Self::desired_paths() {
            if self.watched.contains(&path) {
                continue;
            }
            match watcher.watch(&path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.failed.remove(&path);
                    self.watched.insert(path);
                    attached = true;
                }
                Err(error) => {
                    // Retried on the next pass; only the first failure is worth
                    // a warning, a locked/absent directory is not news.
                    if self.failed.insert(path.clone()) {
                        log::warn!(
                            "Failed to watch {} for Antigravity usage: {}",
                            path.display(),
                            error
                        );
                    }
                }
            }
        }
        attached
    }
}

fn spawn_debounce_thread(
    event_rx: mpsc::Receiver<Vec<PathBuf>>,
    sync_tx: Sender<SyncRequest>,
    watchers: Arc<Mutex<WatchRegistry>>,
) {
    let spawned = std::thread::Builder::new()
        .name("antigravity-debounce".to_string())
        .spawn(move || {
            let mut pending: HashSet<PathBuf> = HashSet::new();
            let mut burst_started_at = Instant::now();
            let mut deadline = Instant::now() + DEBOUNCE;
            loop {
                let wait = deadline.saturating_duration_since(Instant::now());
                match event_rx.recv_timeout(wait) {
                    Ok(paths) => {
                        if pending.is_empty() {
                            burst_started_at = Instant::now();
                        }
                        pending.extend(paths);
                        if Instant::now().duration_since(burst_started_at) >= MAX_COALESCE {
                            flush(&mut pending, &sync_tx, &watchers);
                        }
                        deadline = Instant::now() + DEBOUNCE;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        flush(&mut pending, &sync_tx, &watchers);
                        deadline = Instant::now() + DEBOUNCE;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    if let Err(error) = spawned {
        // Realtime updates degrade to the startup/page-open full passes; the
        // index stays correct, just not live.
        log::error!("Failed to spawn the Antigravity debounce thread: {}", error);
    }
}

fn flush(
    pending: &mut HashSet<PathBuf>,
    sync_tx: &Sender<SyncRequest>,
    watchers: &Arc<Mutex<WatchRegistry>>,
) {
    if pending.is_empty() {
        return;
    }
    let paths: Vec<PathBuf> = pending.drain().collect();
    // A newly created root has no watcher yet; attach it so later commits are
    // seen, and recover whatever was written before the watch existed.
    let attached = {
        let mut registry = watchers.lock().unwrap_or_else(|error| error.into_inner());
        registry.attach_missing()
    };
    if attached {
        let _ = sync_tx.send(SyncRequest::Full { reply: None });
    }
    let targets = event_targets(&paths, &source_roots());
    if !targets.is_empty() {
        let _ = sync_tx.send(SyncRequest::Targets(targets));
    }
}

/// `(source, conversations dir)` for every installation that exists right now.
fn source_conversation_dirs() -> Vec<(AntigravitySource, PathBuf)> {
    source_roots()
        .into_iter()
        .filter(|(_, root)| root.join("conversations").is_dir())
        .map(|(source, root)| (source, root.join("conversations")))
        .collect()
}

fn source_roots() -> Vec<(AntigravitySource, PathBuf)> {
    AntigravitySource::ALL
        .into_iter()
        .filter_map(|source| source.root_dir().map(|root| (source, root)))
        .collect()
}

/// Maps raw watcher paths back to `(source, conversation_id)`.
///
/// `.db`, `.db-wal` and `.db-shm` all describe the same conversation, and the
/// whole database is re-read either way.
fn event_targets(
    paths: &[PathBuf],
    roots: &[(AntigravitySource, PathBuf)],
) -> HashSet<(AntigravitySource, String)> {
    paths
        .iter()
        .filter_map(|path| event_target(path, roots))
        .collect()
}

fn event_target(
    path: &Path,
    roots: &[(AntigravitySource, PathBuf)],
) -> Option<(AntigravitySource, String)> {
    let file_name = path.file_name()?.to_str()?;
    let stem = file_name
        .strip_suffix(".db-wal")
        .or_else(|| file_name.strip_suffix(".db-shm"))
        .or_else(|| file_name.strip_suffix(".db"))?;
    if stem.is_empty() || stem.contains('.') {
        return None;
    }
    let parent = path.parent()?;
    roots
        .iter()
        .find(|(_, root)| parent == root.join("conversations"))
        .map(|(source, _)| (*source, stem.to_string()))
}

fn spawn_worker_thread(
    sync_rx: mpsc::Receiver<SyncRequest>,
    db: Arc<Mutex<Database>>,
    observer: Arc<dyn SyncObserver>,
) {
    let spawned = std::thread::Builder::new()
        .name("antigravity-sync".to_string())
        .spawn(move || {
            while let Ok(first) = sync_rx.recv() {
                // One pass per burst: later requests are folded in, never run
                // concurrently, and every waiting caller gets a reply.
                let mut selection = Selection::default();
                let mut replies = Vec::new();
                absorb(first, &mut selection, &mut replies);
                while let Ok(next) = sync_rx.try_recv() {
                    absorb(next, &mut selection, &mut replies);
                }

                let result = reconcile(&db, selection, scan_conversations());
                match &result {
                    Ok(summary) => {
                        if summary.updated_conversations > 0 || summary.removed_files > 0 {
                            observer.index_updated(summary);
                        }
                    }
                    Err(error) => log::warn!("Antigravity usage sync failed: {}", error),
                }
                for reply in replies {
                    let _ = reply.send(result.clone());
                }
            }
        });
    if let Err(error) = spawned {
        log::error!(
            "Failed to spawn the Antigravity sync worker thread: {}",
            error
        );
    }
}

fn absorb(
    request: SyncRequest,
    selection: &mut Selection,
    replies: &mut Vec<tokio::sync::oneshot::Sender<Result<AntigravitySyncSummary, String>>>,
) {
    match request {
        SyncRequest::Targets(found) => {
            selection
                .targets
                .get_or_insert_with(HashSet::new)
                .extend(found);
        }
        SyncRequest::Full { reply } => {
            selection.full = true;
            if let Some(reply) = reply {
                replies.push(reply);
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Selection {
    /// `None` means "every conversation a full pass would consider".
    targets: Option<HashSet<(AntigravitySource, String)>>,
    full: bool,
}

impl Selection {
    fn is_empty(&self) -> bool {
        self.targets.is_none() && !self.full
    }

    /// A full pass always covers every target, so it wins over the filter.
    fn is_full_scan(&self) -> bool {
        self.full || self.targets.is_none()
    }

    #[cfg(test)]
    fn full_pass() -> Self {
        Self {
            targets: None,
            full: true,
        }
    }

    fn files_to_consider(
        &self,
        files: Vec<AntigravityConversationFile>,
    ) -> Vec<AntigravityConversationFile> {
        match self.targets.as_ref() {
            Some(targets) if !self.is_full_scan() => files
                .into_iter()
                .filter(|file| targets.contains(&(file.source, file.conversation_id.clone())))
                .collect(),
            _ => files,
        }
    }
}

/// Serializes the decision half of a pass so it can be tested without touching
/// the home directory: which conversations are stale, what gets written, and
/// which file pointers disappeared.
fn reconcile(
    db: &Arc<Mutex<Database>>,
    selection: Selection,
    files: Vec<AntigravityConversationFile>,
) -> Result<AntigravitySyncSummary, String> {
    if selection.is_empty() {
        return Ok(AntigravitySyncSummary::default());
    }
    let scanned_files = files.len();
    let state = {
        let db = db
            .lock()
            .map_err(|error| format!("cc-use database is unavailable: {error}"))?;
        db.antigravity_sync_state_map().map_err(|e| e.to_string())?
    };

    let mut metadata: HashMap<AntigravitySource, ConversationMetadataIndex> = HashMap::new();
    let mut updated_conversations = 0usize;
    let mut changed: Vec<AntigravityConversationFile> = Vec::new();
    let candidates = selection.files_to_consider(files);
    let mut considered_paths: HashSet<String> = HashSet::new();
    for file in candidates {
        let path = file.db_path.to_string_lossy().to_string();
        considered_paths.insert(path.clone());
        let unchanged = state
            .get(&path)
            .is_some_and(|known| *known == file.fingerprint);
        if !unchanged {
            changed.push(file);
        }
    }

    for file in &changed {
        let index = metadata
            .entry(file.source)
            .or_insert_with(|| ConversationMetadataIndex::load(file.source));
        // External I/O happens before the write lock is taken.
        match build_conversation_batch(file, index) {
            Ok(batch) => {
                let apply = {
                    let db = db
                        .lock()
                        .map_err(|error| format!("cc-use database is unavailable: {error}"))?;
                    db.antigravity_sync_apply_conversation(&batch)
                };
                match apply {
                    Ok(()) => updated_conversations += 1,
                    Err(error) => log::warn!(
                        "Failed to index Antigravity conversation {}: {}",
                        batch.conversation_id,
                        error
                    ),
                }
            }
            Err(error) => log::warn!(
                "Skipping unreadable Antigravity conversation {}: {}",
                file.db_path.display(),
                error
            ),
        }
    }

    let mut removed_files = 0usize;
    if selection.is_full_scan() {
        let missing: Vec<String> = state
            .keys()
            .filter(|path| !considered_paths.contains(*path))
            .cloned()
            .collect();
        if !missing.is_empty() {
            let db = db
                .lock()
                .map_err(|error| format!("cc-use database is unavailable: {error}"))?;
            removed_files = db
                .antigravity_sync_prune_missing(&missing)
                .map_err(|e| e.to_string())?;
        }
    }

    log::debug!(
        "Antigravity sync pass: {} scanned, {} updated, {} pruned",
        scanned_files,
        updated_conversations,
        removed_files
    );
    Ok(AntigravitySyncSummary {
        scanned_files,
        updated_conversations,
        removed_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::antigravity_usage::AntigravitySyncFingerprint;

    fn roots() -> Vec<(AntigravitySource, PathBuf)> {
        vec![
            (
                AntigravitySource::Desktop,
                PathBuf::from("/home/u/.gemini/antigravity"),
            ),
            (
                AntigravitySource::Cli,
                PathBuf::from("/home/u/.gemini/antigravity-cli"),
            ),
        ]
    }

    fn memory_db() -> Arc<Mutex<Database>> {
        Arc::new(Mutex::new(Database::new_in_memory().unwrap()))
    }

    fn file(
        source: AntigravitySource,
        conversation_id: &str,
        db_size: i64,
    ) -> AntigravityConversationFile {
        AntigravityConversationFile {
            source,
            conversation_id: conversation_id.to_string(),
            db_path: PathBuf::from(format!("/tmp/{conversation_id}.db")),
            fingerprint: AntigravitySyncFingerprint {
                db_size,
                db_mtime_ns: 1,
                wal_size: 0,
                wal_mtime_ns: 0,
            },
        }
    }

    fn recorded(db: &Arc<Mutex<Database>>) -> Vec<(String, String)> {
        let db = db.lock().unwrap();
        let mut statement = db
            .conn
            .prepare(
                "SELECT file_path, conversation_id FROM antigravity_sync_files ORDER BY file_path",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn db_wal_and_shm_events_coalesce_to_one_conversation() {
        let roots = roots();
        let conversations = roots[1].1.join("conversations");
        let paths = [
            conversations.join("abc-123.db"),
            conversations.join("abc-123.db-wal"),
            conversations.join("abc-123.db-shm"),
        ];
        let targets = event_targets(&paths, &roots);
        assert_eq!(targets.len(), 1);
        assert!(targets.contains(&(AntigravitySource::Cli, "abc-123".to_string())));
    }

    #[test]
    fn unrelated_files_are_ignored() {
        let roots = roots();
        let conversations = roots[0].1.join("conversations");
        for path in [
            // The title index and its sidecars live beside `conversations/`.
            roots[0].1.join("conversation_summaries.db"),
            roots[0].1.join("conversation_summaries.db-wal"),
            roots[0].1.join("abc.db"),
            conversations.join("notes.txt"),
            conversations.join(".db"),
            conversations.join(".db-wal"),
            conversations.join("a.b.db"),
        ] {
            assert!(event_target(&path, &roots).is_none(), "{}", path.display());
        }
    }

    #[test]
    fn each_root_maps_to_its_own_source() {
        let roots = roots();
        assert_eq!(
            event_target(&roots[0].1.join("conversations/a.db"), &roots),
            Some((AntigravitySource::Desktop, "a".to_string()))
        );
        assert_eq!(
            event_target(&roots[1].1.join("conversations/a.db"), &roots),
            Some((AntigravitySource::Cli, "a".to_string()))
        );
    }

    #[test]
    fn a_target_pass_only_considers_the_reported_conversations() {
        let files = vec![
            file(AntigravitySource::Desktop, "keep", 10),
            file(AntigravitySource::Desktop, "skip", 10),
        ];
        let mut targets = HashSet::new();
        targets.insert((AntigravitySource::Desktop, "keep".to_string()));
        let selection = Selection {
            targets: Some(targets),
            full: false,
        };
        let selected = selection.files_to_consider(files.clone());
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].conversation_id, "keep");

        // A queued full pass must not be narrowed by an earlier target request.
        let both = Selection {
            targets: Some(HashSet::new()),
            full: true,
        };
        assert_eq!(both.files_to_consider(files).len(), 2);
    }

    #[test]
    fn an_empty_selection_does_no_work() {
        assert!(Selection::default().is_empty());
        assert!(!Selection {
            targets: Some(HashSet::new()),
            full: false,
        }
        .is_empty());
    }

    /// Records a fingerprint exactly as a successful pass would, without needing
    /// a readable conversation database.
    fn seed_indexed(db: &Arc<Mutex<Database>>, conversation_id: &str) {
        let db = db.lock().unwrap();
        db.antigravity_sync_apply_conversation(
            &crate::db::antigravity_usage::AntigravityConversationSyncBatch {
                source: AntigravitySource::Desktop,
                conversation_id: conversation_id.to_string(),
                file_path: format!("/tmp/{conversation_id}.db"),
                fingerprint: AntigravitySyncFingerprint {
                    db_size: 10,
                    db_mtime_ns: 1,
                    wal_size: 0,
                    wal_mtime_ns: 0,
                },
                events: Vec::new(),
            },
        )
        .unwrap();
    }

    #[test]
    fn a_queued_full_pass_still_prunes_vanished_conversations() {
        // Regression: a burst that both attaches a new root and reports .db
        // paths used to skip the prune because only `targets` was inspected.
        let db = memory_db();
        seed_indexed(&db, "gone");
        assert_eq!(recorded(&db).len(), 1);

        let mut targets = HashSet::new();
        targets.insert((AntigravitySource::Desktop, "other".to_string()));
        let summary = reconcile(
            &db,
            Selection {
                targets: Some(targets),
                full: true,
            },
            Vec::new(),
        )
        .unwrap();
        assert_eq!(summary.removed_files, 1);
        assert!(recorded(&db).is_empty());
    }

    #[test]
    fn an_unchanged_fingerprint_is_not_rescanned() {
        let db = memory_db();
        seed_indexed(&db, "conv");
        let pass = reconcile(
            &db,
            Selection::full_pass(),
            vec![file(AntigravitySource::Desktop, "conv", 10)],
        )
        .unwrap();
        // Unchanged: nothing reread, nothing pruned, pointer kept.
        assert_eq!(pass.scanned_files, 1);
        assert_eq!(pass.updated_conversations, 0);
        assert_eq!(pass.removed_files, 0);
        assert_eq!(recorded(&db).len(), 1);
    }

    #[test]
    fn a_new_wal_size_makes_the_conversation_stale_again() {
        let db = memory_db();
        seed_indexed(&db, "conv");

        // Same .db bytes, non-zero WAL: an uncheckpointed commit.
        let mut wal_only = file(AntigravitySource::Desktop, "conv", 10);
        wal_only.fingerprint.wal_size = 4096;
        wal_only.fingerprint.wal_mtime_ns = 7;
        let summary = reconcile(&db, Selection::full_pass(), vec![wal_only]).unwrap();
        // The synthetic path is unreadable, so nothing is applied, but the
        // staleness decision must have fired instead of short-circuiting.
        assert_eq!(summary.scanned_files, 1);
        assert_eq!(summary.updated_conversations, 0);
        assert_eq!(summary.removed_files, 0);
    }
}
