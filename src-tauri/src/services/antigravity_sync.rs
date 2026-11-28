//! Read-only reader for Antigravity conversation databases.
//!
//! Antigravity Desktop and the Antigravity CLI keep one SQLite database per
//! conversation (`<root>/conversations/<cid>.db`) and write it continuously in
//! WAL mode. This module turns those files into `AntigravityUsageEvent` rows and
//! never writes to them:
//!
//! - they are opened read-only but deliberately *not* with `immutable=1`, so
//!   committed pages still living in `<cid>.db-wal` are read as well;
//! - both tables are read inside one deferred transaction, so `steps` and
//!   `gen_metadata` can never be observed mid-write from each other;
//! - the same response can appear several times (retries rewrite it), so rows
//!   are deduplicated within the conversation before being returned.
//!
//! Conversation titles and project names come from the separate
//! `conversation_summaries.db`, with `annotations/*.pbtxt` as a fallback; both
//! are cosmetic, so every failure there degrades to missing metadata.

use crate::db::antigravity_usage::{
    AntigravityConversationSyncBatch, AntigravitySource, AntigravitySyncFingerprint,
    AntigravityUsageEvent,
};
use crate::services::antigravity_proto::{
    decode_gen_metadata, decode_step_timestamp, GenerationTelemetry,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A live Antigravity writer may hold the database; fail fast instead of
/// stalling the sync worker behind it.
const BUSY_TIMEOUT: Duration = Duration::from_millis(500);

/// `steps.status` for a step that ended in an error. Tool errors use the same
/// value, so it is only meaningful together with the step type.
const FAILED_STATUS: i64 = 7;
/// A model generation step. Exactly one exists per `gen_metadata` row.
const GENERATION_STEP_TYPE: i64 = 15;

const GEN_METADATA_SQL: &str =
    "SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC";
const STEPS_SQL: &str = "SELECT idx, metadata, status, step_type FROM steps";
const SUMMARIES_SQL: &str =
    "SELECT conversation_id, title, workspace_uris FROM conversation_summaries";

/// The title and project of one conversation, when Antigravity recorded them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConversationMetadata {
    pub title: Option<String>,
    pub project_name: Option<String>,
}

/// Titles and project names per conversation id, best effort.
#[derive(Debug, Clone, Default)]
pub struct ConversationMetadataIndex {
    entries: HashMap<String, ConversationMetadata>,
}

impl ConversationMetadataIndex {
    /// Loads `conversation_summaries.db` and fills the gaps from
    /// `annotations/*.pbtxt`. A missing, locked or corrupt database is not an
    /// error: this data only labels the usage rows.
    pub fn load(source: AntigravitySource) -> Self {
        source
            .root_dir()
            .map(|root| Self::load_from_root(&root))
            .unwrap_or_default()
    }

    /// `load` for an explicit root, so tests never touch the real home directory.
    fn load_from_root(root: &Path) -> Self {
        let mut entries: HashMap<String, ConversationMetadata> =
            read_summaries(root).into_iter().collect();
        for (conversation_id, metadata) in read_annotations(root) {
            // The summaries database is authoritative; annotations only label
            // conversations it does not know about.
            entries.entry(conversation_id).or_insert(metadata);
        }
        Self { entries }
    }

    pub fn lookup(&self, conversation_id: &str) -> Option<&ConversationMetadata> {
        self.entries.get(conversation_id)
    }
}

/// One conversation database found under a root directory.
#[derive(Debug, Clone)]
pub struct AntigravityConversationFile {
    pub source: AntigravitySource,
    pub conversation_id: String,
    pub db_path: PathBuf,
    pub fingerprint: AntigravitySyncFingerprint,
}

/// Every `<root>/conversations/*.db` of both installations. Roots that do not
/// exist (for example the CLI before its first run) simply contribute nothing.
pub fn scan_conversations() -> Vec<AntigravityConversationFile> {
    AntigravitySource::ALL
        .into_iter()
        .filter_map(|source| source.root_dir().map(|root| (source, root)))
        .flat_map(|(source, root)| scan_root(source, &root))
        .collect()
}

