use crate::db::Database;
use crate::models::{
    DailyModelUsageItem, DailyTrendItem, PaginatedRecentRequests, RecentRequestLogDisplay,
    RequestLog, RequestLogFilter, RequestLogOutcome, RequestLogPopulation, RequestLogSource,
    ResourceUsageStatistics, ResourceUsageSummary, ResourceUsageTrendItem, UsageDimensionItem,
    UsageOverview, UsageStatistics, UsageStatsSummary,
};

/// input + output + cache_read + cache_creation — the v3.7.0 token definition.
/// Cache tokens are real traffic the user pays for and are often the dominant
/// share under Claude Code; hiding them made totals unexplainable.
const TOKEN_SUM: &str = "input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens";

struct RequestLogWhere {
    clause: String,
    values: Vec<rusqlite::types::Value>,
}

impl RequestLogWhere {
    fn with_condition(&self, condition: &str) -> String {
        format!("{} AND ({})", self.clause, condition)
    }
}

fn invalid_filter(message: &'static str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message,
    )))
}

fn usage_condition(prefix: &str) -> String {
    format!("{prefix}input_tokens > 0 OR {prefix}output_tokens > 0 OR {prefix}cache_read_tokens > 0 OR {prefix}cache_creation_tokens > 0")
}

/// Output rate (tok/s) and first-output latency (ms) for one settled request.
pub type RequestPerformanceReading = (Option<f64>, Option<i64>);

/// Both token and duration sums must use exactly the same measured samples.
fn output_speed_sample_sql(p: &str) -> String {
    format!(
        "{p}is_streaming = 1 AND {p}outcome = 'success'
             AND {p}output_tokens > 0 AND {p}first_token_ms >= 0
             AND {p}last_token_ms > {p}first_token_ms
             AND {p}latency_ms >= {p}last_token_ms"
    )
}

/// A single transport burst has no measurable output span. Old measurements
/// are not reinterpreted using EOF, which includes usage/heartbeat/close delays.
fn output_speed_sql(p: &str) -> String {
    format!(
        "CASE WHEN {} THEN {p}output_tokens * 1000.0 / ({p}last_token_ms - {p}first_token_ms) END",
        output_speed_sample_sql(p)
    )
}

/// Duration-weighted throughput, following DeepSeek Harness's fold: sum of
/// sampled output tokens / sum of the corresponding generation durations.
fn aggregate_output_speed_sql(p: &str) -> String {
    let valid = output_speed_sample_sql(p);
    format!(
        "SUM(CASE WHEN {valid} THEN {p}output_tokens END) * 1000.0 /
         NULLIF(SUM(CASE WHEN {valid} THEN {p}last_token_ms - {p}first_token_ms END), 0)"
    )
}

/// The merged observation ledger: proxy traffic plus the indexed Antigravity
/// generations. The read-side observation queries share this CTE so one
/// `request_log_where` scope filters counts, aggregates, trends and pages alike.
///
/// Antigravity rows keep their own measurements: `latency_ms` is the whole
/// generation duration, `first_token_ms` is `ttft_ms`, and
/// `last_token_ms - first_token_ms` is exactly `generation_ms`, so
/// `output_speed_sql` still reports `output_tokens * 1000 / generation_ms`
/// instead of averaging a proxy end-to-end latency with a model duration.
/// `request_logs` has no thinking/response split; those stay NULL for proxy rows.
/// The two labels are pinned to `RequestLogSource::display_name()`.
const UNIFIED_LEDGER_CTE: &str = "
WITH unified_logs AS (
    SELECT
        id, provider_id, api_key_id, project_id, session_id,
        model, request_model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens,
        latency_ms, first_token_ms, last_token_ms,
        status_code, error_message, is_streaming, created_at,
        key_alias, provider_name, project_name, outcome, request_kind, request_id,
        'proxy' AS source,
        NULL AS thinking_tokens, NULL AS response_tokens, NULL AS generation_ms
    FROM request_logs
    UNION ALL
    SELECT
        id,
        NULL, NULL, NULL, NULL, -- provider_id, api_key_id, project_id, session_id
        model,
        NULL AS request_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_ms AS latency_ms,
        ttft_ms AS first_token_ms,
        CASE WHEN ttft_ms IS NOT NULL AND generation_ms IS NOT NULL
             THEN ttft_ms + generation_ms END AS last_token_ms,
        NULL, NULL, -- status_code, error_message
        CASE WHEN generation_ms > 0 AND output_tokens > 0 THEN 1 ELSE 0 END AS is_streaming,
        created_at,
        conversation_title AS key_alias,
        CASE source
            WHEN 'antigravity_desktop' THEN 'Antigravity Desktop'
            WHEN 'antigravity_cli' THEN 'Antigravity CLI'
        END AS provider_name,
        project_name,
        'success' AS outcome, -- v1 defers Antigravity failure counting
        NULL, NULL, -- request_kind, request_id
        source,
        thinking_tokens, response_tokens, generation_ms
    FROM antigravity_usage_events
)";

impl Database {
    /// Latest settled foreground request for this exact managed route. Do not
    /// fall back to an older fast request when the latest one cannot be timed.
    pub fn request_log_session_performance(
        &self,
        session_id: &str,
        provider_id: &str,
        api_key_id: &str,
    ) -> Result<Option<RequestPerformanceReading>, rusqlite::Error> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                &format!(
                    "SELECT {}, CASE WHEN first_token_ms >= 0 THEN first_token_ms END
                     FROM request_logs
                     WHERE session_id = ?1 AND provider_id = ?2 AND api_key_id = ?3
                       AND (request_kind IS NULL OR request_kind != 'auto_mode')
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    output_speed_sql("")
                ),
                rusqlite::params![session_id, provider_id, api_key_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
    }

    fn trend_granularity(time_range: &str) -> &'static str {
        match time_range {
            "lastYear" | "year" => "week",
            "all" => "month",
            custom if custom.starts_with("custom:") => {
                let parts = custom.split(':').collect::<Vec<_>>();
                let span_days = match parts.as_slice() {
                    ["custom", start, end] => chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
                        .ok()
                        .zip(chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").ok())
                        .map(|(start, end)| (end - start).num_days() + 1),
                    _ => None,
                };
                match span_days {
                    Some(days) if days <= 92 => "day",
                    Some(days) if days <= 730 => "week",
                    _ => "month",
                }
            }
            _ => "day",
        }
    }

    fn trend_bucket_expr(date_expr: &str, granularity: &str) -> String {
        match granularity {
            "week" => format!(
                "DATE({0}, printf('-%d days', (CAST(strftime('%w', {0}) AS INTEGER) + 6) % 7))",
                date_expr
            ),
            "month" => format!("DATE({}, 'start of month')", date_expr),
            _ => date_expr.to_string(),
        }
    }

