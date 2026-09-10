use crate::db::Database;
use crate::models::AutoModeAudit;

const AUDIT_COLUMNS: &str = "request_id, created_at, updated_at, session_ref, session_source,
        client_kind, tool_name, tool_use_id, action_summary, action_truncated,
        request_model, forwarded_model, thinking, classifier_stage,
        verdict, verdict_reason, parse_ok, stop_reason,
        request_state, status_code, error_message, client_outcome, completed_at";

fn row_to_audit(row: &rusqlite::Row) -> Result<AutoModeAudit, rusqlite::Error> {
    Ok(AutoModeAudit {
        request_id: row.get(0)?,
        created_at: row.get(1)?,
        updated_at: row.get(2)?,
        session_ref: row.get(3)?,
        session_source: row.get(4)?,
        client_kind: row.get(5)?,
        tool_name: row.get(6)?,
        tool_use_id: row.get(7)?,
        action_summary: row.get(8)?,
        action_truncated: row.get::<_, i64>(9)? != 0,
        request_model: row.get(10)?,
        forwarded_model: row.get(11)?,
        thinking: row.get(12)?,
        classifier_stage: row.get(13)?,
        verdict: row.get(14)?,
        verdict_reason: row.get(15)?,
        parse_ok: row.get::<_, i64>(16)? != 0,
        stop_reason: row.get(17)?,
        request_state: row.get(18)?,
        status_code: row.get(19)?,
        error_message: row.get(20)?,
        client_outcome: row.get(21)?,
        completed_at: row.get(22)?,
    })
}

/// Retained for as long as the request log it belongs to, so a console entry
/// and its audit never disagree about whether something still exists.
pub const AUDIT_RETENTION_DAYS: i64 = 90;

