//! One-time migration of the OpenCode Go / Command Code quota to the key scope.
//!
//! Both services meter per key: one key is one account, so a provider-level
//! "account" query could only ever show one of several keys' numbers. The
//! catalogue no longer ships an account query for either service; their scripts
//! are offered as key schemes instead.
//!
//! This migration finds the providers that used the old account query and
//! marks them `query_scope = 'key'`, clearing the account-query configuration
//! and caches it can no longer run. It deliberately does **not** copy anything
//! into keys: the user enables the per-key scheme on each key explicitly.
//! Provider credentials (`token`, `wallet_balance_user_id`) are untouched, and
//! no key row is written.
//!
//! Evidence, not labels: a provider is matched when either
//! - its `wallet_balance_script` is byte-identical to the shipped OpenCode Go
//!   script or to the shipped Command Code script; or
//! - it carries no account script at all but its stored `wallet_balance_type`
//!   is the retired `opencode-go` / `command-code` kind, or its `preset_id` is
//!   one of those two origins.
//!
//! A script that differs from the shipped text is a saved choice and is left
//! untouched together with its provider: a user-written account query is not
//! silently deleted by a scope migration, and the provider keeps the account
//! scope it was configured in.
//!
//! The marker (`migration.quota-scope.key-level`) is written in the same
//! transaction and makes the migration run exactly once: an account query the
//! user configures on those providers afterwards is a saved choice and is never
//! cleared again.

use super::Database;

/// Settings marker that makes this a one-time migration.
const MARKER: &str = "migration.quota-scope.key-level";

