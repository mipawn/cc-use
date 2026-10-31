//! Retention / ownership / directory-lock integration tests (T13).
//!
//! # Cross-process evidence level
//!
//! These cases use **two independent `ConsoleLogHandle`/`ConsoleLogDirLock`
//! instances in one test process**, not two `fork`ed OS processes. That is still
//! a real kernel-lock test on macOS: `flock` is attached to the open file
//! description, so two separately opened lock files contend exactly like two
//! processes do, and the store's in-process mutex cannot explain the observed
//! blocking/timing (each lock sample goes through [`ConsoleLogDirLock`], which
//! only calls `flock`). A true multi-process harness is not added because a
//! forked child cannot see the parent's temporary directory through `cargo
//! test`'s binary reliably and would make failures much harder to diagnose; the
//! limitation is stated here rather than hidden.
//!
//! What is proven:
//! - `flock` contention is visible, bounded by a timeout and released cleanly;
//! - a held maintenance lock makes maintenance/clear report an error instead of
//!   silently corrupting files;
//! - a shared read degrades to a bounded unlocked scan instead of hanging while
//!   maintenance holds the write lock;
//! - two writers of the same source get distinct epochs and active files and
//!   allocate unique rotation indexes under the metadata lock.

use cc_use_lib::proxy::console::ConsoleEvent;
use cc_use_lib::services::console_log_store::{
    read_recent, source_files, ConsoleLogDirLock, ConsoleLogHandle, ConsoleLogLimits,
    ConsoleLogOptions, ConsoleLogSource,
};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn options(limits: ConsoleLogLimits) -> ConsoleLogOptions {
    ConsoleLogOptions {
        limits,
        maintenance_interval: Duration::from_secs(30),
        dir_lock_timeout: Duration::from_millis(300),
        ..ConsoleLogOptions::default()
    }
}

fn spawn(dir: &Path, source: ConsoleLogSource, options: ConsoleLogOptions) -> ConsoleLogHandle {
    ConsoleLogHandle::spawn_with(dir.to_path_buf(), source, options).expect("console log store")
}

fn log_event(message: &str) -> ConsoleEvent {
    ConsoleEvent::log("info", "daemon", Some("cc_use_daemon::runtime"), message)
}

fn rotation_index(path: &Path) -> u64 {
    // `daemon-<epoch>-<index:05>.jsonl`
    let name = path.file_name().unwrap().to_string_lossy();
    let rest = name.strip_suffix(".jsonl").expect("jsonl name");
    let (_epoch, index) = rest.rsplit_once('-').expect("index suffix");
    index.parse().expect("numeric rotation index")
}

fn generous_limits() -> ConsoleLogLimits {
    ConsoleLogLimits {
        max_file_bytes: 128,
        max_files_per_source: 100,
        max_source_bytes: 10 * 1024 * 1024,
        max_record_bytes: 256 * 1024,
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "cc-use-console-retention-{}-{}",
        label,
        nanoid::nanoid!(8)
    ));
    std::fs::create_dir_all(&path).expect("temp dir");
    path
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}

/// Two separately opened file descriptors contend for the real `flock`, and a
/// bounded acquisition times out instead of blocking forever.
#[test]
fn flock_contention_between_independent_descriptors_is_bounded() {
    let dir = temp_dir("flock");
    let held = ConsoleLogDirLock::try_acquire(&dir)
        .expect("first acquisition")
        .expect("lock is free");

    assert!(
        ConsoleLogDirLock::try_acquire(&dir)
            .expect("second try")
            .is_none(),
        "a held exclusive lock is visible to another descriptor"
    );

    let started = Instant::now();
    let contended = ConsoleLogDirLock::acquire(&dir, Duration::from_millis(150));
    let waited = started.elapsed();
    assert!(
        contended.is_err(),
        "the blocked acquisition reports a timeout"
    );
    assert!(
        waited >= Duration::from_millis(120),
        "the wait was not a spurious immediate failure: {:?}",
        waited
    );
    assert!(
        waited < Duration::from_secs(3),
        "the wait stayed bounded: {:?}",
        waited
    );

    drop(held);
    ConsoleLogDirLock::acquire(&dir, Duration::from_secs(1)).expect("released lock is acquirable");
    cleanup(&dir);
}

/// A held maintenance lock is surfaced as maintenance state, and it makes clear
/// fail instead of pretending the files were removed.
#[test]
fn a_held_lock_is_reported_as_maintenance_state_and_blocks_clear() {
    let dir = temp_dir("maintenance-state");
    let handle = spawn(
        &dir,
        ConsoleLogSource::App,
        options(ConsoleLogLimits::default()),
    );
    handle.record(log_event("before the lock"));
    handle
        .flush_and_wait(Duration::from_secs(5))
        .expect("flush ack");

    let before = handle.maintenance_state().lock_failures;
    let held = ConsoleLogDirLock::acquire(&dir, Duration::from_secs(1)).expect("hold lock");

    let started = Instant::now();
    let maintenance = handle.maintain_now(Duration::from_secs(2));
    assert!(
        maintenance.is_err(),
        "maintenance must not silently skip a held lock"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "maintenance waited a bounded time: {:?}",
        started.elapsed()
    );
    let state = handle.maintenance_state();
    assert!(state.lock_failures > before);
    assert!(state.last_error.is_some());

    let clear = handle.clear_and_wait(Duration::from_secs(2));
    assert!(
        clear.is_err(),
        "clear cannot delete files while another owner holds the lock"
    );
    // The record survived the failed clear: no corruption, no half state.
    assert_eq!(
        read_recent(&dir, &[ConsoleLogSource::App], 10)
            .records
            .len(),
        1
    );

    drop(held);
    handle
        .clear_and_wait(Duration::from_secs(5))
        .expect("clear succeeds once the lock is released");
    assert!(read_recent(&dir, &[ConsoleLogSource::App], 10)
        .records
        .is_empty());
}