/// `scan_conversations` for one root directory.
fn scan_root(source: AntigravitySource, root: &Path) -> Vec<AntigravityConversationFile> {
    let Ok(entries) = std::fs::read_dir(root.join("conversations")) else {
        return Vec::new();
    };
    let mut files: Vec<AntigravityConversationFile> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let db_path = entry.path();
            if !db_path.is_file() {
                return None;
            }
            let conversation_id = conversation_id(&db_path)?;
            Some(AntigravityConversationFile {
                source,
                conversation_id,
                fingerprint: AntigravitySyncFingerprint::read(&db_path),
                db_path,
            })
        })
        .collect();
    // Directory order is not stable; keep sync passes deterministic.
    files.sort_by(|left, right| left.db_path.cmp(&right.db_path));
    files
}

/// `conv-a.db` → `conv-a`. Sidecars (`.db-wal`, `.db-shm`) and unrelated files
/// are not conversations.
fn conversation_id(db_path: &Path) -> Option<String> {
    let name = db_path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".db")?;
    if stem.is_empty() || stem.contains('.') {
        return None;
    }
    Some(stem.to_string())
}

/// Reads one conversation inside a read-only snapshot and deduplicates it.
pub fn read_conversation_events(
    db_path: &Path,
    source: AntigravitySource,
    metadata: Option<&ConversationMetadata>,
) -> Result<Vec<AntigravityUsageEvent>, String> {
    let connection = open_read_only(db_path).map_err(|error| {
        format!(
            "cannot open the {} conversation database: {error}",
            source.display_name()
        )
    })?;
    // BEGIN DEFERRED: both tables are read from one snapshot.
    let snapshot = connection
        .unchecked_transaction()
        .map_err(|error| format!("cannot start a conversation read transaction: {error}"))?;
    let steps = read_steps(&snapshot)?;
    let fallback_created_at = database_mtime(db_path);

    let mut events: HashMap<String, AntigravityUsageEvent> = HashMap::new();
    {
        let mut statement = snapshot
            .prepare(GEN_METADATA_SQL)
            .map_err(|error| format!("cannot query gen_metadata: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| format!("cannot read gen_metadata: {error}"))?;
        for row in rows {
            let (gen_idx, data) =
                row.map_err(|error| format!("cannot read gen_metadata: {error}"))?;
            let Some(telemetry) = decode_gen_metadata(&data) else {
                continue;
            };
            let failed = resolve_failed(telemetry.last_step_index, &steps);
            let Some(created_at) = resolve_created_at(
                telemetry.last_step_index,
                &steps,
                fallback_created_at.as_deref(),
            ) else {
                continue;
            };
            let event = build_event(gen_idx, telemetry, created_at, metadata, failed);
            // A retried response is written again under a higher index; the
            // highest one is the attempt the user actually received.
            events.insert(event.response_key.clone(), event);
        }
    }
    snapshot
        .commit()
        .map_err(|error| format!("cannot finish a conversation read transaction: {error}"))?;

    let mut events: Vec<AntigravityUsageEvent> = events.into_values().collect();
    events.sort_by_key(|event| event.gen_idx);
    Ok(events)
}

/// Reads a conversation and packages it for one atomic index update.
pub fn build_conversation_batch(
    file: &AntigravityConversationFile,
    metadata: &ConversationMetadataIndex,
) -> Result<AntigravityConversationSyncBatch, String> {
    let events = read_conversation_events(
        &file.db_path,
        file.source,
        metadata.lookup(&file.conversation_id),
    )?;
    Ok(AntigravityConversationSyncBatch {
        source: file.source,
        conversation_id: file.conversation_id.clone(),
        file_path: file.db_path.to_string_lossy().into_owned(),
        fingerprint: file.fingerprint,
        events,
    })
}

/// Read-only connection. `immutable=1` must never be used for these files: it
/// would ignore committed transactions that still live in the `-wal` file.
///
/// Opening a WAL-mode database this way can make SQLite create the `-shm`
/// wal-index next to it. That file only coordinates readers and writers; no
/// conversation data is written.
fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.execute_batch("PRAGMA query_only = ON;")?;
    Ok(connection)
}

/// `steps.metadata.f1` is the step's UTC timestamp; keyed by step index.
/// One `steps` row reduced to what the ledger needs: when it happened and
/// whether it ended in an error.
#[derive(Debug, Clone, PartialEq)]
struct StepRecord {
    created_at: Option<String>,
    status: i64,
    step_type: i64,
}

fn read_steps(connection: &Connection) -> Result<BTreeMap<i64, StepRecord>, String> {
    let mut statement = connection
        .prepare(STEPS_SQL)
        .map_err(|error| format!("cannot query steps: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| format!("cannot read steps: {error}"))?;
    let mut steps = BTreeMap::new();
    for row in rows {
        let (idx, metadata, status, step_type) =
            row.map_err(|error| format!("cannot read steps: {error}"))?;
        steps.insert(
            idx,
            StepRecord {
                created_at: metadata.and_then(|blob| decode_step_timestamp(&blob)),
                status,
                step_type,
            },
        );
    }
    Ok(steps)
}

/// The generation that answered `last_step_index` completes at the following
/// step, so that step carries its timestamp. Databases that miss the exact step
/// fall back to the closest earlier one, then to the first step, then to the
/// file's modification time.
///
/// Only the `last_step_index` anchor is exact: `gen_metadata.idx` and
/// `steps.idx` are separate counters, so without the anchor every generation in
/// a conversation would share the same guessed instant. Present in 701/701 rows
/// of the local sample; if a future Antigravity build stops writing it, the
/// timestamps become conversation-level estimates while totals stay correct.
fn resolve_created_at(
    last_step_index: Option<i64>,
    steps: &BTreeMap<i64, StepRecord>,
    database_mtime: Option<&str>,
) -> Option<String> {
    if let Some(target) = last_step_index.map(|index| index.saturating_add(1)) {
        if let Some(created_at) = steps.get(&target).and_then(|step| step.created_at.clone()) {
            return Some(created_at);
        }
        if let Some(created_at) = steps
            .range(..=target)
            .rev()
            .find_map(|(_, step)| step.created_at.clone())
        {
            return Some(created_at);
        }
    }
    steps
        .values()
        .find_map(|step| step.created_at.clone())
        .or_else(|| database_mtime.map(str::to_string))
}

/// A generation failed when its own completion step reported an error.
///
/// `steps.status = 7` alone is not a failure signal: tool errors (`step_type`
/// 132) use it too, and the ledger must not report those as failed requests.
/// Intra-generation HTTP retries are `step_type = 17` rows with `status = 3`;
/// they never reach this check — they only raise `retry_count`.
fn resolve_failed(last_step_index: Option<i64>, steps: &BTreeMap<i64, StepRecord>) -> bool {
    let Some(target) = last_step_index.map(|index| index.saturating_add(1)) else {
        return false;
    };
    steps
        .get(&target)
        .is_some_and(|step| step.status == FAILED_STATUS && step.step_type == GENERATION_STEP_TYPE)
}

/// Last-resort timestamp: the database file's own modification time.
fn database_mtime(db_path: &Path) -> Option<String> {
    let modified: DateTime<Utc> = std::fs::metadata(db_path).ok()?.modified().ok()?.into();
    Some(modified.to_rfc3339_opts(SecondsFormat::Millis, false))
}

fn build_event(
    gen_idx: i64,
    telemetry: GenerationTelemetry,
    created_at: String,
    metadata: Option<&ConversationMetadata>,
    failed: bool,
) -> AntigravityUsageEvent {
    AntigravityUsageEvent {
        gen_idx,
        response_key: response_key(gen_idx, &telemetry),
        model: telemetry.model,
        project_name: metadata.and_then(|metadata| metadata.project_name.clone()),
        conversation_title: metadata.and_then(|metadata| metadata.title.clone()),
        input_tokens: telemetry.input_tokens,
        output_tokens: telemetry.output_tokens,
        thinking_tokens: telemetry.thinking_tokens,
        response_tokens: telemetry.response_tokens,
        cache_read_tokens: telemetry.cache_read_tokens,
        cache_creation_tokens: telemetry.cache_creation_tokens,
        ttft_ms: telemetry.ttft_ms,
        generation_ms: telemetry.generation_ms,
        total_ms: total_ms(telemetry.ttft_ms, telemetry.generation_ms),
        retry_count: telemetry.retry_count,
        failed,
        created_at,
    }
}

/// Identity of one response inside a conversation. The server's response id is
/// the real key; the bot, the request id and finally the row index are
/// progressively weaker stand-ins for rows that lack it.
fn response_key(gen_idx: i64, telemetry: &GenerationTelemetry) -> String {
    if let Some(response_id) = telemetry.response_id.as_deref() {
        return format!("rid:{response_id}");
    }
    if let Some(bot_id) = telemetry.bot_id.as_deref() {
        return format!("bot:{bot_id}");
    }
    if let Some(request_id) = telemetry.request_id.as_deref() {
        return format!("req:{request_id}");
    }
    format!("idx:{gen_idx}")
}

/// End-to-end generation time: waiting for the first token plus streaming it.
fn total_ms(ttft_ms: Option<i64>, generation_ms: Option<i64>) -> Option<i64> {
    Some(ttft_ms?.saturating_add(generation_ms?))
}

/// Every row of `<root>/conversation_summaries.db`. Failures yield no rows.
fn read_summaries(root: &Path) -> Vec<(String, ConversationMetadata)> {
    let Ok(connection) = open_read_only(&root.join("conversation_summaries.db")) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(SUMMARIES_SQL) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|(conversation_id, title, workspace_uris)| {
            let conversation_id = conversation_id?;
            Some((
                conversation_id,
                ConversationMetadata {
                    title: title.and_then(non_empty),
                    project_name: workspace_uris
                        .as_deref()
                        .and_then(project_name_from_workspace_uris),
                },
            ))
        })
        .collect()
}

/// `annotations/<conversation_id>.pbtxt` titles, for conversations the
/// summaries database does not cover.
fn read_annotations(root: &Path) -> Vec<(String, ConversationMetadata)> {
    let Ok(entries) = std::fs::read_dir(root.join("annotations")) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("pbtxt") {
                return None;
            }
            let conversation_id = path.file_stem()?.to_str()?.to_string();
            let contents = std::fs::read_to_string(&path).ok()?;
            let title = annotation_title(&contents)?;
            Some((
                conversation_id,
                ConversationMetadata {
                    title: Some(title),
                    project_name: None,
                },
            ))
        })
        .collect()
}