impl Database {
    pub(super) fn upgrade_quota_scope(&self) -> Result<(), rusqlite::Error> {
        if self.settings_get_value(MARKER)?.is_some() {
            return Ok(());
        }

        // The two shipped account scripts the superseded rows hold verbatim.
        // Composed from the catalogue rather than frozen, because this module
        // runs *after* `upgrade_command_code_scripts()`: the copy it left behind
        // is the current template, and that is the one matched here.
        let opencode_script = crate::shared_runtime::account_scripts::script_for(
            crate::shared_runtime::account_scripts::for_legacy_kind("opencode-go")
                .expect("the catalogue names the Go account script"),
        );
        let command_code_script =
            crate::shared_runtime::account_scripts::command_code_script().to_string();

        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE providers SET
                query_scope = 'key',
                wallet_balance_script = NULL,
                query_config = NULL,
                cached_usage = NULL,
                last_usage_checked_at = NULL,
                cached_wallet_balance = NULL,
                cached_wallet_balance_currency = NULL,
                last_balance_checked_at = NULL,
                wallet_balance_type = 'none',
                wallet_balance_url = NULL,
                wallet_balance_path = NULL,
                wallet_balance_headers = NULL,
                usage_type = 'none',
                usage_url = NULL,
                usage_path = NULL,
                usage_headers = NULL
             WHERE wallet_balance_script = ?1
                OR wallet_balance_script = ?2
                OR (COALESCE(TRIM(wallet_balance_script), '') = ''
                    AND (wallet_balance_type IN ('opencode-go', 'command-code')
                         OR preset_id IN ('opencode-go', 'command-code')))",
            rusqlite::params![opencode_script, command_code_script],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, 'true')",
            [MARKER],
        )?;
        transaction.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GO_PRESET: &str = "opencode-go";
    const COMMAND_CODE_PRESET: &str = "command-code";

    const CUSTOM_SCRIPT: &str =
        "({request:{url:'{{baseUrl}}/user/balance'},extractor:()=>({remaining:1})})";

    fn opencode_script() -> String {
        crate::shared_runtime::account_scripts::script_for(
            crate::shared_runtime::account_scripts::for_legacy_kind("opencode-go")
                .expect("go script"),
        )
    }

    fn command_code_script() -> String {
        crate::shared_runtime::account_scripts::command_code_script().to_string()
    }

    /// A database whose quota-scope migration has not run yet (the creation
    /// path already ran it once), ready for fixture rows.
    fn unupgraded() -> Database {
        let db = Database::new_in_memory().unwrap();
        db.conn
            .execute("DELETE FROM settings WHERE key = ?1", [MARKER])
            .unwrap();
        db
    }

    fn insert_provider(db: &Database, id: &str, preset: &str, kind: &str, script: &str) {
        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url, preset_id, wallet_balance_type,
                    wallet_balance_url, wallet_balance_path, wallet_balance_headers,
                    wallet_balance_script, wallet_balance_user_id, token,
                    query_config, cached_wallet_balance, cached_wallet_balance_currency,
                    last_balance_checked_at, usage_type, usage_url, usage_path, usage_headers,
                    cached_usage, last_usage_checked_at)
                 VALUES (?1, ?1, 'https://relay.example.com', ?2, ?3, 'https://relay.example.com/old',
                    'data.balance', '{\"Authorization\":\"Bearer old\"}', ?4, 'acct-user', 'acct-token',
                    '{\"enabled\":true,\"schemeId\":\"custom\"}', 12.5, 'USD', '2026-01-01T00:00:00Z',
                    'custom', 'https://relay.example.com/usage', 'data.total', '{\"X\":\"Y\"}',
                    '{\"remaining\":12.5}', '2026-01-01T00:00:00Z')",
                rusqlite::params![id, preset, kind, script],
            )
            .unwrap();
    }

    fn text(db: &Database, id: &str, column: &str) -> Option<String> {
        db.conn
            .query_row(
                &format!("SELECT {column} FROM providers WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("provider {id}, column {column}: {error}"))
    }

    fn number(db: &Database, id: &str, column: &str) -> Option<f64> {
        db.conn
            .query_row(
                &format!("SELECT {column} FROM providers WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Every cleared account-query column, checked together: a migration that
    /// clears half of them would leave the row half-runnable (the lift would
    /// rebuild a script from the old kind/url on the next boot).
    fn assert_account_query_cleared(db: &Database, id: &str) {
        assert_eq!(text(db, id, "query_scope").as_deref(), Some("key"), "{id}");
        for column in [
            "wallet_balance_script",
            "query_config",
            "cached_usage",
            "last_usage_checked_at",
            "cached_wallet_balance_currency",
            "last_balance_checked_at",
            "wallet_balance_url",
            "wallet_balance_path",
            "wallet_balance_headers",
            "usage_url",
            "usage_path",
            "usage_headers",
        ] {
            assert_eq!(text(db, id, column), None, "{id}.{column} must be NULL");
        }
        assert_eq!(
            number(db, id, "cached_wallet_balance"),
            None,
            "{id}.balance"
        );
        assert_eq!(text(db, id, "wallet_balance_type").as_deref(), Some("none"));
        assert_eq!(text(db, id, "usage_type").as_deref(), Some("none"));
        // Credentials are not query configuration: they stay.
        assert_eq!(
            text(db, id, "wallet_balance_user_id").as_deref(),
            Some("acct-user")
        );
        assert_eq!(text(db, id, "token").as_deref(), Some("acct-token"));
    }

    #[test]
    fn the_shipped_opencode_script_marks_the_provider_key_scoped() {
        let db = unupgraded();
        insert_provider(&db, "go-script", "custom", "custom", &opencode_script());
        insert_provider(&db, "custom", "custom", "custom", CUSTOM_SCRIPT);

        db.upgrade_quota_scope().unwrap();

        assert_account_query_cleared(&db, "go-script");
    }

    #[test]
    fn the_shipped_command_code_script_marks_the_provider_key_scoped() {
        let db = unupgraded();
        insert_provider(&db, "cc-script", "custom", "custom", &command_code_script());

        db.upgrade_quota_scope().unwrap();

        assert_account_query_cleared(&db, "cc-script");
    }

    #[test]
    fn the_retired_query_kind_is_evidence_even_without_a_script() {
        let db = unupgraded();
        insert_provider(&db, "go-kind", "custom", GO_PRESET, "");
        insert_provider(&db, "cc-kind", "custom", COMMAND_CODE_PRESET, "");

        db.upgrade_quota_scope().unwrap();

        assert_account_query_cleared(&db, "go-kind");
        assert_account_query_cleared(&db, "cc-kind");
    }

    #[test]
    fn the_preset_origin_is_evidence_when_no_script_was_ever_written() {
        let db = unupgraded();
        insert_provider(&db, "go-preset", GO_PRESET, "custom", "");
        insert_provider(&db, "cc-preset", COMMAND_CODE_PRESET, "custom", "   ");

        db.upgrade_quota_scope().unwrap();

        assert_account_query_cleared(&db, "go-preset");
        assert_account_query_cleared(&db, "cc-preset");
    }

    /// A hand-written account query is a saved choice, not a shipped template:
    /// the migration must not delete it, even on a provider created from one of
    /// the two origins. The provider keeps the account scope it was configured
    /// in and stays editable.
    #[test]
    fn a_custom_script_is_kept_even_on_one_of_the_two_origins() {
        let db = unupgraded();
        insert_provider(&db, "go-edited", GO_PRESET, "custom", CUSTOM_SCRIPT);
        insert_provider(
            &db,
            "cc-edited",
            COMMAND_CODE_PRESET,
            "custom",
            CUSTOM_SCRIPT,
        );

        db.upgrade_quota_scope().unwrap();

        for id in ["go-edited", "cc-edited"] {
            assert_eq!(text(&db, id, "query_scope").as_deref(), Some("account"));
            assert_eq!(
                text(&db, id, "wallet_balance_script").as_deref(),
                Some(CUSTOM_SCRIPT),
                "{id} keeps its saved script"
            );
            assert_eq!(
                number(&db, id, "cached_wallet_balance"),
                Some(12.5),
                "{id} keeps its cached answer"
            );
        }
    }

    #[test]
    fn a_provider_that_is_neither_service_is_left_alone() {
        let db = unupgraded();
        insert_provider(&db, "deepseek", "deepseek", "deepseek", CUSTOM_SCRIPT);
        insert_provider(&db, "newapi", "newapi", "newapi", "");
        insert_provider(&db, "custom", "custom", "custom", CUSTOM_SCRIPT);

        db.upgrade_quota_scope().unwrap();

        for (id, preset, kind) in [
            ("deepseek", "deepseek", "deepseek"),
            ("newapi", "newapi", "newapi"),
            ("custom", "custom", "custom"),
        ] {
            assert_eq!(
                text(&db, id, "query_scope").as_deref(),
                Some("account"),
                "{id} keeps the account scope"
            );
            assert_eq!(text(&db, id, "preset_id").as_deref(), Some(preset));
            assert_eq!(text(&db, id, "wallet_balance_type").as_deref(), Some(kind));
            assert_eq!(
                number(&db, id, "cached_wallet_balance"),
                Some(12.5),
                "{id} keeps its cached answer"
            );
            if id == "custom" {
                assert_eq!(
                    text(&db, id, "wallet_balance_script").as_deref(),
                    Some(CUSTOM_SCRIPT)
                );
            }
        }
    }

    #[test]
    fn api_keys_are_not_touched() {
        let db = unupgraded();
        insert_provider(&db, "go", GO_PRESET, "custom", &opencode_script());
        db.conn
            .execute(
                "INSERT INTO api_keys (id, provider_id, value, usage_type, usage_script,
                    query_config, cached_usage, last_usage_checked_at)
                 VALUES ('key', 'go', 'sk-live', 'opencode-go', ?1,
                    '{\"enabled\":true,\"schemeId\":\"custom\"}', '{\"remaining\":3}',
                    '2026-01-01T00:00:00Z')",
                [CUSTOM_SCRIPT],
            )
            .unwrap();

        db.upgrade_quota_scope().unwrap();

        let (script, kind, checked_at): (Option<String>, Option<String>, Option<String>) = db
            .conn
            .query_row(
                "SELECT usage_script, usage_type, last_usage_checked_at FROM api_keys WHERE id = 'key'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(script.as_deref(), Some(CUSTOM_SCRIPT));
        assert_eq!(kind.as_deref(), Some("opencode-go"));
        assert_eq!(checked_at.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    /// The upgrade has to be wired into the startup migration sequence, not
    /// only callable directly: this is the path every existing install takes.
    #[test]
    fn opening_the_database_runs_the_migration() {
        let db = unupgraded();
        insert_provider(&db, "go", "custom", "custom", &opencode_script());

        db.run_migrations(None).unwrap();

        assert_account_query_cleared(&db, "go");
        assert_eq!(
            db.settings_get_value(MARKER).unwrap().as_deref(),
            Some("true")
        );
    }

    #[test]
    fn the_marker_makes_it_a_one_time_migration() {
        let db = unupgraded();
        insert_provider(&db, "go", GO_PRESET, "custom", &opencode_script());

        db.upgrade_quota_scope().unwrap();
        assert_eq!(
            db.settings_get_value(MARKER).unwrap().as_deref(),
            Some("true")
        );

        // A provider configured after the migration is a saved choice: even one
        // carrying the retired kind again must not be cleared by a later boot.
        insert_provider(&db, "later", COMMAND_CODE_PRESET, "command-code", "");
        insert_provider(&db, "reconfigured", GO_PRESET, "custom", &opencode_script());

        db.upgrade_quota_scope().unwrap();

        assert_eq!(
            text(&db, "later", "query_scope").as_deref(),
            Some("account")
        );
        assert_eq!(
            text(&db, "reconfigured", "wallet_balance_script").as_deref(),
            Some(opencode_script().as_str())
        );
        assert_eq!(
            text(&db, "reconfigured", "query_scope").as_deref(),
            Some("account")
        );
    }
}
