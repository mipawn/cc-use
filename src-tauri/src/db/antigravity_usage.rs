//! Antigravity conversation index.
//!
//! Antigravity Desktop and the Antigravity CLI keep their own per-conversation
//! SQLite databases under `~/.gemini/antigravity*`. This module owns the two
//! tables `cc-use` derives from them:
//!
//! - `antigravity_sync_files` — one row per indexed conversation database, holding
//!   the `(db, wal)` size/mtime fingerprint that decides whether it must be reread.
//! - `antigravity_usage_events` — one row per generation, ready to be merged into
//!   the observation ledger.
//!
//! `request_logs` stays strictly proxy-owned; nothing here writes to it.

use crate::db::Database;
use crate::models::RequestLogSource;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The two Antigravity installations whose conversation databases are indexed.
///
/// Serialized values double as the stored `source` discriminator, so they must
/// match `RequestLogSource::as_str`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AntigravitySource {
    Desktop,
    Cli,
}

impl AntigravitySource {
    pub const ALL: [AntigravitySource; 2] = [Self::Desktop, Self::Cli];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "antigravity_desktop",
            Self::Cli => "antigravity_cli",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Desktop => "Antigravity Desktop",
            Self::Cli => "Antigravity CLI",
        }
    }

    /// Short discriminator used inside derived event ids.
    pub fn db_prefix(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "cli",
        }
    }

    /// `~/.gemini/antigravity` / `~/.gemini/antigravity-cli`.
    /// `None` only when the home directory cannot be resolved.
    pub fn root_dir(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        Some(match self {
            Self::Desktop => home.join(".gemini").join("antigravity"),
            Self::Cli => home.join(".gemini").join("antigravity-cli"),
        })
    }

    pub fn ledger_source(self) -> RequestLogSource {
        match self {
            Self::Desktop => RequestLogSource::AntigravityDesktop,
            Self::Cli => RequestLogSource::AntigravityCli,
        }
    }
}

/// How long indexed Antigravity usage is kept. Far longer than proxy logs
/// because it is the user's only local record of that usage.
pub const RETENTION_DAYS: i64 = 365;

/// First still-retained instant, in the same fixed-width shape as `created_at`,
/// so retention can compare lexicographically.
pub fn retention_cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// `(db, wal)` identity of one conversation database. A WAL-only commit changes
/// neither the `.db` size nor its mtime, so both files must be tracked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AntigravitySyncFingerprint {
    pub db_size: i64,
    pub db_mtime_ns: i64,
    pub wal_size: i64,
    pub wal_mtime_ns: i64,
}

fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let size = i64::try_from(metadata.len()).ok()?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    Some((size, mtime_ns))
}

impl AntigravitySyncFingerprint {
    /// Reads the `(size, mtime_ns)` pair for `<db_path>` and `<db_path>-wal`.
    /// A missing WAL is `(0, 0)`, not an error.
    pub fn read(db_path: &Path) -> Self {
        let (db_size, db_mtime_ns) = file_stamp(db_path).unwrap_or((0, 0));
        let wal_path = PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
        let (wal_size, wal_mtime_ns) = file_stamp(&wal_path).unwrap_or((0, 0));
        Self {
            db_size,
            db_mtime_ns,
            wal_size,
            wal_mtime_ns,
        }
    }

    pub fn differs_from(&self, other: &Self) -> bool {
        self != other
    }
}

/// One indexed generation, already normalized for the merged ledger.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AntigravityUsageEvent {
    pub gen_idx: i64,
    /// Stable identity of one response inside a conversation, used for dedup.
    pub response_key: String,
    pub model: Option<String>,
    pub project_name: Option<String>,
    pub conversation_title: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub thinking_tokens: Option<i64>,
    pub response_tokens: Option<i64>,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub ttft_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    pub total_ms: Option<i64>,
    /// RFC 3339 UTC. Written as `YYYY-MM-DDTHH:MM:SS.mmm+00:00` so string
    /// comparison and SQLite date parsing agree.
    pub created_at: String,
}