    /// All observation SQL shares this parameterized scope before aggregation or pagination.
    /// Only internal column prefixes are accepted; no identifier comes from IPC.
    fn request_log_where(
        &self,
        time_range: &str,
        filter: &RequestLogFilter,
        prefix: &str,
    ) -> Result<RequestLogWhere, rusqlite::Error> {
        let date = Self::local_date_expr(&format!("{prefix}created_at"));
        let mut values = Vec::new();
        let mut conditions = vec!["1 = 1".to_string()];
        match time_range {
            "today" | "yesterday" | "week" | "last30Days" | "lastYear" | "month" | "lastMonth"
            | "year" | "all" => {
                let range = self.time_range_where(&format!("{prefix}created_at"), time_range);
                if let Some(condition) = range.strip_prefix("WHERE ") {
                    conditions.push(condition.to_string());
                }
            }
            custom if custom.starts_with("custom:") => {
                let parts: Vec<_> = custom.split(':').collect();
                let valid_date = |value: &str| {
                    value.len() == 10
                        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
                };
                match parts.as_slice() {
                    ["custom", start, end]
                        if valid_date(start) && valid_date(end) && start <= end =>
                    {
                        values.push((*start).to_string().into());
                        values.push((*end).to_string().into());
                        conditions.push(format!("{date} >= ?1 AND {date} <= ?2"));
                    }
                    _ => {
                        return Err(invalid_filter(
                            "Invalid custom date range; use ordered YYYY-MM-DD dates",
                        ))
                    }
                }
            }
            _ => return Err(invalid_filter("Unknown statistics time range")),
        }

        for (id, table, column, message) in [
            (filter.provider_id.as_deref(), "providers", "provider_id", "Provider scope is unavailable; it may have been deleted"),
            (filter.api_key_id.as_deref(), "api_keys", "api_key_id", "API key scope is unavailable; it may have been deleted"),
            (filter.instance_id.as_deref(), "managed_instances", "session_id", "Instance scope is unavailable; its historical association may have been cleaned up"),
        ] {
            let Some(id) = id else { continue };
            let exists: bool = self.conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
                [id], |row| row.get(0),
            )?;
            if id.trim().is_empty() || !exists {
                return Err(invalid_filter(message));
            }
            values.push(id.to_string().into());
            let parameter = values.len();
            conditions.push(if table == "managed_instances" {
                // Resolve the credential internally; it never leaves SQLite or becomes a DTO field.
                format!("{prefix}{column} IN (SELECT session_token FROM managed_instances WHERE id = ?{parameter})")
            } else {
                format!("{prefix}{column} = ?{parameter}")
            });
        }
        if let (Some(provider), Some(key)) = (&filter.provider_id, &filter.api_key_id) {
            let belongs: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM api_keys WHERE id = ?1 AND provider_id = ?2)",
                rusqlite::params![key, provider],
                |row| row.get(0),
            )?;
            if !belongs {
                return Err(invalid_filter(
                    "API key scope does not belong to this provider",
                ));
            }
        }
        if let Some(outcome) = filter.outcome {
            let value = match outcome {
                RequestLogOutcome::Success => Some("success"),
                RequestLogOutcome::ClientError => Some("client_error"),
                RequestLogOutcome::UpstreamError => Some("upstream_error"),
                RequestLogOutcome::TransportError => Some("transport_error"),
                RequestLogOutcome::Failed => None,
            };
            if let Some(value) = value {
                values.push(value.to_string().into());
                conditions.push(format!("{prefix}outcome = ?{}", values.len()));
            } else {
                conditions.push(format!(
                    "{prefix}outcome IS NOT NULL AND {prefix}outcome != 'success'"
                ));
            }
        }
        if filter.population == Some(RequestLogPopulation::WithUsage) {
            conditions.push(format!("({})", usage_condition(prefix)));
        }
        // The ledger row's own discriminator, so the same scope works for the
        // unified ledger (`source`) and never widens to the other source.
        if let Some(source) = filter.source {
            values.push(source.as_str().to_string().into());
            conditions.push(format!("{prefix}source = ?{}", values.len()));
        }
        Ok(RequestLogWhere {
            clause: format!("WHERE {}", conditions.join(" AND ")),
            values,
        })
    }

    pub fn request_log_list_all(&self) -> Result<Vec<RequestLog>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, api_key_id, project_id, session_id,
                    model, request_model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens,
                    latency_ms, first_token_ms, status_code, error_message,
                    is_streaming, created_at,
                    key_alias, provider_name, project_name, outcome, request_kind, request_id, last_token_ms
             FROM request_logs ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            let is_streaming: i32 = row.get(15)?;
            Ok(RequestLog {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                api_key_id: row.get(2)?,
                project_id: row.get(3)?,
                session_id: row.get(4)?,
                model: row.get(5)?,
                request_model: row.get(6)?,
                input_tokens: row.get(7)?,
                output_tokens: row.get(8)?,
                cache_read_tokens: row.get(9)?,
                cache_creation_tokens: row.get(10)?,
                latency_ms: row.get(11)?,
                first_token_ms: row.get(12)?,
                last_token_ms: row.get(23)?,
                status_code: row.get(13)?,
                error_message: row.get(14)?,
                is_streaming: is_streaming != 0,
                created_at: row.get(16)?,
                key_alias: row.get(17)?,
                provider_name: row.get(18)?,
                project_name: row.get(19)?,
                outcome: row.get(20)?,
                request_kind: row.get(21)?,
                request_id: row.get(22)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_create(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, latency_ms, first_token_ms, status_code, error_message,
                is_streaming, created_at, key_alias, provider_name, project_name, outcome, request_kind,
                request_id, last_token_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            rusqlite::params![
                log.id, log.provider_id, log.api_key_id, log.project_id, log.session_id,
                log.model, log.request_model, log.input_tokens, log.output_tokens,
                log.cache_read_tokens, log.cache_creation_tokens,
                log.latency_ms, log.first_token_ms, log.status_code, log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 }, log.created_at,
                log.key_alias, log.provider_name, log.project_name, log.outcome, log.request_kind,
                log.request_id, log.last_token_ms,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_upsert(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, latency_ms, first_token_ms, status_code, error_message,
                is_streaming, created_at, key_alias, provider_name, project_name, outcome, request_kind,
                request_id, last_token_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            rusqlite::params![
                log.id,
                log.provider_id,
                log.api_key_id,
                log.project_id,
                log.session_id,
                log.model,
                log.request_model,
                log.input_tokens,
                log.output_tokens,
                log.cache_read_tokens,
                log.cache_creation_tokens,
                log.latency_ms,
                log.first_token_ms,
                log.status_code,
                log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 },
                log.created_at,
                log.key_alias,
                log.provider_name,
                log.project_name,
                log.outcome,
                log.request_kind,
                log.request_id,
                log.last_token_ms,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_get_daily_trend(
        &self,
        days: i64,
    ) -> Result<Vec<DailyTrendItem>, rusqlite::Error> {
        let created_date = Self::local_date_expr("created_at");
        let day_offset = days.clamp(1, 366) - 1;
        let mut stmt = self.conn.prepare(&format!(
            "{} SELECT {} as d,
                    COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM unified_logs
                 WHERE {} >= DATE('now', 'localtime', '-{} days')
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            UNIFIED_LEDGER_CTE, created_date, TOKEN_SUM, created_date, day_offset
        ))?;

        let rows = stmt.query_map([], Self::map_daily_trend_row)?;
        rows.collect()
    }

    pub fn request_log_get_monthly_trend(
        &self,
        year: i64,
        month: i64,
    ) -> Result<Vec<DailyTrendItem>, rusqlite::Error> {
        let ym = format!("{:04}-{:02}", year, month);
        let created_date = Self::local_date_expr("created_at");
        let mut stmt = self.conn.prepare(&format!(
            "{} SELECT {} as d,
                    COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM unified_logs
                 WHERE strftime('%Y-%m', {}) = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            UNIFIED_LEDGER_CTE, created_date, TOKEN_SUM, created_date
        ))?;

        let rows = stmt.query_map([&ym], Self::map_daily_trend_row)?;
        rows.collect()
    }

    fn map_daily_trend_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DailyTrendItem> {
        Ok(DailyTrendItem {
            date: row.get(0)?,
            tokens: row.get(1)?,
            requests: row.get(2)?,
            input_tokens: row.get(3)?,
            output_tokens: row.get(4)?,
            cache_read_tokens: row.get(5)?,
            cache_creation_tokens: row.get(6)?,
        })
    }

    /// Statistics page payload: composition, dimensions and summary quality signals.
    pub fn request_log_get_statistics(
        &self,
        time_range: &str,
    ) -> Result<UsageStatistics, rusqlite::Error> {
        self.request_log_get_statistics_filtered(time_range, &RequestLogFilter::default())
    }

    pub fn request_log_get_statistics_filtered(
        &self,
        time_range: &str,
        filter: &RequestLogFilter,
    ) -> Result<UsageStatistics, rusqlite::Error> {
        let scope = self.request_log_where(time_range, filter, "")?;
        // Keep the historical billable denominator, even when the ledger population is all.
        let where_clause = scope.with_condition(&usage_condition(""));

        let (
            total_requests,
            total_input_tokens,
            total_output_tokens,
            total_cache_read_tokens,
            total_cache_creation_tokens,
            avg_latency_ms,
            avg_first_token_ms,
            avg_output_tokens_per_second,
        ) = self.conn.query_row(
            &format!(
                "{} SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
                        AVG(latency_ms), AVG(first_token_ms), {}
                 FROM unified_logs {}",
                UNIFIED_LEDGER_CTE,
                aggregate_output_speed_sql(""),
                where_clause
            ),
            rusqlite::params_from_iter(scope.values.iter()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                    row.get::<_, Option<f64>>(6)?,
                    row.get::<_, Option<f64>>(7)?,
                ))
            },
        )?;

        // Proxy end-to-end latency and Antigravity generation duration are
        // different measurements. Only the all-sources view can mix them; an
        // explicit source scope, or a single-source family, stays exact.
        let performance_mixed_sources = if filter.source.is_none() {
            let mixed_sql = format!(
                "{UNIFIED_LEDGER_CTE} SELECT
                     EXISTS(SELECT 1 FROM unified_logs {where_clause} AND source = 'proxy'),
                     EXISTS(SELECT 1 FROM unified_logs {where_clause} AND source != 'proxy')"
            );
            self.conn.query_row(
                &mixed_sql,
                rusqlite::params_from_iter(scope.values.iter()),
                |row| Ok(row.get::<_, bool>(0)? && row.get::<_, bool>(1)?),
            )?
        } else {
            false
        };

        let (avg_latency_ms, avg_first_token_ms, avg_output_tokens_per_second) =
            if performance_mixed_sources {
                (None, None, None)
            } else {
                (
                    avg_latency_ms,
                    avg_first_token_ms,
                    avg_output_tokens_per_second,
                )
            };

        // Failure counts stay strictly on proxy-verified `request_logs` rows: v1
        // never counts unverified Antigravity retry chains, and an Antigravity
        // scope must not borrow failures from outside itself.
        let failed_requests: i64 = if filter.source.is_some_and(RequestLogSource::is_antigravity) {
            0
        } else {
            let failure_filter = RequestLogFilter {
                source: None,
                ..filter.clone()
            };
            let failure_scope = self.request_log_where(time_range, &failure_filter, "")?;
            let failure_where =
                failure_scope.with_condition("outcome IS NOT NULL AND outcome != 'success'");
            self.conn.query_row(
                &format!("SELECT COUNT(*) FROM request_logs {}", failure_where),
                rusqlite::params_from_iter(failure_scope.values.iter()),
                |row| row.get(0),
            )?
        };

        let input_side = total_input_tokens + total_cache_read_tokens + total_cache_creation_tokens;
        let cache_hit_rate = if input_side > 0 {
            total_cache_read_tokens as f64 / input_side as f64
        } else {
            0.0
        };

        let summary = UsageStatsSummary {
            total_requests,
            failed_requests,
            total_input_tokens,
            total_output_tokens,
            total_cache_read_tokens,
            total_cache_creation_tokens,
            total_tokens: total_input_tokens
                + total_output_tokens
                + total_cache_read_tokens
                + total_cache_creation_tokens,
            cache_hit_rate,
            avg_latency_ms,
            avg_first_token_ms,
            avg_output_tokens_per_second,
            performance_mixed_sources,
        };

        let dimension_scope = self.request_log_where(time_range, filter, "r.")?;
        let dimension_where = dimension_scope.with_condition(&usage_condition("r."));

        let mut key_stmt = self.conn.prepare(&format!(
            "{} SELECT COALESCE(r.api_key_id, 'unassigned'),
                    COALESCE(NULLIF(r.key_alias, ''), NULLIF(k.alias, ''), 'Unknown key'),
                    COALESCE(NULLIF(r.provider_name, ''), NULLIF(p.name, ''), ''),
                    COALESCE(SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens), 0),
                    COUNT(*)
             FROM unified_logs r
             LEFT JOIN api_keys k ON r.api_key_id = k.id
             LEFT JOIN providers p ON r.provider_id = p.id
             {}
             GROUP BY 1, 2, 3
             ORDER BY 4 DESC, 5 DESC",
            UNIFIED_LEDGER_CTE, dimension_where
        ))?;
        let key_usage = key_stmt
            .query_map(rusqlite::params_from_iter(scope.values.iter()), |row| {
                Ok(UsageDimensionItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    detail: row.get(2)?,
                    tokens: row.get(3)?,
                    requests: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut project_stmt = self.conn.prepare(&format!(
            "{} SELECT COALESCE(r.project_id, ps.cli_type, 'unassigned'),
                    COALESCE(
                        NULLIF(r.project_name, ''),
                        NULLIF(pr.name, ''),
                        CASE ps.cli_type
                            WHEN 'codex-app' THEN 'Codex Desktop'
                            WHEN 'claude_desktop' THEN 'Claude Desktop'
                            ELSE 'Unassigned'
                        END
                    ),
                    COALESCE(NULLIF(pr.path, ''), ''),
                    COALESCE(SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens), 0),
                    COUNT(*)
             FROM unified_logs r
             LEFT JOIN projects pr ON r.project_id = pr.id
             LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
             {}
             GROUP BY 1, 2, 3
             ORDER BY 4 DESC, 5 DESC",
            UNIFIED_LEDGER_CTE, dimension_where
        ))?;
        let project_usage = project_stmt
            .query_map(rusqlite::params_from_iter(scope.values.iter()), |row| {
                Ok(UsageDimensionItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    detail: row.get(2)?,
                    tokens: row.get(3)?,
                    requests: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let created_date = Self::local_date_expr("created_at");
        let trend_granularity = Self::trend_granularity(time_range);
        let trend_bucket = Self::trend_bucket_expr(&created_date, trend_granularity);
        let mut model_stmt = self.conn.prepare(&format!(
            "{} SELECT {} AS d,
                    COALESCE(NULLIF(TRIM(model), ''), NULLIF(TRIM(request_model), ''), ''),
                    COALESCE(SUM({}), 0)
             FROM unified_logs {}
             GROUP BY d, 2
             ORDER BY d DESC, 3 DESC, 2 ASC",
            UNIFIED_LEDGER_CTE, trend_bucket, TOKEN_SUM, where_clause
        ))?;
        let daily_model_usage = model_stmt
            .query_map(rusqlite::params_from_iter(scope.values.iter()), |row| {
                Ok(DailyModelUsageItem {
                    date: row.get(0)?,
                    model: row.get(1)?,
                    tokens: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(UsageStatistics {
            summary,
            daily_model_usage,
            key_usage,
            project_usage,
            trend_granularity: trend_granularity.to_string(),
        })
    }

    /// Provider/key-level trends used from the route cards. Request-based
    /// quality metrics deliberately include zero-token failures; token and
    /// cache metrics naturally remain zero for those rows.
    pub fn request_log_get_resource_statistics(
        &self,
        time_range: &str,
        provider_id: Option<&str>,
        api_key_id: Option<&str>,
    ) -> Result<ResourceUsageStatistics, rusqlite::Error> {
        let filter = RequestLogFilter {
            provider_id: provider_id.map(str::to_string),
            api_key_id: api_key_id.map(str::to_string),
            ..RequestLogFilter::default()
        };
        let scope = self.request_log_where(time_range, &filter, "")?;
        let scoped_where = &scope.clause;

        let (
            total_tokens,
            total_requests,
            successful_requests,
            failed_requests,
            input_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            avg_latency_ms,
            avg_first_token_ms,
            avg_output_tokens_per_second,
        ) = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM({}), 0), COUNT(*),
                        COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') = 'success' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') != 'success' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(input_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
                        COALESCE(SUM(cache_creation_tokens), 0), AVG(latency_ms), AVG(first_token_ms), {}
                 FROM request_logs {}",
                TOKEN_SUM, aggregate_output_speed_sql(""), scoped_where
            ),
            rusqlite::params_from_iter(scope.values.iter()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<f64>>(7)?,
                    row.get::<_, Option<f64>>(8)?,
                    row.get::<_, Option<f64>>(9)?,
                ))
            },
        )?;

        let success_rate = if total_requests > 0 {
            successful_requests as f64 / total_requests as f64
        } else {
            0.0
        };
        let cacheable_input = input_tokens + cache_read_tokens + cache_creation_tokens;
        let cache_hit_rate = if cacheable_input > 0 {
            cache_read_tokens as f64 / cacheable_input as f64
        } else {
            0.0
        };

        let summary = ResourceUsageSummary {
            total_tokens,
            total_requests,
            successful_requests,
            failed_requests,
            success_rate,
            cache_hit_rate,
            avg_latency_ms,
            avg_first_token_ms,
            avg_output_tokens_per_second,
        };

        let created_date = Self::local_date_expr("created_at");
        let trend_granularity = Self::trend_granularity(time_range);
        let trend_bucket = Self::trend_bucket_expr(&created_date, trend_granularity);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} AS d, COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') != 'success' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
                    AVG(latency_ms), AVG(first_token_ms), {}
             FROM request_logs {} GROUP BY d ORDER BY d ASC",
            trend_bucket, TOKEN_SUM, aggregate_output_speed_sql(""), scoped_where
        ))?;
        let daily_trend = stmt
            .query_map(rusqlite::params_from_iter(scope.values.iter()), |row| {
                let requests = row.get::<_, i64>(2)?;
                let failed_requests = row.get::<_, i64>(3)?;
                let input_tokens = row.get::<_, i64>(4)?;
                let output_tokens = row.get::<_, i64>(5)?;
                let cache_read_tokens = row.get::<_, i64>(6)?;
                let cache_creation_tokens = row.get::<_, i64>(7)?;
                let cacheable_input = input_tokens + cache_read_tokens + cache_creation_tokens;
                Ok(ResourceUsageTrendItem {
                    date: row.get(0)?,
                    tokens: row.get(1)?,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    requests,
                    failed_requests,
                    success_rate: if requests > 0 {
                        (requests - failed_requests) as f64 / requests as f64
                    } else {
                        0.0
                    },
                    cache_hit_rate: if cacheable_input > 0 {
                        cache_read_tokens as f64 / cacheable_input as f64
                    } else {
                        0.0
                    },
                    avg_latency_ms: row.get(8)?,
                    avg_first_token_ms: row.get(9)?,
                    avg_output_tokens_per_second: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(ResourceUsageStatistics {
            summary,
            daily_trend,
            trend_granularity: trend_granularity.to_string(),
        })
    }

    /// Recent request list. Includes failures (they are the rows people come
    /// here to find); successful non-inference calls were never recorded.
    pub fn request_log_get_recent_paginated(
        &self,
        time_range: &str,
        page: i64,
        page_size: i64,
    ) -> Result<PaginatedRecentRequests, rusqlite::Error> {
        self.request_log_get_recent_paginated_filtered(
            time_range,
            page,
            page_size,
            &RequestLogFilter::default(),
        )
    }

    pub fn request_log_get_recent_paginated_filtered(
        &self,
        time_range: &str,
        page: i64,
        page_size: i64,
        filter: &RequestLogFilter,
    ) -> Result<PaginatedRecentRequests, rusqlite::Error> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let offset = (page - 1)
            .checked_mul(page_size)
            .ok_or_else(|| invalid_filter("Request page is out of range"))?;
        let mut scope = self.request_log_where(time_range, filter, "r.")?;
        let where_clause = &scope.clause;

        let total: i64 = self.conn.query_row(
            &format!("{UNIFIED_LEDGER_CTE} SELECT COUNT(*) FROM unified_logs r {where_clause}"),
            rusqlite::params_from_iter(scope.values.iter()),
            |row| row.get(0),
        )?;

        let limit_parameter = scope.values.len() + 1;
        let offset_parameter = limit_parameter + 1;
        scope.values.push(page_size.into());
        scope.values.push(offset.into());
        let mut stmt = self.conn.prepare(&format!(
            "{} SELECT r.id, r.model, COALESCE(r.key_alias, k.alias), COALESCE(r.provider_name, p.name),
                        COALESCE(
                            r.project_name,
                            pr.name,
                            CASE ps.cli_type
                                WHEN 'codex-app' THEN 'Codex Desktop'
                                WHEN 'claude_desktop' THEN 'Claude Desktop'
                                ELSE NULL
                            END
                        ),
                        r.input_tokens, r.output_tokens,
                        r.cache_read_tokens, r.cache_creation_tokens,
                        r.latency_ms, r.status_code, r.outcome, r.error_message, r.created_at, r.request_kind,
                        r.request_id, r.first_token_ms, {},
                        r.source, r.thinking_tokens, r.response_tokens, r.generation_ms
                 FROM unified_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
                 {where_clause} ORDER BY r.created_at DESC, r.id DESC LIMIT ?{limit_parameter} OFFSET ?{offset_parameter}",
            UNIFIED_LEDGER_CTE, output_speed_sql("r.")
        ))?;
        let items: Vec<RecentRequestLogDisplay> = stmt
            .query_map(rusqlite::params_from_iter(scope.values.iter()), |row| {
                Ok(RecentRequestLogDisplay {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    key_alias: row.get(2)?,
                    provider_name: row.get(3)?,
                    project_name: row.get(4)?,
                    input_tokens: row.get(5)?,
                    output_tokens: row.get(6)?,
                    cache_read_tokens: row.get(7)?,
                    cache_creation_tokens: row.get(8)?,
                    latency_ms: row.get(9)?,
                    status_code: row.get(10)?,
                    outcome: row.get(11)?,
                    error_message: row.get(12)?,
                    created_at: row.get(13)?,
                    request_kind: row.get(14)?,
                    request_id: row.get(15)?,
                    first_token_ms: row.get(16)?,
                    output_tokens_per_second: row.get(17)?,
                    source: row.get(18)?,
                    thinking_tokens: row.get(19)?,
                    response_tokens: row.get(20)?,
                    generation_ms: row.get(21)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PaginatedRecentRequests {
            items,
            total,
            page,
            page_size,
        })
    }

    /// Dashboard overview: a compact, trustworthy view of today's activity.
    pub fn request_log_get_overview(&self) -> Result<UsageOverview, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let created_date = Self::local_date_expr("created_at");
        let usage_clause = "input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0";

        // Usage is merged across both ledgers; failures stay proxy-verified below.
        let (today_tokens, today_requests) = self.conn.query_row(
            &format!(
                "{} SELECT COALESCE(SUM({}), 0), COUNT(*)
                 FROM unified_logs
                 WHERE {} = ?1 AND ({})",
                UNIFIED_LEDGER_CTE, TOKEN_SUM, created_date, usage_clause
            ),
            [&today],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;

        let today_failed_requests: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM request_logs
                 WHERE {} = ?1 AND outcome IS NOT NULL AND outcome != 'success'",
                created_date
            ),
            [&today],
            |row| row.get(0),
        )?;

        Ok(UsageOverview {
            today_tokens,
            today_requests,
            today_failed_requests,
        })
    }

    /// Per-key today/total token totals for the Keys page chips.
    pub fn request_log_get_key_token_stats(
        &self,
    ) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let created_date = Self::local_date_expr("created_at");

        let mut stmt = self.conn.prepare(&format!(
            "SELECT api_key_id,
                    COALESCE(SUM(CASE WHEN {} = ?1 THEN {} ELSE 0 END), 0) as today_tokens,
                    COALESCE(SUM({}), 0) as total_tokens
             FROM request_logs
             WHERE api_key_id IS NOT NULL
               AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
             GROUP BY api_key_id",
            created_date, TOKEN_SUM, TOKEN_SUM
        ))?;

        let rows = stmt.query_map([&today], |row| {
            Ok(serde_json::json!({
                "keyId": row.get::<_, String>(0)?,
                "todayTokens": row.get::<_, i64>(1)?,
                "totalTokens": row.get::<_, i64>(2)?,
            }))
        })?;

        rows.collect()
    }

    pub fn request_log_cleanup_old(&self, max_age_days: i64) -> Result<i64, rusqlite::Error> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days);
        let cutoff_str = cutoff.to_rfc3339();
        let deleted = self.conn.execute(
            "DELETE FROM request_logs WHERE created_at < ?1",
            [&cutoff_str],
        )?;
        Ok(deleted as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ProxySession;

    fn mk_billable_log(id: &str, created_at: String) -> RequestLog {
        RequestLog {
            id: id.into(),
            provider_id: None,
            api_key_id: None,
            project_id: None,
            session_id: None,
            model: Some("gpt-5.5".into()),
            request_model: Some("gpt-5.5".into()),
            request_kind: None,
            request_id: Some(format!("req-{id}")),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            latency_ms: Some(100),
            first_token_ms: None,
            last_token_ms: None,
            status_code: Some(200),
            error_message: None,
            outcome: Some("success".into()),
            is_streaming: false,
            created_at,
            key_alias: Some("codex-key".into()),
            provider_name: Some("codex-provider".into()),
            project_name: Some("Codex Desktop".into()),
        }
    }

    fn mk_failed_log(id: &str, created_at: String, status_code: i32, outcome: &str) -> RequestLog {
        let mut log = mk_billable_log(id, created_at);
        log.input_tokens = 0;
        log.output_tokens = 0;
        log.status_code = Some(status_code);
        log.outcome = Some(outcome.into());
        log.error_message = Some("Rate limit exceeded".into());
        log
    }

    fn observation_fixture() -> Database {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute_batch(
            "INSERT INTO providers (id, name, base_url) VALUES ('p1', 'Same name', 'https://fixture.invalid'), ('p2', 'Same name', 'https://fixture.invalid');
             INSERT INTO api_keys (id, provider_id, alias, value) VALUES ('k1', 'p1', 'Same alias', 'fixture'), ('k2', 'p1', 'Same alias', 'fixture'), ('k3', 'p2', 'Same alias', 'fixture');
             INSERT INTO proxy_sessions (session_token, provider_id, api_key_id, created_at, last_seen_at) VALUES ('fixture-secret-1', 'p1', 'k1', '2026-01-01', '2026-01-01'), ('fixture-secret-2', 'p1', 'k2', '2026-01-01', '2026-01-01');
             INSERT INTO managed_instances (id, session_token, cli_type, terminal_type, project_path, last_seen_at, launched_at) VALUES ('i1', 'fixture-secret-1', 'claude_code', 'terminal', '/fixture/same', '2026-01-01', '2026-01-01'), ('i2', 'fixture-secret-2', 'grok', 'terminal', '/fixture/same', '2026-01-01', '2026-01-01');"
        ).unwrap();
        for index in 0..90 {
            let mut log =
                mk_billable_log(&format!("mixed-{index}"), chrono::Utc::now().to_rfc3339());
            let (provider, key, token) = match index % 3 {
                0 => ("p1", "k1", "fixture-secret-1"),
                1 => ("p1", "k2", "fixture-secret-2"),
                _ => ("p2", "k3", "fixture-secret-2"),
            };
            log.provider_id = Some(provider.into());
            log.api_key_id = Some(key.into());
            log.session_id = Some(token.into());
            log.model = Some(key.into());
            if index % 6 == 0 {
                log.input_tokens = 0;
                log.output_tokens = 0;
                log.outcome = Some(
                    if index % 12 == 0 {
                        "legacy_failure"
                    } else {
                        "upstream_error"
                    }
                    .into(),
                );
            }
            db.request_log_create(&log).unwrap();
        }
        db
    }

    #[test]
    fn observation_scopes_match_summary_trends_and_every_page_before_limit() {
        let db = observation_fixture();
        for (filter, expected_total, expected_billable, expected_failures) in [
            (
                RequestLogFilter {
                    provider_id: Some("p1".into()),
                    ..Default::default()
                },
                60,
                45,
                15,
            ),
            (
                RequestLogFilter {
                    api_key_id: Some("k1".into()),
                    ..Default::default()
                },
                30,
                15,
                15,
            ),
            (
                RequestLogFilter {
                    instance_id: Some("i1".into()),
                    ..Default::default()
                },
                30,
                15,
                15,
            ),
            (
                RequestLogFilter {
                    provider_id: Some("p1".into()),
                    api_key_id: Some("k1".into()),
                    instance_id: Some("i1".into()),
                    ..Default::default()
                },
                30,
                15,
                15,
            ),
        ] {
            let stats = db
                .request_log_get_statistics_filtered("all", &filter)
                .unwrap();
            assert_eq!(stats.summary.total_requests, expected_billable);
            assert_eq!(stats.summary.failed_requests, expected_failures);
            assert_eq!(stats.summary.total_tokens, expected_billable * 30);
            assert_eq!(
                stats
                    .daily_model_usage
                    .iter()
                    .map(|item| item.tokens)
                    .sum::<i64>(),
                expected_billable * 30
            );
            assert_eq!(
                stats
                    .key_usage
                    .iter()
                    .map(|item| item.requests)
                    .sum::<i64>(),
                expected_billable
            );
            assert_eq!(
                stats
                    .project_usage
                    .iter()
                    .map(|item| item.tokens)
                    .sum::<i64>(),
                expected_billable * 30
            );
            let mut ids = std::collections::HashSet::new();
            let mut total_tokens = 0;
            for page in 1..=(expected_total + 6) / 7 {
                let result = db
                    .request_log_get_recent_paginated_filtered("all", page, 7, &filter)
                    .unwrap();
                assert_eq!(result.total, expected_total);
                assert!(!serde_json::to_string(&result)
                    .unwrap()
                    .contains("fixture-secret"));
                for item in result.items {
                    assert!(ids.insert(item.id));
                    total_tokens += item.input_tokens + item.output_tokens;
                    assert!(matches!(item.model.as_deref(), Some("k1") | Some("k2")));
                }
            }
            assert_eq!(ids.len() as i64, expected_total);
            assert_eq!(total_tokens, stats.summary.total_tokens);
        }
        let resource = db
            .request_log_get_resource_statistics("all", Some("p1"), Some("k1"))
            .unwrap();
        assert_eq!(resource.summary.total_requests, 30);
        assert_eq!(resource.summary.failed_requests, 15);
        assert_eq!(
            resource
                .daily_trend
                .iter()
                .map(|item| item.requests)
                .sum::<i64>(),
            30
        );
        assert_eq!(
            resource
                .daily_trend
                .iter()
                .map(|item| item.tokens)
                .sum::<i64>(),
            450
        );
    }

    #[test]
    fn observation_population_and_failure_filters_preserve_denominators() {
        let db = observation_fixture();
        let mut filter = RequestLogFilter {
            instance_id: Some("i1".into()),
            population: Some(RequestLogPopulation::WithUsage),
            ..Default::default()
        };
        let page = db
            .request_log_get_recent_paginated_filtered("all", 1, 100, &filter)
            .unwrap();
        assert_eq!(page.total, 15);
        assert!(page
            .items
            .iter()
            .all(|item| item.input_tokens > 0 || item.output_tokens > 0));
        filter.outcome = Some(RequestLogOutcome::Failed);
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 100, &filter)
                .unwrap()
                .total,
            0
        );
        // The UI explicitly switches population when entering the failure drilldown.
        filter.population = Some(RequestLogPopulation::All);
        let failures = db
            .request_log_get_recent_paginated_filtered("all", 1, 100, &filter)
            .unwrap();
        assert_eq!(failures.total, 15);
        assert!(failures.items.iter().all(|item| item
            .outcome
            .as_deref()
            .is_some_and(|outcome| outcome != "success")));
        let stats = db
            .request_log_get_statistics_filtered("all", &filter)
            .unwrap();
        assert_eq!(stats.summary.total_requests, 0);
        assert_eq!(stats.summary.failed_requests, 15);
        filter.outcome = Some(RequestLogOutcome::UpstreamError);
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 100, &filter)
                .unwrap()
                .total,
            7
        );
        assert_eq!(
            db.request_log_get_statistics("all")
                .unwrap()
                .summary
                .total_requests,
            75
        );
        assert_eq!(
            db.request_log_get_recent_paginated("all", 1, 100)
                .unwrap()
                .total,
            90
        );
    }

    #[test]
    fn observation_population_includes_cache_only_but_failed_excludes_null_outcome() {
        let db = Database::new_in_memory().unwrap();
        for (id, cache, outcome) in [
            ("cache", 5, None),
            ("legacy", 0, None),
            ("failed", 0, Some("future_failure")),
        ] {
            let mut log = mk_billable_log(id, chrono::Utc::now().to_rfc3339());
            log.input_tokens = 0;
            log.output_tokens = 0;
            log.cache_read_tokens = cache;
            log.outcome = outcome.map(str::to_string);
            db.request_log_create(&log).unwrap();
        }
        let usage = RequestLogFilter {
            population: Some(RequestLogPopulation::WithUsage),
            ..Default::default()
        };
        let page = db
            .request_log_get_recent_paginated_filtered("today", 1, 10, &usage)
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "cache");
        let failed = RequestLogFilter {
            outcome: Some(RequestLogOutcome::Failed),
            ..Default::default()
        };
        let page = db
            .request_log_get_recent_paginated_filtered("today", 1, 10, &failed)
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "failed");
        let overview = db.request_log_get_overview().unwrap();
        assert_eq!(overview.today_requests, 1);
        assert_eq!(overview.today_failed_requests, 1);
        assert_eq!(overview.today_tokens, 5);
    }

    #[test]
    fn observation_deleted_scopes_error_without_losing_history_or_exposing_input() {
        for (delete, filter) in [
            (
                "DELETE FROM providers WHERE id = 'p1'",
                RequestLogFilter {
                    provider_id: Some("p1".into()),
                    ..Default::default()
                },
            ),
            (
                "DELETE FROM api_keys WHERE id = 'k1'",
                RequestLogFilter {
                    api_key_id: Some("k1".into()),
                    ..Default::default()
                },
            ),
            (
                "DELETE FROM managed_instances WHERE id = 'i1'",
                RequestLogFilter {
                    instance_id: Some("i1".into()),
                    ..Default::default()
                },
            ),
            (
                "DELETE FROM proxy_sessions WHERE session_token = 'fixture-secret-1'",
                RequestLogFilter {
                    instance_id: Some("i1".into()),
                    ..Default::default()
                },
            ),
        ] {
            let db = observation_fixture();
            db.conn.execute(delete, []).unwrap();
            assert!(db
                .request_log_get_statistics_filtered("all", &filter)
                .is_err());
            assert!(db
                .request_log_get_recent_paginated_filtered("all", 1, 10, &filter)
                .is_err());
            assert_eq!(
                db.request_log_get_recent_paginated("all", 1, 10)
                    .unwrap()
                    .total,
                90
            );
        }
        let db = observation_fixture();
        let sensitive = "session-do-not-echo' OR 1=1 --";
        let filter = RequestLogFilter {
            instance_id: Some(sensitive.into()),
            ..Default::default()
        };
        let error = db
            .request_log_get_statistics_filtered("all", &filter)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Instance scope"));
        assert!(!error.contains(sensitive));
        let filter = RequestLogFilter {
            provider_id: Some("p2".into()),
            api_key_id: Some("k1".into()),
            ..Default::default()
        };
        assert!(db
            .request_log_get_statistics_filtered("all", &filter)
            .is_err());
        // A valid saved ID containing SQL metacharacters is still an equality value, not SQL.
        db.conn.execute("INSERT INTO providers (id, name, base_url) VALUES (?1, 'Same name', 'https://fixture.invalid')", [sensitive]).unwrap();
        let filter = RequestLogFilter {
            provider_id: Some(sensitive.into()),
            ..Default::default()
        };
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 10, &filter)
                .unwrap()
                .total,
            0
        );
    }

    #[test]
    fn observation_dates_are_strict_and_local_day_drilldown_matches_overview() {
        use chrono::TimeZone;
        let db = Database::new_in_memory().unwrap();
        let today = chrono::Local::now().date_naive();
        let start = chrono::Local
            .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .unwrap();
        for (id, at) in [
            ("before", start - chrono::Duration::seconds(1)),
            ("start", start),
            ("after", start + chrono::Duration::days(1)),
        ] {
            db.request_log_create(&mk_billable_log(
                id,
                at.with_timezone(&chrono::Utc).to_rfc3339(),
            ))
            .unwrap();
        }
        let range = format!("custom:{today}:{today}");
        let filter = RequestLogFilter {
            population: Some(RequestLogPopulation::WithUsage),
            ..Default::default()
        };
        let result = db
            .request_log_get_recent_paginated_filtered(&range, 1, 10, &filter)
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].id, "start");
        assert_eq!(
            db.request_log_get_overview().unwrap().today_requests,
            result.total
        );
        for range in [
            "typo",
            "custom:2026-02-30:2026-03-01",
            "custom:2026-11-15:2026-11-14",
            "custom:2026-1-01:2026-01-01",
            "custom:2026-01-01:2026-01-01:extra",
        ] {
            assert!(db
                .request_log_get_statistics_filtered(range, &filter)
                .is_err());
            assert!(db
                .request_log_get_recent_paginated_filtered(range, 1, 10, &filter)
                .is_err());
        }
        assert!(db
            .request_log_get_recent_paginated_filtered("all", i64::MAX, 100, &filter)
            .is_err());
    }

    #[test]
    fn request_kind_survives_export_import_and_legacy_migration() {
        let db = Database::new_in_memory().unwrap();
        let legacy = mk_billable_log("legacy", chrono::Utc::now().to_rfc3339());
        db.request_log_create(&legacy).unwrap();
        db.conn
            .execute("ALTER TABLE request_logs DROP COLUMN request_kind", [])
            .unwrap();
        db.run_alter_migrations();
        assert_eq!(db.request_log_list_all().unwrap()[0].request_kind, None);
        let mut old_json = serde_json::to_value(&legacy).unwrap();
        old_json.as_object_mut().unwrap().remove("requestKind");
        assert_eq!(
            serde_json::from_value::<RequestLog>(old_json)
                .unwrap()
                .request_kind,
            None
        );

        let mut classifier = mk_billable_log("classifier", chrono::Utc::now().to_rfc3339());
        classifier.request_kind = Some("auto_mode".into());
        db.request_log_create(&classifier).unwrap();
        let exported = serde_json::to_string(&db.request_log_list_all().unwrap()).unwrap();
        let restored = Database::new_in_memory().unwrap();
        for log in serde_json::from_str::<Vec<RequestLog>>(&exported).unwrap() {
            restored.request_log_upsert(&log).unwrap();
        }
        let rows = restored
            .request_log_get_recent_paginated("all", 1, 10)
            .unwrap()
            .items;
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "classifier")
                .unwrap()
                .request_kind
                .as_deref(),
            Some("auto_mode")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "legacy")
                .unwrap()
                .request_kind,
            None
        );
    }

    #[test]
    fn cleanup_removes_old_logs() {
        let db = Database::new_in_memory().unwrap();

        let old_log = mk_billable_log(
            "old-1",
            (chrono::Utc::now() - chrono::Duration::days(100)).to_rfc3339(),
        );
        db.request_log_create(&old_log).unwrap();

        let recent_log = mk_billable_log("recent-1", chrono::Utc::now().to_rfc3339());
        db.request_log_create(&recent_log).unwrap();

        let deleted = db.request_log_cleanup_old(90).unwrap();
        assert!(deleted >= 1);

        let remaining = db.request_log_list_all().unwrap();
        assert!(remaining.iter().any(|r| r.id == "recent-1"));
        assert!(!remaining.iter().any(|r| r.id == "old-1"));
    }

    #[test]
    fn overview_today_uses_local_day_for_utc_logs() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Local::now();
        db.request_log_create(&mk_billable_log(
            "today",
            now.with_timezone(&chrono::Utc).to_rfc3339(),
        ))
        .unwrap();
        db.request_log_create(&mk_billable_log(
            "yesterday",
            (now - chrono::Duration::days(1))
                .with_timezone(&chrono::Utc)
                .to_rfc3339(),
        ))
        .unwrap();

        let overview = db.request_log_get_overview().unwrap();
        assert_eq!(overview.today_requests, 1);
        assert_eq!(overview.today_tokens, 30);
    }

    #[test]
    fn overview_counts_cache_tokens_in_totals() {
        let db = Database::new_in_memory().unwrap();
        let mut cache_heavy = mk_billable_log("cache-heavy", chrono::Utc::now().to_rfc3339());
        cache_heavy.input_tokens = 100;
        cache_heavy.output_tokens = 50;
        cache_heavy.cache_read_tokens = 10_000;
        cache_heavy.cache_creation_tokens = 500;
        db.request_log_create(&cache_heavy).unwrap();

        let overview = db.request_log_get_overview().unwrap();
        assert_eq!(overview.today_tokens, 10_650);
    }

    #[test]
    fn statistics_summary_reports_composition_and_cache_hit_rate() {
        let db = Database::new_in_memory().unwrap();
        let mut log = mk_billable_log("log-1", chrono::Utc::now().to_rfc3339());
        log.input_tokens = 1_000;
        log.output_tokens = 400;
        log.cache_read_tokens = 3_000;
        log.cache_creation_tokens = 0;
        db.request_log_create(&log).unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_tokens, 4_400);
        assert_eq!(stats.summary.total_input_tokens, 1_000);
        assert_eq!(stats.summary.total_cache_read_tokens, 3_000);
        // 3000 / (1000 + 3000 + 0) = 0.75
        assert!((stats.summary.cache_hit_rate - 0.75).abs() < 1e-9);
    }

    #[test]
    fn statistics_includes_key_and_project_dimensions() {
        let db = Database::new_in_memory().unwrap();
        let mut log = mk_billable_log("dimension-log", chrono::Utc::now().to_rfc3339());
        log.input_tokens = 1_200;
        log.output_tokens = 300;
        db.request_log_create(&log).unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.key_usage.len(), 1);
        assert_eq!(stats.key_usage[0].name, "codex-key");
        assert_eq!(stats.key_usage[0].detail, "codex-provider");
        assert_eq!(stats.key_usage[0].tokens, 1_500);
        assert_eq!(stats.project_usage.len(), 1);
        assert_eq!(stats.project_usage[0].name, "Codex Desktop");
        assert_eq!(stats.project_usage[0].requests, 1);
        assert_eq!(stats.daily_model_usage.len(), 1);
        assert_eq!(stats.daily_model_usage[0].model, "gpt-5.5");
        assert_eq!(stats.daily_model_usage[0].tokens, 1_500);
    }

    #[test]
    fn statistics_supports_custom_date_ranges() {
        let db = Database::new_in_memory().unwrap();
        db.request_log_create(&mk_billable_log("july", "2026-07-15T04:00:00Z".to_string()))
            .unwrap();
        db.request_log_create(&mk_billable_log(
            "august",
            "2026-08-01T04:00:00Z".to_string(),
        ))
        .unwrap();

        let july = db
            .request_log_get_statistics("custom:2026-07-01:2026-07-31")
            .unwrap();
        assert_eq!(july.summary.total_requests, 1);
        // Invalid URL dates are a visible validation error, not an apparently empty ledger.
        assert!(db
            .request_log_get_statistics("custom:not-a-date:2026-07-31")
            .is_err());
    }

    #[test]
    fn statistics_counts_failures_separately_from_billable_requests() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        db.request_log_create(&mk_billable_log("ok-1", now.clone()))
            .unwrap();
        db.request_log_create(&mk_failed_log("fail-1", now.clone(), 429, "client_error"))
            .unwrap();
        db.request_log_create(&mk_failed_log("fail-2", now, 502, "upstream_error"))
            .unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 1, "billable scope");
        assert_eq!(stats.summary.failed_requests, 2, "failure scope");
    }

    #[test]
    fn recent_requests_include_failures_with_error_details() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        db.request_log_create(&mk_billable_log("ok-1", now.clone()))
            .unwrap();
        db.request_log_create(&mk_failed_log("fail-1", now, 429, "client_error"))
            .unwrap();

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(recent.total, 2);
        let failed = recent
            .items
            .iter()
            .find(|item| item.id == "fail-1")
            .expect("failed row visible");
        assert_eq!(failed.outcome.as_deref(), Some("client_error"));
        assert_eq!(failed.error_message.as_deref(), Some("Rate limit exceeded"));
    }

    #[test]
    fn statistics_labels_codex_app_without_project_as_client_source() {
        let db = Database::new_in_memory().unwrap();

        let session = ProxySession {
            session_token: "session-codex".into(),
            provider_id: "provider-1".into(),
            api_key_id: "key-1".into(),
            client_profile_id: None,
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            session_kind: "desktop".into(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            revoked_at: None,
            revoked_reason: None,
            cli_type: Some("codex-app".into()),
            display_name: None,
            is_active: true,
            connection_config: None,
        };
        db.proxy_session_create(&session).unwrap();

        let mut log = mk_billable_log("log-1", chrono::Utc::now().to_rfc3339());
        log.session_id = Some(session.session_token);
        log.project_name = None;
        db.request_log_create(&log).unwrap();

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(
            recent.items[0].project_name.as_deref(),
            Some("Codex Desktop")
        );
    }

    #[test]
    fn statistics_summary_uses_the_selected_time_range() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Local::now();

        db.request_log_create(&mk_billable_log(
            "today",
            now.with_timezone(&chrono::Utc).to_rfc3339(),
        ))
        .unwrap();
        db.request_log_create(&mk_billable_log(
            "older",
            (now - chrono::Duration::days(10))
                .with_timezone(&chrono::Utc)
                .to_rfc3339(),
        ))
        .unwrap();

        let today = db.request_log_get_statistics("today").unwrap();
        let all = db.request_log_get_statistics("all").unwrap();

        assert_eq!(today.summary.total_requests, 1);
        assert_eq!(all.summary.total_requests, 2);
    }

    #[test]
    fn cache_only_traffic_is_billable_and_counted() {
        let db = Database::new_in_memory().unwrap();
        let mut cache_only = mk_billable_log("cache-only", chrono::Utc::now().to_rfc3339());
        cache_only.input_tokens = 0;
        cache_only.output_tokens = 0;
        cache_only.cache_read_tokens = 1_000;
        db.request_log_create(&cache_only).unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 1);

        // v3.7.0: cache traffic is part of the headline token number.
        let overview = db.request_log_get_overview().unwrap();
        assert_eq!(overview.today_tokens, 1_000);
    }

    #[test]
    fn resource_statistics_scope_provider_and_key_with_quality_metrics() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url) VALUES
                    ('provider-1', 'Provider 1', 'https://one.test'),
                    ('provider-2', 'Provider 2', 'https://two.test')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO api_keys (id, provider_id, value) VALUES
                    ('key-1', 'provider-1', 'secret-1'),
                    ('key-2', 'provider-1', 'secret-2'),
                    ('key-3', 'provider-2', 'secret-3')",
                [],
            )
            .unwrap();

        let mut selected = mk_billable_log("selected", now.clone());
        selected.provider_id = Some("provider-1".into());
        selected.api_key_id = Some("key-1".into());
        selected.input_tokens = 100;
        selected.output_tokens = 50;
        selected.cache_read_tokens = 300;
        selected.cache_creation_tokens = 0;
        selected.latency_ms = Some(800);
        selected.first_token_ms = Some(200);
        selected.last_token_ms = Some(800);
        selected.is_streaming = true;
        db.request_log_create(&selected).unwrap();

        let mut failed = mk_failed_log("failed", now.clone(), 502, "upstream_error");
        failed.provider_id = Some("provider-1".into());
        failed.api_key_id = Some("key-1".into());
        failed.latency_ms = Some(1_200);
        db.request_log_create(&failed).unwrap();

        let mut other_key = mk_billable_log("other-key", now.clone());
        other_key.provider_id = Some("provider-1".into());
        other_key.api_key_id = Some("key-2".into());
        db.request_log_create(&other_key).unwrap();

        let mut other_provider = mk_billable_log("other-provider", now);
        other_provider.provider_id = Some("provider-2".into());
        other_provider.api_key_id = Some("key-3".into());
        db.request_log_create(&other_provider).unwrap();

        let key_stats = db
            .request_log_get_resource_statistics("all", Some("provider-1"), Some("key-1"))
            .unwrap();
        assert_eq!(key_stats.summary.total_requests, 2);
        assert_eq!(key_stats.summary.successful_requests, 1);
        assert_eq!(key_stats.summary.failed_requests, 1);
        assert_eq!(key_stats.summary.total_tokens, 450);
        assert!((key_stats.summary.success_rate - 0.5).abs() < 1e-9);
        assert!((key_stats.summary.cache_hit_rate - 0.75).abs() < 1e-9);
        assert_eq!(key_stats.summary.avg_latency_ms, Some(1_000.0));
        assert_eq!(key_stats.summary.avg_first_token_ms, Some(200.0));
        assert!(
            (key_stats.summary.avg_output_tokens_per_second.unwrap() - 50_000.0 / 600.0).abs()
                < 1e-9
        );
        assert_eq!(key_stats.daily_trend.len(), 1);
        assert_eq!(key_stats.daily_trend[0].failed_requests, 1);
        assert_eq!(key_stats.daily_trend[0].input_tokens, 100);
        assert_eq!(key_stats.daily_trend[0].output_tokens, 50);
        assert_eq!(key_stats.daily_trend[0].cache_read_tokens, 300);
        assert_eq!(key_stats.daily_trend[0].cache_creation_tokens, 0);
        assert_eq!(
            key_stats.daily_trend[0].avg_output_tokens_per_second,
            key_stats.summary.avg_output_tokens_per_second
        );
        assert_eq!(key_stats.trend_granularity, "month");

        let provider_stats = db
            .request_log_get_resource_statistics("all", Some("provider-1"), None)
            .unwrap();
        assert_eq!(provider_stats.summary.total_requests, 3);
        assert_eq!(provider_stats.summary.total_tokens, 480);
    }

    #[test]
    fn session_performance_stays_on_the_current_route_and_latest_foreground_request() {
        let db = Database::new_in_memory().unwrap();
        // Use real FK targets, including two keys on the same provider.
        db.conn.execute_batch(
            "INSERT INTO providers (id, name, base_url) VALUES ('p', 'P', 'https://test');
             INSERT INTO api_keys (id, provider_id, value) VALUES ('k', 'p', 'secret'), ('other', 'p', 'secret');"
        ).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let mut log = mk_billable_log("foreground", now);
        log.session_id = Some("current".into());
        log.provider_id = Some("p".into());
        log.api_key_id = Some("k".into());
        log.is_streaming = true;
        log.first_token_ms = Some(2_000);
        log.last_token_ms = Some(12_000);
        log.latency_ms = Some(30_000);
        log.output_tokens = 1_000;
        db.request_log_create(&log).unwrap();
        for id in ["classifier", "other-window", "other-route"] {
            let mut other = log.clone();
            other.id = id.into();
            other.output_tokens = 99_999;
            match id {
                "classifier" => other.request_kind = Some("auto_mode".into()),
                "other-window" => other.session_id = Some("other".into()),
                _ => other.api_key_id = Some("other".into()),
            }
            db.request_log_create(&other).unwrap();
        }
        assert_eq!(
            db.request_log_session_performance("current", "p", "k")
                .unwrap(),
            Some((Some(100.0), Some(2_000)))
        );
        assert_eq!(
            db.request_log_session_performance("missing", "p", "k")
                .unwrap(),
            None
        );

        // Equal timestamps are resolved by insertion order. A missing reading
        // on the latest request must replace the previous speed with a dash.
        log.id = "buffered-latest".into();
        log.last_token_ms = log.first_token_ms;
        db.request_log_upsert(&log).unwrap();
        assert_eq!(
            db.request_log_session_performance("current", "p", "k")
                .unwrap(),
            Some((None, Some(2_000)))
        );
        let rows = db.request_log_list_all().unwrap();
        assert_eq!(
            rows.iter()
                .find(|row| row.id == log.id)
                .unwrap()
                .last_token_ms,
            Some(2_000)
        );
    }

    #[test]
    fn last_output_migration_is_nullable_and_old_exports_remain_readable() {
        let db = Database::new_in_memory().unwrap();
        let mut log = mk_billable_log("legacy", chrono::Utc::now().to_rfc3339());
        log.first_token_ms = Some(20);
        db.request_log_create(&log).unwrap();
        db.conn
            .execute("ALTER TABLE request_logs DROP COLUMN last_token_ms", [])
            .unwrap();
        db.run_migrations(None).unwrap();
        db.run_migrations(None).unwrap();
        let rows = db.request_log_list_all().unwrap();
        assert_eq!(rows[0].first_token_ms, Some(20));
        assert_eq!(rows[0].last_token_ms, None);
        let mut exported = serde_json::to_value(&rows[0]).unwrap();
        exported.as_object_mut().unwrap().remove("lastTokenMs");
        let restored: RequestLog = serde_json::from_value(exported).unwrap();
        assert_eq!(restored.last_token_ms, None);
    }

    #[test]
    fn output_speed_uses_only_valid_successful_streams_and_excludes_input_tokens() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        for (id, streaming, first, latency, output, outcome) in [
            ("fast", true, Some(2_000), 30_000, 1_000, "success"),
            ("faster", true, Some(1_000), 100_000, 400, "success"),
            ("single-burst", true, Some(2_000), 12_000, 1_000, "success"),
            ("legacy-timing", true, Some(2_000), 12_000, 1_000, "success"),
            ("after-eof", true, Some(2_000), 12_000, 1_000, "success"),
            ("historical", true, None, 12_000, 1_000, "success"),
            ("buffered", false, Some(2_000), 12_000, 1_000, "success"),
            ("failed", true, Some(2_000), 12_000, 1_000, "upstream_error"),
            (
                "cancelled",
                true,
                Some(2_000),
                12_000,
                1_000,
                "transport_error",
            ),
            ("empty", true, Some(2_000), 12_000, 0, "success"),
            ("zero-duration", true, Some(2_000), 2_000, 1_000, "success"),
            (
                "negative-duration",
                true,
                Some(2_000),
                1_000,
                1_000,
                "success",
            ),
            ("negative-first", true, Some(-1), 12_000, 1_000, "success"),
        ] {
            let mut log = mk_billable_log(id, now.clone());
            log.is_streaming = streaming;
            log.first_token_ms = first;
            log.last_token_ms = match id {
                "fast" => Some(12_000),
                "faster" => Some(3_000),
                "single-burst" => first,
                "legacy-timing" => None,
                "after-eof" => Some(latency + 1),
                _ => Some(latency),
            };
            log.latency_ms = Some(latency);
            log.input_tokens = 1_000_000;
            log.cache_read_tokens = 2_000_000;
            log.output_tokens = output;
            log.outcome = Some(outcome.into());
            db.request_log_create(&log).unwrap();
        }
        let recent = db.request_log_get_recent_paginated("all", 1, 20).unwrap();
        assert_eq!(recent.items.len(), 13);
        for row in recent.items {
            assert_eq!(
                row.output_tokens_per_second,
                match row.id.as_str() {
                    "fast" => Some(100.0),
                    "faster" => Some(200.0),
                    _ => None,
                },
                "{}",
                row.id
            );
        }
        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(
            stats.summary.avg_output_tokens_per_second,
            Some(1_400_000.0 / 12_000.0)
        );
        let resource = db
            .request_log_get_resource_statistics("all", None, None)
            .unwrap();
        assert_eq!(
            resource.summary.avg_output_tokens_per_second,
            Some(1_400_000.0 / 12_000.0)
        );
        assert_eq!(
            resource.daily_trend[0].avg_output_tokens_per_second,
            Some(1_400_000.0 / 12_000.0)
        );

        db.conn
            .execute(
                "DELETE FROM request_logs WHERE id IN ('fast', 'faster')",
                [],
            )
            .unwrap();
        assert_eq!(
            db.request_log_get_statistics("all")
                .unwrap()
                .summary
                .avg_output_tokens_per_second,
            None
        );
        assert_eq!(
            db.request_log_get_resource_statistics("all", None, None)
                .unwrap()
                .summary
                .avg_output_tokens_per_second,
            None
        );
    }

    #[test]
    fn resource_trend_granularity_follows_the_selected_span() {
        assert_eq!(Database::trend_granularity("week"), "day");
        assert_eq!(Database::trend_granularity("last30Days"), "day");
        assert_eq!(Database::trend_granularity("year"), "week");
        assert_eq!(Database::trend_granularity("lastYear"), "week");
        assert_eq!(
            Database::trend_granularity("custom:2026-01-01:2026-06-30"),
            "week"
        );
        assert_eq!(
            Database::trend_granularity("custom:2020-01-01:2026-06-30"),
            "month"
        );
        assert_eq!(Database::trend_granularity("all"), "month");
    }

    #[test]
    fn resource_trend_aggregates_longer_ranges_before_returning_chart_points() {
        let db = Database::new_in_memory().unwrap();
        db.request_log_create(&mk_billable_log(
            "monday",
            "2026-01-05T12:00:00Z".to_string(),
        ))
        .unwrap();
        db.request_log_create(&mk_billable_log(
            "tuesday",
            "2026-01-06T12:00:00Z".to_string(),
        ))
        .unwrap();

        let stats = db
            .request_log_get_resource_statistics("custom:2026-01-01:2026-06-30", None, None)
            .unwrap();

        assert_eq!(stats.trend_granularity, "week");
        assert_eq!(stats.daily_trend.len(), 1);
        assert_eq!(stats.daily_trend[0].date, "2026-01-05");
        assert_eq!(stats.daily_trend[0].tokens, 60);
        assert_eq!(stats.daily_trend[0].requests, 2);
    }

    /// v3.10.0: a database created before the column existed must gain both the
    /// column and its index, so upgraded installs can join rows to console
    /// events and audit summaries exactly like fresh ones.
    #[test]
    fn request_id_column_and_index_are_added_to_a_legacy_database() {
        let db = Database::new_in_memory().unwrap();
        // The index has to go first: SQLite refuses to drop a column an index
        // still references.
        db.conn
            .execute("DROP INDEX IF EXISTS idx_request_logs_request_id", [])
            .unwrap();
        db.conn
            .execute("ALTER TABLE request_logs DROP COLUMN request_id", [])
            .unwrap();

        db.run_alter_migrations();

        let column_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('request_logs') WHERE name = 'request_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column_count, 1, "request_id column restored");
        let index_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_request_logs_request_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1, "request_id index restored");

        // Rows written before the column keep a NULL id rather than a guess.
        let legacy = mk_billable_log("legacy", chrono::Utc::now().to_rfc3339());
        db.request_log_create(&legacy).unwrap();
        let stored = db.request_log_list_all().unwrap();
        assert_eq!(stored[0].request_id.as_deref(), Some("req-legacy"));
    }

    // ── Merged observation ledger (proxy + Antigravity) ──

    use crate::db::antigravity_usage::{
        AntigravityConversationSyncBatch, AntigravitySource, AntigravitySyncFingerprint,
        AntigravityUsageEvent,
    };

    /// The exact RFC 3339 shape the sync layer pins for `created_at`.
    fn ag_now() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
    }

    fn ag_days_ago(days: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::days(days))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
    }

    fn antigravity_event(
        response_key: &str,
        created_at: &str,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        ttft_ms: i64,
        generation_ms: i64,
    ) -> AntigravityUsageEvent {
        AntigravityUsageEvent {
            gen_idx: 0,
            response_key: response_key.into(),
            model: Some("Gemini 4 Neon (High)".into()),
            project_name: Some("cc-use".into()),
            conversation_title: Some("Index design".into()),
            input_tokens,
            output_tokens,
            thinking_tokens: Some(output_tokens / 5),
            response_tokens: Some(output_tokens - output_tokens / 5),
            cache_read_tokens,
            cache_creation_tokens: 0,
            ttft_ms: Some(ttft_ms),
            generation_ms: Some(generation_ms),
            total_ms: Some(ttft_ms + generation_ms),
            created_at: created_at.into(),
        }
    }

    /// Writes through the real sync path so the merged ledger sees production rows.
    fn seed_antigravity(
        db: &Database,
        source: AntigravitySource,
        conversation_id: &str,
        events: Vec<AntigravityUsageEvent>,
    ) {
        db.antigravity_sync_apply_conversation(&AntigravityConversationSyncBatch {
            source,
            conversation_id: conversation_id.into(),
            file_path: format!("/tmp/{conversation_id}.db"),
            fingerprint: AntigravitySyncFingerprint::default(),
            events,
        })
        .unwrap();
    }

    /// One proxy row and one event per Antigravity installation, with distinct
    /// token totals and measurable stream timings:
    /// proxy 300 tokens (first 100 / last 1100 / latency 1500),
    /// desktop 470, cli 230 — 1000 tokens and 3 billable requests merged.
    fn unified_ledger_fixture() -> Database {
        let db = Database::new_in_memory().unwrap();
        let now = ag_now();

        let mut proxy = mk_billable_log("proxy-row", now.clone());
        proxy.input_tokens = 100;
        proxy.output_tokens = 200;
        proxy.is_streaming = true;
        proxy.first_token_ms = Some(100);
        proxy.last_token_ms = Some(1_100);
        proxy.latency_ms = Some(1_500);
        db.request_log_create(&proxy).unwrap();

        seed_antigravity(
            &db,
            AntigravitySource::Desktop,
            "desktop-conversation",
            vec![antigravity_event(
                "desktop-response",
                &now,
                50,
                400,
                20,
                200,
                800,
            )],
        );
        seed_antigravity(
            &db,
            AntigravitySource::Cli,
            "cli-conversation",
            vec![antigravity_event(
                "cli-response",
                &now,
                30,
                200,
                0,
                100,
                500,
            )],
        );
        db
    }

    #[test]
    fn observation_unified_ledger_merges_proxy_and_antigravity_usage() {
        use chrono::Datelike;
        let db = unified_ledger_fixture();

        let overview = db.request_log_get_overview().unwrap();
        assert_eq!(overview.today_tokens, 1_000);
        assert_eq!(overview.today_requests, 3);
        assert_eq!(overview.today_failed_requests, 0);

        let daily = db.request_log_get_daily_trend(366).unwrap();
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].tokens, 1_000);
        assert_eq!(daily[0].requests, 3);
        assert_eq!(daily[0].input_tokens, 180);
        assert_eq!(daily[0].output_tokens, 800);
        assert_eq!(daily[0].cache_read_tokens, 20);

        let now = chrono::Local::now();
        let monthly = db
            .request_log_get_monthly_trend(now.year() as i64, now.month() as i64)
            .unwrap();
        assert_eq!(monthly.iter().map(|point| point.tokens).sum::<i64>(), 1_000);

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 3);
        assert_eq!(stats.summary.total_tokens, 1_000);
        assert_eq!(stats.summary.total_input_tokens, 180);
        assert_eq!(stats.summary.total_output_tokens, 800);
        assert_eq!(stats.summary.total_cache_read_tokens, 20);
        // Dimensions describe the same merged population as the summary.
        assert_eq!(
            stats.key_usage.iter().map(|item| item.tokens).sum::<i64>(),
            1_000
        );
        assert_eq!(
            stats
                .key_usage
                .iter()
                .map(|item| item.requests)
                .sum::<i64>(),
            3
        );
        assert_eq!(
            stats
                .project_usage
                .iter()
                .map(|item| item.tokens)
                .sum::<i64>(),
            1_000
        );
        assert_eq!(
            stats
                .daily_model_usage
                .iter()
                .map(|item| item.tokens)
                .sum::<i64>(),
            1_000
        );

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(recent.total, 3);
        let mut sources = recent
            .items
            .iter()
            .filter_map(|item| item.source.as_deref())
            .collect::<Vec<_>>();
        sources.sort_unstable();
        assert_eq!(
            sources,
            vec!["antigravity_cli", "antigravity_desktop", "proxy"]
        );
    }

    #[test]
    fn observation_source_scope_never_widens_to_the_other_ledger() {
        let db = unified_ledger_fixture();
        for (source, tokens) in [
            (RequestLogSource::Proxy, 300),
            (RequestLogSource::AntigravityDesktop, 470),
            (RequestLogSource::AntigravityCli, 230),
        ] {
            let filter = RequestLogFilter {
                source: Some(source),
                ..Default::default()
            };
            let stats = db
                .request_log_get_statistics_filtered("all", &filter)
                .unwrap();
            assert_eq!(stats.summary.total_requests, 1, "{}", source.as_str());
            assert_eq!(stats.summary.total_tokens, tokens, "{}", source.as_str());
            assert!(
                !stats.summary.performance_mixed_sources,
                "{}",
                source.as_str()
            );
            let page = db
                .request_log_get_recent_paginated_filtered("all", 1, 10, &filter)
                .unwrap();
            assert_eq!(page.total, 1, "{}", source.as_str());
            assert!(page
                .items
                .iter()
                .all(|item| item.source.as_deref() == Some(source.as_str())));
        }
    }

    #[test]
    fn observation_mixed_sources_only_null_what_is_not_comparable() {
        let db = unified_ledger_fixture();

        // All sources: usage merged, incompatible performance withheld.
        let mixed = db.request_log_get_statistics("all").unwrap();
        assert!(mixed.summary.performance_mixed_sources);
        assert_eq!(mixed.summary.total_requests, 3);
        assert_eq!(mixed.summary.total_tokens, 1_000);
        assert_eq!(mixed.summary.avg_latency_ms, None);
        assert_eq!(mixed.summary.avg_first_token_ms, None);
        assert_eq!(mixed.summary.avg_output_tokens_per_second, None);

        // Proxy scope keeps the proxy end-to-end measurement.
        let proxy = db
            .request_log_get_statistics_filtered(
                "all",
                &RequestLogFilter {
                    source: Some(RequestLogSource::Proxy),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!proxy.summary.performance_mixed_sources);
        assert_eq!(proxy.summary.avg_latency_ms, Some(1_500.0));
        assert_eq!(proxy.summary.avg_first_token_ms, Some(100.0));
        assert_eq!(proxy.summary.avg_output_tokens_per_second, Some(200.0));

        // Antigravity scope keeps TTFT and the generation-duration speed:
        // 400 tokens * 1000 / 800 ms generation.
        let desktop = db
            .request_log_get_statistics_filtered(
                "all",
                &RequestLogFilter {
                    source: Some(RequestLogSource::AntigravityDesktop),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!desktop.summary.performance_mixed_sources);
        assert_eq!(desktop.summary.avg_latency_ms, Some(1_000.0));
        assert_eq!(desktop.summary.avg_first_token_ms, Some(200.0));
        assert_eq!(desktop.summary.avg_output_tokens_per_second, Some(500.0));

        // One source family in scope needs no filter and stays exact.
        let antigravity_only = Database::new_in_memory().unwrap();
        seed_antigravity(
            &antigravity_only,
            AntigravitySource::Desktop,
            "only-conversation",
            vec![antigravity_event(
                "only-response",
                &ag_now(),
                10,
                240,
                0,
                200,
                1_000,
            )],
        );
        let single = antigravity_only.request_log_get_statistics("all").unwrap();
        assert!(!single.summary.performance_mixed_sources);
        assert_eq!(single.summary.avg_latency_ms, Some(1_200.0));
        assert_eq!(single.summary.avg_first_token_ms, Some(200.0));
        assert_eq!(single.summary.avg_output_tokens_per_second, Some(240.0));

        // An empty ledger has no mixed anything.
        let empty = Database::new_in_memory().unwrap();
        let none = empty.request_log_get_statistics("all").unwrap();
        assert!(!none.summary.performance_mixed_sources);
        assert_eq!(none.summary.total_requests, 0);
    }

    #[test]
    fn observation_antigravity_rows_never_inflate_failure_counts() {
        let db = unified_ledger_fixture();
        db.request_log_create(&mk_failed_log(
            "proxy-failed",
            ag_now(),
            502,
            "upstream_error",
        ))
        .unwrap();
        db.request_log_create(&mk_failed_log(
            "proxy-client",
            ag_now(),
            429,
            "client_error",
        ))
        .unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 3, "billable scope unchanged");
        assert_eq!(stats.summary.failed_requests, 2, "proxy failures only");
        assert_eq!(
            db.request_log_get_overview().unwrap().today_failed_requests,
            2
        );

        // An Antigravity scope verifies no proxy failure, so it reports none.
        let desktop = db
            .request_log_get_statistics_filtered(
                "all",
                &RequestLogFilter {
                    source: Some(RequestLogSource::AntigravityDesktop),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(desktop.summary.total_requests, 1);
        assert_eq!(desktop.summary.failed_requests, 0);

        // The failure drilldown still returns proxy rows only.
        let failed = RequestLogFilter {
            outcome: Some(RequestLogOutcome::Failed),
            ..Default::default()
        };
        let page = db
            .request_log_get_recent_paginated_filtered("all", 1, 10, &failed)
            .unwrap();
        assert_eq!(page.total, 2);
        assert!(page
            .items
            .iter()
            .all(|item| item.source.as_deref() == Some("proxy")));

        let failed_antigravity = RequestLogFilter {
            outcome: Some(RequestLogOutcome::Failed),
            source: Some(RequestLogSource::AntigravityDesktop),
            ..Default::default()
        };
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 10, &failed_antigravity)
                .unwrap()
                .total,
            0
        );
    }

    #[test]
    fn observation_population_and_outcome_scopes_apply_to_antigravity_rows() {
        let db = Database::new_in_memory().unwrap();
        let now = ag_now();
        seed_antigravity(
            &db,
            AntigravitySource::Desktop,
            "conversation",
            vec![
                antigravity_event("billable", &now, 10, 20, 0, 100, 400),
                antigravity_event("empty", &now, 0, 0, 0, 100, 400),
            ],
        );

        let with_usage = RequestLogFilter {
            population: Some(RequestLogPopulation::WithUsage),
            ..Default::default()
        };
        let page = db
            .request_log_get_recent_paginated_filtered("all", 1, 10, &with_usage)
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "ag:desktop:conversation:billable");

        // The all population keeps the zero-token generation as a ledger row.
        assert_eq!(
            db.request_log_get_recent_paginated("all", 1, 10)
                .unwrap()
                .total,
            2
        );

        // Antigravity rows project outcome 'success': success keeps them,
        // failures exclude them.
        let success = RequestLogFilter {
            outcome: Some(RequestLogOutcome::Success),
            ..Default::default()
        };
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 10, &success)
                .unwrap()
                .total,
            2
        );
        let failed = RequestLogFilter {
            outcome: Some(RequestLogOutcome::Failed),
            ..Default::default()
        };
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 10, &failed)
                .unwrap()
                .total,
            0
        );

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 1);
        assert_eq!(stats.summary.total_tokens, 30);
    }

    #[test]
    fn observation_recent_rows_expose_antigravity_source_and_generation_fields() {
        let db = unified_ledger_fixture();
        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();

        let desktop = recent
            .items
            .iter()
            .find(|item| item.id == "ag:desktop:desktop-conversation:desktop-response")
            .expect("desktop row");
        assert_eq!(
            desktop.source.as_deref(),
            Some(RequestLogSource::AntigravityDesktop.as_str())
        );
        assert_eq!(
            desktop.provider_name.as_deref(),
            Some(RequestLogSource::AntigravityDesktop.display_name())
        );
        assert_eq!(desktop.key_alias.as_deref(), Some("Index design"));
        assert_eq!(desktop.project_name.as_deref(), Some("cc-use"));
        assert_eq!(desktop.model.as_deref(), Some("Gemini 4 Neon (High)"));
        assert_eq!(desktop.thinking_tokens, Some(80));
        assert_eq!(desktop.response_tokens, Some(320));
        assert_eq!(desktop.generation_ms, Some(800));
        assert_eq!(desktop.latency_ms, Some(1_000));
        assert_eq!(desktop.first_token_ms, Some(200));
        assert_eq!(desktop.output_tokens_per_second, Some(500.0));
        assert_eq!(desktop.outcome.as_deref(), Some("success"));
        assert_eq!(desktop.status_code, None);
        assert_eq!(desktop.request_id, None);

        let cli = recent
            .items
            .iter()
            .find(|item| item.id == "ag:cli:cli-conversation:cli-response")
            .expect("cli row");
        assert_eq!(
            cli.provider_name.as_deref(),
            Some(RequestLogSource::AntigravityCli.display_name())
        );
        assert_eq!(cli.output_tokens_per_second, Some(400.0));

        // Proxy rows keep their own shape: no thinking split, no generation time.
        let proxy = recent
            .items
            .iter()
            .find(|item| item.id == "proxy-row")
            .expect("proxy row");
        assert_eq!(proxy.source.as_deref(), Some("proxy"));
        assert_eq!(proxy.provider_name.as_deref(), Some("codex-provider"));
        assert_eq!(proxy.thinking_tokens, None);
        assert_eq!(proxy.response_tokens, None);
        assert_eq!(proxy.generation_ms, None);
    }

    #[test]
    fn observation_proxy_only_reads_stay_on_request_logs() {
        let db = Database::new_in_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO providers (id, name, base_url) VALUES ('p', 'Proxy provider', 'https://fixture.invalid');
                 INSERT INTO api_keys (id, provider_id, value) VALUES ('k', 'p', 'fixture');",
            )
            .unwrap();
        let mut proxy = mk_billable_log("proxy-row", ag_now());
        proxy.provider_id = Some("p".into());
        proxy.api_key_id = Some("k".into());
        proxy.session_id = Some("session-1".into());
        proxy.input_tokens = 100;
        proxy.output_tokens = 200;
        proxy.is_streaming = true;
        proxy.first_token_ms = Some(100);
        proxy.last_token_ms = Some(1_100);
        proxy.latency_ms = Some(1_500);
        db.request_log_create(&proxy).unwrap();
        seed_antigravity(
            &db,
            AntigravitySource::Desktop,
            "conversation",
            vec![antigravity_event(
                "response",
                &ag_now(),
                50,
                400,
                20,
                200,
                800,
            )],
        );

        let rows = db.request_log_list_all().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "proxy-row");
        let key_stats = db.request_log_get_key_token_stats().unwrap();
        assert_eq!(key_stats.len(), 1);
        assert_eq!(key_stats[0]["totalTokens"], 300);
        let resource = db
            .request_log_get_resource_statistics("all", None, None)
            .unwrap();
        assert_eq!(resource.summary.total_requests, 1);
        assert_eq!(resource.summary.total_tokens, 300);
        assert_eq!(
            db.request_log_session_performance("session-1", "p", "k")
                .unwrap(),
            Some((Some(200.0), Some(100)))
        );

        // Retention is proxy-owned; Antigravity history has its own cleanup.
        db.request_log_create(&mk_billable_log("old-proxy", ag_days_ago(100)))
            .unwrap();
        seed_antigravity(
            &db,
            AntigravitySource::Cli,
            "old-conversation",
            vec![antigravity_event(
                "old-response",
                &ag_days_ago(100),
                10,
                10,
                0,
                10,
                10,
            )],
        );
        assert_eq!(db.request_log_cleanup_old(90).unwrap(), 1);
        assert_eq!(db.request_log_list_all().unwrap().len(), 1);
        let antigravity_rows: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM antigravity_usage_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(antigravity_rows, 2);
    }

    #[test]
    fn observation_invalid_scopes_error_instead_of_reading_the_merged_ledger() {
        let db = unified_ledger_fixture();
        db.conn
            .execute_batch(
                "INSERT INTO providers (id, name, base_url) VALUES ('p1', 'Provider', 'https://fixture.invalid');
                 INSERT INTO api_keys (id, provider_id, value) VALUES ('k1', 'p1', 'fixture');",
            )
            .unwrap();

        // An existing scope with no rows is empty, never widened to Antigravity data.
        let empty_scope = RequestLogFilter {
            provider_id: Some("p1".into()),
            ..Default::default()
        };
        assert_eq!(
            db.request_log_get_statistics_filtered("all", &empty_scope)
                .unwrap()
                .summary
                .total_requests,
            0
        );
        assert_eq!(
            db.request_log_get_recent_paginated_filtered("all", 1, 10, &empty_scope)
                .unwrap()
                .total,
            0
        );

        // Deleting the resource turns the scope into an error, never global data.
        db.conn
            .execute("DELETE FROM providers WHERE id = 'p1'", [])
            .unwrap();
        let deleted = RequestLogFilter {
            provider_id: Some("p1".into()),
            ..Default::default()
        };
        assert!(db
            .request_log_get_statistics_filtered("all", &deleted)
            .is_err());
        assert!(db
            .request_log_get_recent_paginated_filtered("all", 1, 10, &deleted)
            .is_err());
        // A source filter never rescues an invalid resource scope.
        let deleted_antigravity = RequestLogFilter {
            provider_id: Some("p1".into()),
            source: Some(RequestLogSource::AntigravityDesktop),
            ..Default::default()
        };
        assert!(db
            .request_log_get_statistics_filtered("all", &deleted_antigravity)
            .is_err());
        assert_eq!(
            db.request_log_get_recent_paginated("all", 1, 10)
                .unwrap()
                .total,
            3
        );

        // Malformed ranges fail before any ledger is read.
        let filter = RequestLogFilter::default();
        for range in [
            "typo",
            "custom:2026-11-15:2026-11-14",
            "custom:2026-13-01:2026-13-02",
        ] {
            assert!(db
                .request_log_get_statistics_filtered(range, &filter)
                .is_err());
            assert!(db
                .request_log_get_recent_paginated_filtered(range, 1, 10, &filter)
                .is_err());
        }
    }

    #[test]
    fn observation_ledger_cte_pins_the_antigravity_projection() {
        // The SQL is a constant, so keep the display labels and discriminators
        // tied to the model that owns them.
        for source in [
            RequestLogSource::AntigravityDesktop,
            RequestLogSource::AntigravityCli,
        ] {
            assert!(
                UNIFIED_LEDGER_CTE.contains(source.display_name()),
                "{}",
                source.as_str()
            );
            assert!(
                UNIFIED_LEDGER_CTE.contains(&format!("WHEN '{}'", source.as_str())),
                "{}",
                source.as_str()
            );
        }
        assert!(UNIFIED_LEDGER_CTE.contains("'proxy' AS source"));
        assert!(UNIFIED_LEDGER_CTE.contains("FROM antigravity_usage_events"));
        assert!(UNIFIED_LEDGER_CTE.contains("FROM request_logs"));
        // The speed denominator has to stay exactly generation_ms.
        assert!(UNIFIED_LEDGER_CTE.contains("THEN ttft_ms + generation_ms END AS last_token_ms"));
    }
}