impl Database {
    /// Insert or replace one audit by request id.
    ///
    /// Keyed on the proxy request id, so a request that is re-recorded (a
    /// retry, or the completion of a pending row) updates the same record
    /// instead of producing a second one.
    pub fn auto_mode_audit_upsert(&self, audit: &AutoModeAudit) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO auto_mode_audits (
                request_id, created_at, updated_at, session_ref, session_source,
                client_kind, tool_name, tool_use_id, action_summary, action_truncated,
                request_model, forwarded_model, thinking, classifier_stage,
                verdict, verdict_reason, parse_ok, stop_reason,
                request_state, status_code, error_message, client_outcome, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                       ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            rusqlite::params![
                audit.request_id,
                audit.created_at,
                audit.updated_at,
                audit.session_ref,
                audit.session_source,
                audit.client_kind,
                audit.tool_name,
                audit.tool_use_id,
                audit.action_summary,
                if audit.action_truncated { 1i64 } else { 0i64 },
                audit.request_model,
                audit.forwarded_model,
                audit.thinking,
                audit.classifier_stage,
                audit.verdict,
                audit.verdict_reason,
                if audit.parse_ok { 1i64 } else { 0i64 },
                audit.stop_reason,
                audit.request_state,
                audit.status_code,
                audit.error_message,
                audit.client_outcome,
                audit.completed_at,
            ],
        )?;
        Ok(())
    }

    pub fn auto_mode_audit_get(
        &self,
        request_id: &str,
    ) -> Result<Option<AutoModeAudit>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM auto_mode_audits WHERE request_id = ?1",
            AUDIT_COLUMNS
        ))?;
        let mut rows = stmt.query_map([request_id], row_to_audit)?;
        match rows.next() {
            Some(Ok(audit)) => Ok(Some(audit)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }

    /// Newest first. `tool` and `verdict` filter on the fields a user actually
    /// investigates by, and match exactly rather than by substring.
    pub fn auto_mode_audit_list(
        &self,
        time_range: &str,
        tool: Option<&str>,
        verdict: Option<&str>,
        limit: i64,
    ) -> Result<Vec<AutoModeAudit>, rusqlite::Error> {
        let mut clauses = Vec::new();
        let where_clause = self.time_range_where("created_at", time_range);
        if !where_clause.is_empty() {
            clauses.push(where_clause.trim_start_matches("WHERE ").to_string());
        }
        if tool.is_some() {
            clauses.push("tool_name = ?1".to_string());
        }
        if verdict.is_some() {
            clauses.push(format!("verdict = ?{}", if tool.is_some() { 2 } else { 1 }));
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };

        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM auto_mode_audits {} ORDER BY created_at DESC LIMIT {}",
            AUDIT_COLUMNS,
            filter,
            limit.clamp(1, 1_000)
        ))?;

        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(tool) = tool.as_ref() {
            params.push(tool);
        }
        if let Some(verdict) = verdict.as_ref() {
            params.push(verdict);
        }

        let rows = stmt.query_map(params.as_slice(), row_to_audit)?;
        rows.collect()
    }

    /// Distinct tool names seen in range, so the UI can offer real filters
    /// rather than a guessed list.
    pub fn auto_mode_audit_tool_names(
        &self,
        time_range: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let where_clause = self.time_range_where("created_at", time_range);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT DISTINCT tool_name FROM auto_mode_audits {}
             WHERE tool_name IS NOT NULL AND tool_name != ''
             ORDER BY tool_name",
            // The range clause already starts with WHERE, or is empty.
            where_clause.replace("WHERE", "AND")
        ))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// Fill in what the classifier answered.
    ///
    /// A targeted update rather than a row replace: the request-state update
    /// runs on every exit path and must not undo the verdict written earlier.
    pub fn auto_mode_audit_set_verdict(
        &self,
        request_id: &str,
        stage: Option<&str>,
        forwarded_model: Option<&str>,
        verdict: Option<&str>,
        reason: Option<&str>,
        parse_ok: bool,
        stop_reason: Option<&str>,
        updated_at: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE auto_mode_audits
             SET verdict = ?2, verdict_reason = ?3, parse_ok = ?4, stop_reason = ?5,
                 classifier_stage = COALESCE(?6, classifier_stage),
                 forwarded_model = COALESCE(?7, forwarded_model),
                 updated_at = ?8
             WHERE request_id = ?1",
            rusqlite::params![
                request_id,
                verdict,
                reason,
                if parse_ok { 1i64 } else { 0i64 },
                stop_reason,
                stage,
                forwarded_model,
                updated_at,
            ],
        )?;
        Ok(())
    }

    /// Record how far the request got. Separate from the verdict: a request can
    /// complete with no parseable answer, or fail before one arrives.
    pub fn auto_mode_audit_set_state(
        &self,
        request_id: &str,
        state: &str,
        status_code: Option<i32>,
        error_message: Option<&str>,
        updated_at: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE auto_mode_audits
             SET request_state = ?2, status_code = ?3, error_message = ?4,
                 updated_at = ?5,
                 completed_at = CASE WHEN ?2 = 'pending' THEN NULL ELSE ?5 END
             WHERE request_id = ?1",
            rusqlite::params![request_id, state, status_code, error_message, updated_at],
        )?;
        Ok(())
    }

    /// Mark records still `pending` from a previous process as interrupted.
    ///
    /// A request cannot still be in flight across a restart, and leaving it
    /// pending would read as "we never found out" forever. It is explicitly
    /// *not* turned into an allow.
    pub fn auto_mode_audit_mark_interrupted(&self, now: &str) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "UPDATE auto_mode_audits
             SET request_state = 'interrupted', updated_at = ?1, completed_at = ?1
             WHERE request_state = 'pending'",
            [now],
        )
    }

    /// Same retention window as the request log these records annotate.
    pub fn auto_mode_audit_cleanup_old(&self, cutoff: &str) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM auto_mode_audits WHERE created_at < ?1",
            [cutoff],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit(request_id: &str, created_at: &str) -> AutoModeAudit {
        AutoModeAudit {
            request_id: request_id.to_string(),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            session_ref: Some("cc-use-abc".to_string()),
            session_source: Some("cc_use_session".to_string()),
            client_kind: Some("claude_code".to_string()),
            tool_name: Some("Bash".to_string()),
            tool_use_id: Some("tool-1".to_string()),
            action_summary: Some("Bash · git status".to_string()),
            action_truncated: false,
            request_model: Some("claude-3-5-sonnet".to_string()),
            forwarded_model: Some("deepseek-v4-flash".to_string()),
            thinking: Some("low".to_string()),
            classifier_stage: None,
            verdict: Some("no_block".to_string()),
            verdict_reason: None,
            parse_ok: true,
            stop_reason: Some("stop_sequence".to_string()),
            request_state: "completed".to_string(),
            status_code: Some(200),
            error_message: None,
            client_outcome: None,
            completed_at: Some(created_at.to_string()),
        }
    }

    #[test]
    fn an_audit_round_trips_under_its_request_id() {
        let db = Database::new_in_memory().unwrap();
        db.auto_mode_audit_upsert(&audit("req-1", "2026-09-11T00:00:00Z"))
            .unwrap();

        let stored = db.auto_mode_audit_get("req-1").unwrap().expect("stored");
        assert_eq!(stored.tool_name.as_deref(), Some("Bash"));
        assert_eq!(stored.verdict.as_deref(), Some("no_block"));
        assert!(stored.parse_ok);
        assert_eq!(stored.request_state, "completed");
        // The client's own execution is never inferred from the proxy's view.
        assert!(stored.client_outcome.is_none());
    }

    #[test]
    fn recording_the_same_request_twice_updates_one_row() {
        let db = Database::new_in_memory().unwrap();
        db.auto_mode_audit_upsert(&audit("req-1", "2026-09-11T00:00:00Z"))
            .unwrap();
        let mut finished = audit("req-1", "2026-09-11T00:00:00Z");
        finished.verdict = Some("block".to_string());
        db.auto_mode_audit_upsert(&finished).unwrap();

        assert_eq!(
            db.auto_mode_audit_list("all", None, None, 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.auto_mode_audit_get("req-1")
                .unwrap()
                .unwrap()
                .verdict
                .as_deref(),
            Some("block")
        );
    }

    #[test]
    fn filters_are_exact_and_do_not_match_by_substring() {
        let db = Database::new_in_memory().unwrap();
        db.auto_mode_audit_upsert(&audit("req-1", "2026-09-11T00:00:00Z"))
            .unwrap();
        let mut other = audit("req-2", "2026-09-11T00:00:01Z");
        other.tool_name = Some("BashOutput".to_string());
        other.verdict = Some("unknown".to_string());
        other.parse_ok = false;
        db.auto_mode_audit_upsert(&other).unwrap();

        assert_eq!(
            db.auto_mode_audit_list("all", Some("Bash"), None, 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.auto_mode_audit_list("all", None, Some("unknown"), 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.auto_mode_audit_tool_names("all").unwrap(),
            vec!["Bash".to_string(), "BashOutput".to_string()]
        );
    }

    #[test]
    fn the_verdict_and_the_request_state_are_recorded_independently() {
        let db = Database::new_in_memory().unwrap();
        let mut pending = audit("req-1", "2026-09-11T00:00:00Z");
        pending.request_state = "pending".to_string();
        pending.verdict = None;
        pending.parse_ok = false;
        pending.completed_at = None;
        db.auto_mode_audit_upsert(&pending).unwrap();

        // The verdict lands first, then the terminal state.
        db.auto_mode_audit_set_verdict(
            "req-1",
            None,
            Some("deepseek-v4-flash"),
            Some("no_block"),
            Some("read-only inspection"),
            true,
            Some("stop_sequence"),
            "2026-09-11T00:00:01Z",
        )
        .unwrap();
        db.auto_mode_audit_set_state(
            "req-1",
            "completed",
            Some(200),
            None,
            "2026-09-11T00:00:02Z",
        )
        .unwrap();

        let stored = db.auto_mode_audit_get("req-1").unwrap().unwrap();
        // The state update must not have wiped the verdict.
        assert_eq!(stored.verdict.as_deref(), Some("no_block"));
        assert!(stored.parse_ok);
        assert_eq!(stored.forwarded_model.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(stored.request_state, "completed");
        assert!(stored.completed_at.is_some());
    }

    #[test]
    fn a_pending_record_from_a_previous_process_becomes_interrupted_not_allowed() {
        let db = Database::new_in_memory().unwrap();
        let mut pending = audit("req-1", "2026-09-11T00:00:00Z");
        pending.request_state = "pending".to_string();
        pending.verdict = None;
        pending.parse_ok = false;
        db.auto_mode_audit_upsert(&pending).unwrap();

        assert_eq!(
            db.auto_mode_audit_mark_interrupted("2026-09-11T01:00:00Z")
                .unwrap(),
            1
        );

        let stored = db.auto_mode_audit_get("req-1").unwrap().unwrap();
        assert_eq!(stored.request_state, "interrupted");
        assert!(stored.verdict.is_none());
        assert!(!stored.parse_ok);
    }

    #[test]
    fn a_time_range_filter_actually_narrows_the_result() {
        let db = Database::new_in_memory().unwrap();
        db.auto_mode_audit_upsert(&audit("old", "2020-01-01T00:00:00Z"))
            .unwrap();
        db.auto_mode_audit_upsert(&audit("new", "2026-09-11T00:00:00Z"))
            .unwrap();

        // A real range must exclude the old record, not silently ignore it.
        let recent = db.auto_mode_audit_list("week", None, None, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].request_id, "new");
        assert_eq!(
            db.auto_mode_audit_list("all", None, None, 10)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn old_records_are_pruned_on_the_same_schedule_as_the_request_log() {
        let db = Database::new_in_memory().unwrap();
        db.auto_mode_audit_upsert(&audit("old", "2020-01-01T00:00:00Z"))
            .unwrap();
        db.auto_mode_audit_upsert(&audit("new", "2026-09-11T00:00:00Z"))
            .unwrap();

        assert_eq!(
            db.auto_mode_audit_cleanup_old("2026-01-01T00:00:00Z")
                .unwrap(),
            1
        );
        assert_eq!(
            db.auto_mode_audit_list("all", None, None, 10)
                .unwrap()
                .len(),
            1
        );
    }
}