impl AntigravityUsageEvent {
    /// `ag:<prefix>:<conversation_id>:<response_key>`.
    pub fn event_id(&self, source: AntigravitySource, conversation_id: &str) -> String {
        format!(
            "ag:{}:{}:{}",
            source.db_prefix(),
            conversation_id,
            self.response_key
        )
    }
}

/// Everything one reconciliation pass needs to replace a conversation atomically.
#[derive(Debug, Clone)]
pub struct AntigravityConversationSyncBatch {
    pub source: AntigravitySource,
    pub conversation_id: String,
    pub file_path: String,
    pub fingerprint: AntigravitySyncFingerprint,
    pub events: Vec<AntigravityUsageEvent>,
}

const EVENT_COLUMNS: &str = "id, source, conversation_id, gen_idx, response_key, model,
    project_name, conversation_title, input_tokens, output_tokens, thinking_tokens,
    response_tokens, cache_read_tokens, cache_creation_tokens, ttft_ms, generation_ms,
    total_ms, created_at";

impl Database {
    /// Fingerprint of every already-indexed conversation database, keyed by path.
    pub fn antigravity_sync_state_map(
        &self,
    ) -> Result<HashMap<String, AntigravitySyncFingerprint>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT file_path, db_size, db_mtime_ns, wal_size, wal_mtime_ns
             FROM antigravity_sync_files",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                AntigravitySyncFingerprint {
                    db_size: row.get(1)?,
                    db_mtime_ns: row.get(2)?,
                    wal_size: row.get(3)?,
                    wal_mtime_ns: row.get(4)?,
                },
            ))
        })?;
        let mut state = HashMap::new();
        for row in rows {
            let (file_path, fingerprint) = row?;
            state.insert(file_path, fingerprint);
        }
        Ok(state)
    }

    /// Replace one conversation's rows and record its fingerprint in a single
    /// short transaction. A conversation whose generations all disappeared ends
    /// up with zero events but still stores the new fingerprint, so it is not
    /// rescanned on every pass.
    pub fn antigravity_sync_apply_conversation(
        &self,
        batch: &AntigravityConversationSyncBatch,
    ) -> Result<(), rusqlite::Error> {
        let source = batch.source.as_str();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM antigravity_usage_events WHERE source = ?1 AND conversation_id = ?2",
            rusqlite::params![source, batch.conversation_id],
        )?;
        // A conversation that is still active must not re-import generations the
        // retention window has already dropped. Cleanup only runs at startup, so
        // the same bound has to be applied on write.
        let cutoff = retention_cutoff();
        {
            let mut insert = tx.prepare(&format!(
                "INSERT OR REPLACE INTO antigravity_usage_events ({EVENT_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
            ))?;
            for event in batch
                .events
                .iter()
                .filter(|event| event.created_at >= cutoff)
            {
                insert.execute(rusqlite::params![
                    event.event_id(batch.source, &batch.conversation_id),
                    source,
                    batch.conversation_id,
                    event.gen_idx,
                    event.response_key,
                    event.model,
                    event.project_name,
                    event.conversation_title,
                    event.input_tokens,
                    event.output_tokens,
                    event.thinking_tokens,
                    event.response_tokens,
                    event.cache_read_tokens,
                    event.cache_creation_tokens,
                    event.ttft_ms,
                    event.generation_ms,
                    event.total_ms,
                    event.created_at,
                ])?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO antigravity_sync_files
                (file_path, source, conversation_id, db_size, db_mtime_ns, wal_size, wal_mtime_ns, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                batch.file_path,
                source,
                batch.conversation_id,
                batch.fingerprint.db_size,
                batch.fingerprint.db_mtime_ns,
                batch.fingerprint.wal_size,
                batch.fingerprint.wal_mtime_ns,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        tx.commit()
    }

    /// Drop file pointers that no longer exist. Historical events are kept; only
    /// the retention sweep deletes usage.
    pub fn antigravity_sync_prune_missing(
        &self,
        missing_paths: &[String],
    ) -> Result<usize, rusqlite::Error> {
        if missing_paths.is_empty() {
            return Ok(0);
        }
        let mut deleted = 0usize;
        for path in missing_paths {
            deleted += self.conn.execute(
                "DELETE FROM antigravity_sync_files WHERE file_path = ?1",
                [path],
            )?;
        }
        Ok(deleted)
    }

    /// Retention sweep. Antigravity data is kept far longer than proxy logs
    /// because it is the user's only local record of that usage.
    pub fn antigravity_usage_cleanup_old(&self, max_age_days: i64) -> Result<i64, rusqlite::Error> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days);
        let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
        let deleted = self.conn.execute(
            "DELETE FROM antigravity_usage_events WHERE created_at < ?1",
            [&cutoff_str],
        )?;
        Ok(deleted as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(gen_idx: i64, response_key: &str, input: i64, output: i64) -> AntigravityUsageEvent {
        AntigravityUsageEvent {
            gen_idx,
            response_key: response_key.to_string(),
            model: Some("Gemini 4 Neon (High)".to_string()),
            project_name: Some("cc-use".to_string()),
            conversation_title: Some("Index design".to_string()),
            input_tokens: input,
            output_tokens: output,
            thinking_tokens: Some(3),
            response_tokens: Some(output - 3),
            cache_read_tokens: 7,
            cache_creation_tokens: 0,
            ttft_ms: Some(120),
            generation_ms: Some(880),
            total_ms: Some(1000),
            created_at: "2026-11-27T10:00:00.000+00:00".to_string(),
        }
    }

    fn batch(
        conversation_id: &str,
        fingerprint: AntigravitySyncFingerprint,
        events: Vec<AntigravityUsageEvent>,
    ) -> AntigravityConversationSyncBatch {
        AntigravityConversationSyncBatch {
            source: AntigravitySource::Desktop,
            conversation_id: conversation_id.to_string(),
            file_path: format!("/tmp/{conversation_id}.db"),
            fingerprint,
            events,
        }
    }

    fn fingerprint(db_size: i64, wal_size: i64) -> AntigravitySyncFingerprint {
        AntigravitySyncFingerprint {
            db_size,
            db_mtime_ns: 111,
            wal_size,
            wal_mtime_ns: if wal_size > 0 { 222 } else { 0 },
        }
    }

    #[test]
    fn apply_replaces_one_conversation_without_touching_its_neighbours() {
        let db = Database::new_in_memory().unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![event(1, "r1", 100, 20)],
        ))
        .unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-b",
            fingerprint(20, 0),
            vec![event(1, "r1", 200, 40), event(2, "r2", 300, 60)],
        ))
        .unwrap();

        // Rescanning conv-a with a single replacement row must drop its old row only.
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(11, 0),
            vec![event(1, "r1", 500, 50)],
        ))
        .unwrap();

        let (input_total, rows): (i64, i64) = db
            .conn
            .query_row(
                "SELECT COALESCE(SUM(input_tokens), 0), COUNT(*) FROM antigravity_usage_events
                 WHERE source = 'antigravity_desktop'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 3);
        assert_eq!(input_total, 500 + 200 + 300);

        let state = db.antigravity_sync_state_map().unwrap();
        assert_eq!(state.len(), 2);
        assert_eq!(state["/tmp/conv-a.db"], fingerprint(11, 0));
        assert_eq!(state["/tmp/conv-b.db"], fingerprint(20, 0));
    }

    #[test]
    fn wal_only_commit_is_recorded_as_a_new_fingerprint() {
        let db = Database::new_in_memory().unwrap();
        // Identical .db bytes, new WAL: this is the uncheckpointed-commit case.
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![event(1, "r1", 100, 20)],
        ))
        .unwrap();
        let before = db
            .antigravity_sync_state_map()
            .unwrap()
            .remove("/tmp/conv-a.db")
            .unwrap();

        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 4096),
            vec![event(1, "r1", 100, 20), event(2, "r2", 400, 80)],
        ))
        .unwrap();
        let after = db
            .antigravity_sync_state_map()
            .unwrap()
            .remove("/tmp/conv-a.db")
            .unwrap();

        assert_eq!(before.db_size, after.db_size);
        assert!(before.differs_from(&after));
        assert_eq!(after.wal_size, 4096);
        let rows: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM antigravity_usage_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn same_response_key_replaces_instead_of_duplicating() {
        let db = Database::new_in_memory().unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![event(3, "r1", 100, 20)],
        ))
        .unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(11, 0),
            vec![event(9, "r1", 999, 20)],
        ))
        .unwrap();
        let (rows, gen_idx): (i64, i64) = db
            .conn
            .query_row(
                "SELECT COUNT(*), MAX(gen_idx) FROM antigravity_usage_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(gen_idx, 9);
    }

    #[test]
    fn pruned_files_stop_being_rescanned_but_keep_their_history() {
        let db = Database::new_in_memory().unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![event(1, "r1", 100, 20)],
        ))
        .unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-b",
            fingerprint(10, 0),
            vec![event(1, "r1", 100, 20)],
        ))
        .unwrap();

        let removed = db
            .antigravity_sync_prune_missing(&["/tmp/conv-a.db".to_string()])
            .unwrap();
        assert_eq!(removed, 1);
        assert_eq!(db.antigravity_sync_state_map().unwrap().len(), 1);
        let events: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM antigravity_usage_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(events, 2);
        assert_eq!(db.antigravity_sync_prune_missing(&[]).unwrap(), 0);
    }

    fn days_ago(days: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::days(days))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
    }

    #[test]
    fn a_rescan_cannot_resurrect_expired_events() {
        // Retention only sweeps at startup, so the write path must refuse rows
        // that are already outside the window.
        let db = Database::new_in_memory().unwrap();
        let mut fresh_event = event(1, "r1", 100, 20);
        fresh_event.created_at = days_ago(1);
        let mut stale_event = event(2, "r2", 100, 20);
        stale_event.created_at = days_ago(400);
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![fresh_event, stale_event],
        ))
        .unwrap();

        let remaining: String = db
            .conn
            .query_row(
                "SELECT response_key FROM antigravity_usage_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, "r1");
        // Nothing is left for the startup sweep to find.
        assert_eq!(db.antigravity_usage_cleanup_old(RETENTION_DAYS).unwrap(), 0);
    }

    #[test]
    fn retention_sweep_deletes_only_events_outside_the_window() {
        let db = Database::new_in_memory().unwrap();
        // Written directly: the apply path would already have refused the stale row.
        for (key, created_at) in [("r1", days_ago(1)), ("r2", days_ago(400))] {
            db.conn
                .execute(
                    "INSERT INTO antigravity_usage_events
                        (id, source, conversation_id, gen_idx, response_key, created_at)
                     VALUES (?1, 'antigravity_desktop', 'conv-a', 1, ?2, ?3)",
                    rusqlite::params![format!("ag:desktop:conv-a:{key}"), key, created_at],
                )
                .unwrap();
        }
        assert_eq!(db.antigravity_usage_cleanup_old(RETENTION_DAYS).unwrap(), 1);
        let remaining: String = db
            .conn
            .query_row(
                "SELECT response_key FROM antigravity_usage_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, "r1");
    }

    #[test]
    fn sources_never_share_an_event_row() {
        let db = Database::new_in_memory().unwrap();
        db.antigravity_sync_apply_conversation(&batch(
            "conv-a",
            fingerprint(10, 0),
            vec![event(1, "r1", 100, 20)],
        ))
        .unwrap();
        let mut cli_batch = batch("conv-a", fingerprint(10, 0), vec![event(1, "r1", 7, 3)]);
        cli_batch.source = AntigravitySource::Cli;
        cli_batch.file_path = "/tmp/cli/conv-a.db".to_string();
        db.antigravity_sync_apply_conversation(&cli_batch).unwrap();

        let rows: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM antigravity_usage_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 2);
        assert_eq!(
            AntigravitySource::Cli.ledger_source(),
            RequestLogSource::AntigravityCli
        );
        assert_ne!(
            AntigravitySource::Desktop.as_str(),
            AntigravitySource::Cli.as_str()
        );
    }

    #[test]
    fn fingerprint_of_a_missing_database_is_all_zero() {
        let fingerprint = AntigravitySyncFingerprint::read(Path::new("/nonexistent/conv.db"));
        assert_eq!(fingerprint, AntigravitySyncFingerprint::default());
    }
}