/// A shared history read must not hang behind a held write lock: it degrades to
/// a bounded unlocked scan, and a later clear still works.
#[test]
fn a_shared_history_read_stays_bounded_while_maintenance_holds_the_lock() {
    let dir = temp_dir("shared-read");
    let handle = spawn(
        &dir,
        ConsoleLogSource::Daemon,
        options(ConsoleLogLimits::default()),
    );
    handle.record(log_event("readable while locked"));
    handle
        .flush_and_wait(Duration::from_secs(5))
        .expect("flush ack");

    let held = ConsoleLogDirLock::acquire(&dir, Duration::from_secs(1)).expect("hold lock");
    let reader_dir = dir.clone();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let page = read_recent(&reader_dir, &[ConsoleLogSource::Daemon], 10);
        let _ = tx.send(page.records.len());
    });

    let count = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("the read must finish despite the held maintenance lock");
    assert_eq!(count, 1, "the bounded read still returns the history");
    reader.join().expect("reader thread");

    drop(held);
    cleanup(&dir);
}

/// Two writers owning the same source must not share an epoch or an active
/// file, both sets of records stay replayable, and rotation indexes allocated
/// under the meta lock stay unique.
#[test]
fn two_writers_of_one_source_get_unique_epochs_active_files_and_indexes() {
    let dir = temp_dir("same-source");
    let limits = generous_limits();
    let first = spawn(&dir, ConsoleLogSource::Daemon, options(limits));
    let second = spawn(&dir, ConsoleLogSource::Daemon, options(limits));
    assert_ne!(first.epoch(), second.epoch(), "epochs are per process");

    let first_active = first.active_path().expect("first active");
    let second_active = second.active_path().expect("second active");
    assert_ne!(
        first_active, second_active,
        "a new writer never reuses another writer's active file"
    );

    for index in 0..6 {
        first.record(log_event(&format!("first writer {index}")));
        second.record(log_event(&format!("second writer {index}")));
    }
    first
        .flush_and_wait(Duration::from_secs(5))
        .expect("first flush");
    second
        .flush_and_wait(Duration::from_secs(5))
        .expect("second flush");

    assert!(
        first_active.exists(),
        "the first writer's active file survives"
    );
    assert!(
        second_active.exists(),
        "the second writer's active file survives"
    );

    let page = read_recent(&dir, &[ConsoleLogSource::Daemon], 100);
    let epochs: std::collections::BTreeSet<&str> = page
        .records
        .iter()
        .map(|record| record.epoch.as_str())
        .collect();
    assert_eq!(epochs.len(), 2, "records from both writers are replayable");
    assert_eq!(page.records.len(), 12);

    let mut indexes: Vec<u64> = source_files(&dir, ConsoleLogSource::Daemon)
        .iter()
        .map(|path| rotation_index(path))
        .collect();
    let total = indexes.len();
    indexes.sort_unstable();
    indexes.dedup();
    assert_eq!(
        indexes.len(),
        total,
        "the metadata lock hands out unique rotation indexes"
    );
}

/// Concurrent rotation from two writers never loses the metadata update: every
/// file got a distinct index and the directory is readable end-to-end.
#[test]
fn concurrent_rotations_keep_the_metadata_consistent() {
    let dir = temp_dir("meta-race");
    let limits = generous_limits();
    let first = spawn(&dir, ConsoleLogSource::App, options(limits));
    let second = spawn(&dir, ConsoleLogSource::App, options(limits));

    let first_thread = std::thread::spawn(move || {
        for index in 0..10 {
            first.record(log_event(&format!("racer a {index}")));
        }
        first
            .flush_and_wait(Duration::from_secs(10))
            .expect("flush a");
        first
    });
    let second_thread = std::thread::spawn(move || {
        for index in 0..10 {
            second.record(log_event(&format!("racer b {index}")));
        }
        second
            .flush_and_wait(Duration::from_secs(10))
            .expect("flush b");
        second
    });
    let first = first_thread.join().expect("first writer");
    let second = second_thread.join().expect("second writer");

    let files = source_files(&dir, ConsoleLogSource::App);
    let indexes: Vec<u64> = files.iter().map(|path| rotation_index(path)).collect();
    let mut unique = indexes.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        indexes.len(),
        "no two writers ever receive the same rotation index: {:?}",
        indexes
    );
    assert!(
        indexes.len() >= 4,
        "small file budget produced several rotations, got {}",
        indexes.len()
    );

    let page = read_recent(&dir, &[ConsoleLogSource::App], 100);
    assert_eq!(page.records.len(), 20, "all records remain readable");

    drop(first);
    drop(second);
    cleanup(&dir);
}

/// The public integration surface keeps the documented budget constants.
#[test]
fn the_ownership_and_capacity_contract_is_public() {
    assert_eq!(
        cc_use_lib::services::console_log_store::MAX_FILE_BYTES,
        10 * 1024 * 1024
    );
    assert_eq!(
        cc_use_lib::services::console_log_store::MAX_FILES_PER_SOURCE,
        5
    );
    assert_eq!(
        cc_use_lib::services::console_log_store::MAX_SOURCE_BYTES,
        50 * 1024 * 1024
    );
    assert_eq!(
        cc_use_lib::services::console_log_store::RETENTION_LOCAL_DAYS,
        3
    );
}
