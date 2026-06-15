//! Budget tracking — daily/monthly spend limits per key/project/provider.
//!
//! Two tables back this feature:
//! - `budgets` — the user-defined limits ("key X, $5/day")
//! - `budget_alerts` — dedup ledger so we don't spam a notification on every
//!   request once a budget is blown; one alert per (budget, period) tuple
//!
//! The check flow is: after each request is recorded, [`check_budgets`] runs
//! against today's/month's accumulated spend and emits an alert (via a Tauri
//! event) for any budget that's newly exceeded.

use crate::db::Database;
use chrono::Datelike;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BudgetScope {
    Key,
    Project,
    Provider,
}

impl BudgetScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            BudgetScope::Key => "key",
            BudgetScope::Project => "project",
            BudgetScope::Provider => "provider",
        }
    }

    pub fn from_str(s: &str) -> Option<BudgetScope> {
        match s {
            "key" => Some(BudgetScope::Key),
            "project" => Some(BudgetScope::Project),
            "provider" => Some(BudgetScope::Provider),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub id: String,
    pub scope: String,
    pub scope_id: String,
    pub scope_label: Option<String>,
    pub period: String, // "daily" | "monthly"
    pub limit_usd: f64,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBudgetInput {
    pub scope: String,
    pub scope_id: String,
    pub scope_label: Option<String>,
    pub period: String,
    pub limit_usd: f64,
    pub enabled: Option<bool>,
}

/// A budget that's currently exceeded, returned by [`Database::check_budgets`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBreach {
    pub budget_id: String,
    pub scope: String,
    pub scope_id: String,
    pub scope_label: Option<String>,
    pub period: String,
    pub limit_usd: f64,
    pub current_usd: f64,
    pub percent: f64,
}

impl Database {
    pub fn budget_list(&self) -> Result<Vec<Budget>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, scope_id, scope_label, period, limit_usd, enabled, created_at
             FROM budgets ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Budget {
                id: row.get(0)?,
                scope: row.get(1)?,
                scope_id: row.get(2)?,
                scope_label: row.get(3)?,
                period: row.get(4)?,
                limit_usd: row.get(5)?,
                enabled: row.get::<_, i32>(6)? != 0,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn budget_create(&self, input: &CreateBudgetInput) -> Result<Budget, rusqlite::Error> {
        let id = nanoid::nanoid!();
        let now = chrono::Utc::now().to_rfc3339();
        let enabled = input.enabled.unwrap_or(true) as i32;
        // UNIQUE(scope, scope_id, period) is enforced by the schema — an
        // attempt to create a duplicate will bubble up as a constraint error
        // and the caller can choose to upsert instead.
        self.conn.execute(
            "INSERT INTO budgets (id, scope, scope_id, scope_label, period, limit_usd, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                input.scope,
                input.scope_id,
                input.scope_label,
                input.period,
                input.limit_usd,
                enabled,
                now,
            ],
        )?;
        self.budget_get(&id)?.ok_or_else(|| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some("budget insert failed".into()),
            )
        })
    }

    pub fn budget_get(&self, id: &str) -> Result<Option<Budget>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, scope_id, scope_label, period, limit_usd, enabled, created_at
             FROM budgets WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(Budget {
                id: row.get(0)?,
                scope: row.get(1)?,
                scope_id: row.get(2)?,
                scope_label: row.get(3)?,
                period: row.get(4)?,
                limit_usd: row.get(5)?,
                enabled: row.get::<_, i32>(6)? != 0,
                created_at: row.get(7)?,
            })
        })?;
        match rows.next() {
            Some(Ok(b)) => Ok(Some(b)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn budget_delete(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute("DELETE FROM budgets WHERE id = ?1", [id])?;
        self.conn
            .execute("DELETE FROM budget_alerts WHERE budget_id = ?1", [id])?;
        Ok(())
    }

    pub fn budget_set_enabled(&self, id: &str, enabled: bool) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE budgets SET enabled = ?1 WHERE id = ?2",
            rusqlite::params![enabled as i32, id],
        )?;
        Ok(())
    }

    /// Compute the period key for the alert dedup ledger.
    /// - daily → "2026-06-15"
    /// - monthly → "2026-06"
    fn period_key(period: &str) -> String {
        let now = chrono::Local::now();
        match period {
            "monthly" => now.format("%Y-%m").to_string(),
            _ => now.format("%Y-%m-%d").to_string(),
        }
    }

    /// Check all enabled budgets against current spend and return the ones that
    /// are *newly* breached (i.e. no alert has been fired for this period yet).
    /// Each breach is recorded in `budget_alerts` so subsequent calls in the
    /// same period won't re-fire.
    ///
    /// Called after every successful request from the proxy handler.
    pub fn check_budgets(
        &self,
        current_key_id: Option<&str>,
        current_project_id: Option<&str>,
        current_provider_id: Option<&str>,
    ) -> Result<Vec<BudgetBreach>, rusqlite::Error> {
        let now = chrono::Local::now();
        let today = now.format("%Y-%m-%d").to_string();
        let month_start = now
            .with_day(1)
            .unwrap_or(now)
            .format("%Y-%m-%d")
            .to_string();

        let mut stmt = self
            .conn
            .prepare("SELECT id, scope, scope_id, scope_label, period, limit_usd FROM budgets WHERE enabled = 1")?;
        let budgets: Vec<(String, String, String, Option<String>, String, f64)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut breaches = Vec::new();
        for (id, scope, scope_id, label, period, limit) in budgets {
            // Only evaluate budgets that match the current request's entities.
            // `*` is a wildcard meaning "any entity of this scope" — a global
            // daily cap that aggregates across all keys/projects/providers.
            let matches = match scope.as_str() {
                "key" => scope_id == "*" || current_key_id == Some(scope_id.as_str()),
                "project" => scope_id == "*" || current_project_id == Some(scope_id.as_str()),
                "provider" => scope_id == "*" || current_provider_id == Some(scope_id.as_str()),
                _ => false,
            };
            if !matches {
                continue;
            }

            // Sum current spend for this scope over the period.
            let (from_clause, entity_col, where_extra): (&str, &str, &str) = match scope.as_str() {
                "key" => ("request_logs", "api_key_id", ""),
                "project" => ("request_logs", "project_id", ""),
                "provider" => ("request_logs", "provider_id", ""),
                _ => continue,
            };
            let date_clause = if period == "monthly" {
                "DATE(created_at) >= ?period"
            } else {
                "DATE(created_at) = ?period"
            };
            let sql = format!(
                "SELECT COALESCE(SUM(total_cost_usd), 0) FROM {from_clause} WHERE {date_clause}"
            );
            // For scoped (non-wildcard) budgets, also filter by the entity id.
            let sql = if scope_id == "*" {
                sql
            } else {
                format!("{sql} AND {entity_col} = ?entity")
            };

            let current_usd: f64 = if scope_id == "*" {
                self.conn
                    .query_row(&sql, rusqlite::named_params! { ":period": if period == "monthly" { &month_start } else { &today } }, |row| row.get(0))?
            } else {
                let entity_id = scope_id.clone();
                self.conn.query_row(
                    &sql,
                    rusqlite::named_params! {
                        ":period": if period == "monthly" { &month_start } else { &today },
                        ":entity": &entity_id,
                    },
                    |row| row.get(0),
                )?
            };

            if limit <= 0.0 || current_usd < limit {
                continue;
            }

            // Dedup: have we already fired for this (budget, period) pair?
            let period_key = Self::period_key(&period);
            let already_fired: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM budget_alerts WHERE budget_id = ?1 AND period_key = ?2",
                rusqlite::params![id, period_key],
                |row| row.get(0),
            )?;
            if already_fired > 0 {
                continue;
            }

            // Record the firing so we don't repeat.
            let fired_at = chrono::Utc::now().to_rfc3339();
            self.conn.execute(
                "INSERT OR IGNORE INTO budget_alerts (budget_id, period_key, fired_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, period_key, fired_at],
            )?;

            breaches.push(BudgetBreach {
                budget_id: id,
                scope,
                scope_id,
                scope_label: label,
                period,
                limit_usd: limit,
                current_usd,
                percent: if limit > 0.0 { (current_usd / limit) * 100.0 } else { 0.0 },
            });
        }

        Ok(breaches)
    }

    /// Purge stale alert dedup rows older than 32 days so the table stays
    /// bounded. Called from the startup cleanup task alongside request log
    /// pruning.
    pub fn budget_cleanup_old(&self) -> Result<(), rusqlite::Error> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(32)).to_rfc3339();
        self.conn.execute(
            "DELETE FROM budget_alerts WHERE fired_at < ?1",
            [cutoff],
        )?;
        Ok(())
    }
}