/// Extracts `title:"..."` from a protobuf-text annotation file.
///
/// The file has a handful of fields; only the title is needed, so this scans for
/// the field instead of implementing the text format.
fn annotation_title(pbtxt: &str) -> Option<String> {
    let mut cursor = 0;
    while let Some(offset) = pbtxt[cursor..].find("title") {
        let field_start = cursor + offset;
        cursor = field_start + "title".len();
        // `subtitle` must not be mistaken for `title`.
        if field_start > 0 && is_name_byte(pbtxt.as_bytes()[field_start - 1]) {
            continue;
        }
        if let Some(title) = quoted_value_after(pbtxt, cursor) {
            return Some(title);
        }
    }
    None
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Reads the quoted string that follows a `: ` separator, resolving the escapes
/// protobuf text format allows.
fn quoted_value_after(text: &str, from: usize) -> Option<String> {
    let rest = text
        .get(from..)?
        .trim_start()
        .strip_prefix(':')?
        .trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut value = String::new();
    let mut escaped = false;
    for character in rest.chars() {
        if escaped {
            value.push(match character {
                'n' => '\n',
                other => other,
            });
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }
    None
}

/// `workspace_uris` is a JSON array of `file://` URIs; the project is the
/// basename of the first workspace.
fn project_name_from_workspace_uris(workspace_uris: &str) -> Option<String> {
    let uris: Vec<String> = serde_json::from_str(workspace_uris).ok()?;
    let directory = url::Url::parse(uris.first()?).ok()?.to_file_path().ok()?;
    let name = directory.file_name()?.to_str()?;
    non_empty(name.to_string())
}

/// Antigravity stores "no value" as an empty string.
fn non_empty(value: String) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::antigravity_proto::test_bytes::{step_metadata, Generation};
    use rusqlite::params;
    use tempfile::TempDir;

    /// Timestamp of the step that follows `Generation::typical()`'s step index.
    const STEP_SECONDS: u64 = 1_795_334_620;
    const STEP_NANOS: u32 = 845_717_000;
    /// `STEP_SECONDS` rendered the way the index must store it.
    const CREATED_AT: &str = "2026-11-22T08:03:40.845+00:00";

    /// The `steps` rows a `Generation::typical()` points at (last step 1 → step 2).
    fn default_steps() -> Vec<(i64, Vec<u8>)> {
        vec![(2, step_metadata(STEP_SECONDS, STEP_NANOS))]
    }

    /// A root directory holding an empty `conversations/` folder.
    fn conversation_root() -> (TempDir, PathBuf) {
        let root = TempDir::new().unwrap();
        let conversations = root.path().join("conversations");
        std::fs::create_dir_all(&conversations).unwrap();
        (root, conversations)
    }

    /// Writes one conversation database shaped like Antigravity's.
    ///
    /// Keeping the returned connection alive keeps the rows in the `-wal` file;
    /// dropping it checkpoints them into the `.db`, which is the state of a
    /// conversation Antigravity has closed.
    fn write_conversation(
        db_path: &Path,
        generations: &[(i64, Vec<u8>)],
        steps: &[(i64, Vec<u8>)],
    ) -> Connection {
        let steps: Vec<(i64, Vec<u8>, i64, i64)> = steps
            .iter()
            .map(|(idx, metadata)| (*idx, metadata.clone(), 3, 0))
            .collect();
        write_conversation_with_step_states(db_path, generations, &steps)
    }

    /// `write_conversation` with explicit `(status, step_type)` per step.
    fn write_conversation_with_step_states(
        db_path: &Path,
        generations: &[(i64, Vec<u8>)],
        steps: &[(i64, Vec<u8>, i64, i64)],
    ) -> Connection {
        let connection = Connection::open(db_path).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA wal_autocheckpoint = 0;
                 CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0,
                     status integer NOT NULL DEFAULT 0, metadata blob, error_details blob);
                 CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob,
                     size integer NOT NULL DEFAULT 0);",
            )
            .unwrap();
        for (idx, data) in generations {
            connection
                .execute(
                    "INSERT INTO gen_metadata (idx, data) VALUES (?1, ?2)",
                    params![idx, data],
                )
                .unwrap();
        }
        for (idx, metadata, status, step_type) in steps {
            connection
                .execute(
                    "INSERT INTO steps (idx, metadata, status, step_type)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![idx, metadata, status, step_type],
                )
                .unwrap();
        }
        connection
    }

    fn write_default_conversation(db_path: &Path) -> Connection {
        write_conversation(
            db_path,
            &[(0, Generation::typical().encode())],
            &default_steps(),
        )
    }

    fn read_desktop(db_path: &Path) -> Vec<AntigravityUsageEvent> {
        read_conversation_events(db_path, AntigravitySource::Desktop, None).unwrap()
    }

    #[test]
    fn reads_one_generation_with_every_metric() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        write_default_conversation(&db_path);

        let events = read_desktop(&db_path);
        assert_eq!(
            events,
            vec![AntigravityUsageEvent {
                retry_count: 0,
                failed: false,
                gen_idx: 0,
                response_key: "rid:resp-1".to_string(),
                model: Some("Gemini 4 Neon (High)".to_string()),
                project_name: None,
                conversation_title: None,
                input_tokens: 100,
                output_tokens: 40,
                thinking_tokens: Some(30),
                response_tokens: Some(10),
                cache_read_tokens: 5,
                cache_creation_tokens: 0,
                ttft_ms: Some(1_500),
                generation_ms: Some(2_250),
                total_ms: Some(3_750),
                created_at: CREATED_AT.to_string(),
            }]
        );
    }

    #[test]
    fn committed_rows_are_read_from_an_uncheckpointed_wal() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        // A live writer keeps the committed rows in `conv-a.db-wal`; a closed
        // one would checkpoint them into `conv-a.db` on drop.
        let _writer = write_default_conversation(&db_path);

        let fingerprint = AntigravitySyncFingerprint::read(&db_path);
        assert!(fingerprint.wal_size > 0, "rows must only exist in the WAL");
        assert_eq!(read_desktop(&db_path).len(), 1);
    }

    #[test]
    fn the_highest_generation_index_wins_for_a_repeated_response() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let first = Generation {
            tokens: [10, 4, 0, 0, 3, 1],
            ..Generation::typical()
        };
        let retried = Generation {
            tokens: [20, 8, 0, 0, 6, 2],
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, first.encode()), (4, retried.encode())],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gen_idx, 4);
        assert_eq!(events[0].input_tokens, 20);
    }

    #[test]
    fn a_bot_id_deduplicates_when_the_response_id_is_missing() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let duplicate = || Generation {
            response_id: None,
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, duplicate().encode()), (3, duplicate().encode())],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gen_idx, 3);
        assert_eq!(events[0].response_key, "bot:bot-1");
    }

    #[test]
    fn a_request_id_deduplicates_when_both_ids_are_missing() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let duplicate = || Generation {
            response_id: None,
            bot_id: None,
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, duplicate().encode()), (2, duplicate().encode())],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gen_idx, 2);
        assert_eq!(events[0].response_key, "req:req-1");
    }

    #[test]
    fn rows_without_any_identity_stay_separate() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let anonymous = || Generation {
            response_id: None,
            bot_id: None,
            request_id: None,
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, anonymous().encode()), (7, anonymous().encode())],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        let keys: Vec<&str> = events
            .iter()
            .map(|event| event.response_key.as_str())
            .collect();
        assert_eq!(keys, ["idx:0", "idx:7"]);
    }

    #[test]
    fn events_come_back_in_generation_order() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let later = Generation {
            response_id: Some("resp-later"),
            ..Generation::typical()
        };
        let earlier = Generation {
            response_id: Some("resp-earlier"),
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(9, later.encode()), (2, earlier.encode())],
            &default_steps(),
        );

        let gen_indexes: Vec<i64> = read_desktop(&db_path)
            .iter()
            .map(|event| event.gen_idx)
            .collect();
        assert_eq!(gen_indexes, [2, 9]);
    }

    #[test]
    fn created_at_falls_back_to_the_closest_earlier_step() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let generation = Generation {
            last_step_index: Some(9),
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, generation.encode())],
            &[
                (0, step_metadata(1_700_000_000, 0)),
                (4, step_metadata(1_700_000_100, 0)),
            ],
        );

        assert_eq!(
            read_desktop(&db_path)[0].created_at,
            "2023-11-14T22:15:00.000+00:00"
        );
    }

    #[test]
    fn created_at_falls_back_to_the_database_mtime() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let generation = Generation {
            last_step_index: None,
            ..Generation::typical()
        };
        write_conversation(&db_path, &[(0, generation.encode())], &[]);

        let created_at = read_desktop(&db_path)[0].created_at.clone();
        assert_eq!(created_at.len(), 29, "fixed-width timestamp: {created_at}");
        assert!(created_at.ends_with("+00:00"), "{created_at}");
        assert!(
            DateTime::parse_from_rfc3339(&created_at).is_ok(),
            "{created_at}"
        );
    }

    #[test]
    fn rows_without_usable_telemetry_are_skipped() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        write_conversation(
            &db_path,
            &[
                (0, Vec::new()),
                (1, b"not a protobuf blob".to_vec()),
                (2, Generation::typical().encode()),
            ],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gen_idx, 2);
    }

    #[test]
    fn a_conversation_without_generations_has_no_events() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        write_conversation(&db_path, &[], &default_steps());

        assert!(read_desktop(&db_path).is_empty());
    }

    #[test]
    fn total_ms_requires_both_durations() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let complete = Generation {
            response_id: Some("resp-complete"),
            ..Generation::typical()
        };
        let interrupted = Generation {
            response_id: Some("resp-interrupted"),
            ttft_ms: Some(1_200),
            generation_ms: None,
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, complete.encode()), (1, interrupted.encode())],
            &default_steps(),
        );

        let events = read_desktop(&db_path);
        assert_eq!(events[0].total_ms, Some(3_750));
        assert_eq!(events[1].ttft_ms, Some(1_200));
        assert_eq!(events[1].generation_ms, None);
        assert_eq!(events[1].total_ms, None);
    }

    #[test]
    fn conversation_metadata_is_attached_to_every_event() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let first = Generation {
            response_id: Some("resp-a"),
            ..Generation::typical()
        };
        let second = Generation {
            response_id: Some("resp-b"),
            ..Generation::typical()
        };
        write_conversation(
            &db_path,
            &[(0, first.encode()), (1, second.encode())],
            &default_steps(),
        );
        let metadata = ConversationMetadata {
            title: Some("Index design".to_string()),
            project_name: Some("cc-use".to_string()),
        };

        let events =
            read_conversation_events(&db_path, AntigravitySource::Desktop, Some(&metadata))
                .unwrap();
        assert_eq!(events.len(), 2);
        for event in &events {
            assert_eq!(event.conversation_title.as_deref(), Some("Index design"));
            assert_eq!(event.project_name.as_deref(), Some("cc-use"));
        }
    }

    #[test]
    fn a_missing_database_is_reported() {
        let root = TempDir::new().unwrap();
        let missing = root.path().join("missing.db");

        let error = read_conversation_events(&missing, AntigravitySource::Cli, None).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn an_unreadable_database_is_an_error_not_a_panic() {
        let root = TempDir::new().unwrap();
        let broken = root.path().join("broken.db");
        std::fs::write(&broken, b"this is not a sqlite database").unwrap();

        let error =
            read_conversation_events(&broken, AntigravitySource::Desktop, None).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn scanning_a_root_only_reports_conversation_databases() {
        let (root, conversations) = conversation_root();
        for name in ["a.db", "b.db", "b.db-wal", "b.db-shm", "notes.txt"] {
            std::fs::write(conversations.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(conversations.join("directory.db")).unwrap();

        let files = scan_root(AntigravitySource::Cli, root.path());
        let ids: Vec<&str> = files
            .iter()
            .map(|file| file.conversation_id.as_str())
            .collect();
        assert_eq!(ids, ["a", "b"]);
        assert!(files
            .iter()
            .all(|file| file.source == AntigravitySource::Cli));
        assert!(files.iter().all(|file| file.fingerprint.db_size > 0));
    }

    #[test]
    fn a_missing_root_has_no_conversations_and_no_metadata() {
        let root = TempDir::new().unwrap();
        let missing = root.path().join("does-not-exist");

        assert!(scan_root(AntigravitySource::Desktop, &missing).is_empty());
        let index = ConversationMetadataIndex::load_from_root(&missing);
        assert!(index.lookup("conv-a").is_none());
    }

    #[test]
    fn build_conversation_batch_packages_the_file_identity() {
        let (_root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        write_default_conversation(&db_path);
        let file = AntigravityConversationFile {
            source: AntigravitySource::Cli,
            conversation_id: "conv-a".to_string(),
            fingerprint: AntigravitySyncFingerprint::read(&db_path),
            db_path: db_path.clone(),
        };

        let batch = build_conversation_batch(&file, &ConversationMetadataIndex::default()).unwrap();
        assert_eq!(batch.source, AntigravitySource::Cli);
        assert_eq!(batch.conversation_id, "conv-a");
        assert_eq!(batch.file_path, db_path.to_string_lossy());
        assert_eq!(batch.fingerprint, file.fingerprint);
        assert_eq!(batch.events.len(), 1);
    }

    /// Writes a `conversation_summaries.db` in WAL mode and closes it, which
    /// leaves a WAL-mode database without sidecar files — the state Antigravity
    /// itself leaves behind.
    fn write_summaries(root: &Path, rows: &[(&str, &str, &str)]) {
        let connection = Connection::open(root.join("conversation_summaries.db")).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE conversation_summaries (
                     conversation_id text,
                     title text NOT NULL DEFAULT '',
                     workspace_uris text NOT NULL);",
            )
            .unwrap();
        for (conversation_id, title, workspace_uris) in rows {
            connection
                .execute(
                    "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris)
                     VALUES (?1, ?2, ?3)",
                    params![conversation_id, title, workspace_uris],
                )
                .unwrap();
        }
    }

    fn write_annotation(root: &Path, conversation_id: &str, contents: &str) {
        let annotations = root.join("annotations");
        std::fs::create_dir_all(&annotations).unwrap();
        std::fs::write(
            annotations.join(format!("{conversation_id}.pbtxt")),
            contents,
        )
        .unwrap();
    }

    #[test]
    fn summaries_supply_titles_and_projects_and_beat_annotations() {
        let root = TempDir::new().unwrap();
        write_summaries(
            root.path(),
            &[(
                "conv-a",
                "Index design",
                r#"["file:///Users/dev/My%20Project"]"#,
            )],
        );
        write_annotation(root.path(), "conv-a", r#"title:"annotation title""#);
        write_annotation(
            root.path(),
            "conv-b",
            r#"title:"Only annotation" plan_execute:true"#,
        );

        let index = ConversationMetadataIndex::load_from_root(root.path());
        let summary = index.lookup("conv-a").unwrap();
        assert_eq!(summary.title.as_deref(), Some("Index design"));
        assert_eq!(summary.project_name.as_deref(), Some("My Project"));

        let annotation = index.lookup("conv-b").unwrap();
        assert_eq!(annotation.title.as_deref(), Some("Only annotation"));
        assert_eq!(annotation.project_name, None);
        assert!(index.lookup("conv-c").is_none());
    }

    #[test]
    fn a_corrupt_summaries_database_degrades_to_annotations_only() {
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join("conversation_summaries.db"),
            b"this is not a sqlite database",
        )
        .unwrap();
        write_annotation(root.path(), "conv-a", r#"title:"From annotation""#);

        let index = ConversationMetadataIndex::load_from_root(root.path());
        assert_eq!(
            index
                .lookup("conv-a")
                .and_then(|metadata| metadata.title.as_deref()),
            Some("From annotation")
        );
    }

    #[test]
    fn annotations_cover_a_missing_summaries_database() {
        let root = TempDir::new().unwrap();
        write_annotation(root.path(), "conv-a", r#"title:"From annotation""#);

        let index = ConversationMetadataIndex::load_from_root(root.path());
        assert_eq!(
            index
                .lookup("conv-a")
                .and_then(|metadata| metadata.title.as_deref()),
            Some("From annotation")
        );
        assert!(ConversationMetadataIndex::default()
            .lookup("conv-a")
            .is_none());
    }

    #[test]
    fn annotation_titles_ignore_lookalike_fields() {
        assert_eq!(
            annotation_title(r#"subtitle:"Not this" title:"This one""#).as_deref(),
            Some("This one")
        );
        assert_eq!(
            annotation_title(r#"title:"Escaped \"quote\"""#).as_deref(),
            Some(r#"Escaped "quote""#)
        );
        assert_eq!(annotation_title("plan_execute:true"), None);
        assert_eq!(annotation_title(r#"title:"#), None);
    }

    #[test]
    fn project_names_come_from_the_first_workspace_uri() {
        assert_eq!(
            project_name_from_workspace_uris(r#"["file:///Users/dev/My%20Project"]"#).as_deref(),
            Some("My Project")
        );
        assert_eq!(project_name_from_workspace_uris("[]"), None);
        assert_eq!(project_name_from_workspace_uris(""), None);
        assert_eq!(project_name_from_workspace_uris("not json"), None);
    }

    // ── Failure signal ──

    /// The generation's completion step, i.e. the step `last_step_index + 1`
    /// points at. `Generation::typical()` anchors on step 2.
    const ANCHOR_STEP: i64 = 2;

    fn read_with_anchor_state(status: i64, step_type: i64) -> AntigravityUsageEvent {
        let (root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        let _writer = write_conversation_with_step_states(
            &db_path,
            &[(0, Generation::typical().encode())],
            &[(
                ANCHOR_STEP,
                step_metadata(STEP_SECONDS, STEP_NANOS),
                status,
                step_type,
            )],
        );
        drop(_writer);
        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        drop(root);
        events.into_iter().next().unwrap()
    }

    #[test]
    fn an_erroring_completion_step_marks_the_generation_failed() {
        // Real shape: `step_type = 15`, `status = 7`, error text present.
        let event = read_with_anchor_state(7, 15);
        assert!(event.failed);
        // The failed attempt still consumed tokens; the ledger keeps them.
        assert!(event.input_tokens > 0);
    }

    #[test]
    fn a_tool_error_on_the_completion_step_is_not_a_generation_failure() {
        // Tool errors share `status = 7` but belong to `step_type = 132`.
        let event = read_with_anchor_state(7, 132);
        assert!(!event.failed);
    }

    #[test]
    fn a_successful_completion_step_is_not_a_failure() {
        let event = read_with_anchor_state(3, 15);
        assert!(!event.failed);
        assert_eq!(event.retry_count, 0);
    }

    #[test]
    fn intra_generation_retries_raise_the_retry_count_without_failing() {
        // Five failed HTTP attempts (step_type 17) then the generation that
        // succeeded: one logical response, zero failures, retry_count = 5.
        let (root, conversations) = conversation_root();
        let db_path = conversations.join("conv-a.db");
        // Five retry rows at idx 2..7, then the generation step at idx 7.
        let generation = Generation {
            last_step_index: Some(6),
            retry_count: Some(5),
            ..Generation::typical()
        };
        let mut steps: Vec<(i64, Vec<u8>, i64, i64)> = (2..7)
            .map(|idx| (idx, step_metadata(STEP_SECONDS, STEP_NANOS), 3, 17))
            .collect();
        steps.push((7, step_metadata(STEP_SECONDS, STEP_NANOS), 3, 15));
        let writer =
            write_conversation_with_step_states(&db_path, &[(0, generation.encode())], &steps);
        drop(writer);

        let events = read_desktop(&db_path);
        assert_eq!(events.len(), 1);
        assert!(!events[0].failed);
        assert_eq!(events[0].retry_count, 5);
        // Retries never create their own indexed row.
        assert_eq!(events[0].gen_idx, 0);
        drop(root);
    }

    #[test]
    fn only_database_file_names_become_conversation_ids() {
        assert_eq!(
            conversation_id(Path::new("/x/conversations/conv-a.db")),
            Some("conv-a".to_string())
        );
        assert_eq!(
            conversation_id(Path::new("/x/conversations/conv-a.db-wal")),
            None
        );
        assert_eq!(conversation_id(Path::new("/x/conversations/.db")), None);
        assert_eq!(conversation_id(Path::new("/x/conversations/a.b.db")), None);
    }
}
