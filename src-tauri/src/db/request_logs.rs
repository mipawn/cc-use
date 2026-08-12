use crate::db::Database;
use crate::models::{
    DailyModelUsageItem, DailyTrendItem, PaginatedRecentRequests, RecentRequestLogDisplay,
    RequestLog, ResourceUsageStatistics, ResourceUsageSummary, ResourceUsageTrendItem,
    UsageDimensionItem, UsageOverview, UsageStatistics, UsageStatsSummary,
};

/// input + output + cache_read + cache_creation — the v3.7.0 token definition.
/// Cache tokens are real traffic the user pays for and are often the dominant
/// share under Claude Code; hiding them made totals unexplainable.
const TOKEN_SUM: &str = "input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens";

impl Database {
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

    /// Billable scope: rows that carried usage. Failure rows (tokens all zero)
    /// are excluded here and surfaced through the failure queries instead.
    fn billable_request_logs_where(&self, col: &str, time_range: &str) -> String {
        let usage_clause = "input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0";
        match self.time_range_where(col, time_range) {
            where_clause if where_clause.is_empty() => format!("WHERE {}", usage_clause),
            where_clause => format!("{} AND ({})", where_clause, usage_clause),
        }
    }

    fn billable_request_logs_where_with_alias(
        &self,
        col: &str,
        alias: &str,
        time_range: &str,
    ) -> String {
        let usage_clause = format!(
            "{0}.input_tokens > 0 OR {0}.output_tokens > 0 OR {0}.cache_read_tokens > 0 OR {0}.cache_creation_tokens > 0",
            alias
        );
        match self.time_range_where(col, time_range) {
            where_clause if where_clause.is_empty() => format!("WHERE ({})", usage_clause),
            where_clause => format!("{} AND ({})", where_clause, usage_clause),
        }
    }

    pub fn request_log_list_all(&self) -> Result<Vec<RequestLog>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, api_key_id, project_id, session_id,
                    model, request_model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens,
                    latency_ms, first_token_ms, status_code, error_message,
                    is_streaming, created_at,
                    key_alias, provider_name, project_name, outcome
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
                status_code: row.get(13)?,
                error_message: row.get(14)?,
                is_streaming: is_streaming != 0,
                created_at: row.get(16)?,
                key_alias: row.get(17)?,
                provider_name: row.get(18)?,
                project_name: row.get(19)?,
                outcome: row.get(20)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_create(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, latency_ms, first_token_ms, status_code, error_message,
                is_streaming, created_at, key_alias, provider_name, project_name, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            rusqlite::params![
                log.id, log.provider_id, log.api_key_id, log.project_id, log.session_id,
                log.model, log.request_model, log.input_tokens, log.output_tokens,
                log.cache_read_tokens, log.cache_creation_tokens,
                log.latency_ms, log.first_token_ms, log.status_code, log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 }, log.created_at,
                log.key_alias, log.provider_name, log.project_name, log.outcome,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_upsert(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, latency_ms, first_token_ms, status_code, error_message,
                is_streaming, created_at, key_alias, provider_name, project_name, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
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
            "SELECT {} as d,
                    COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM request_logs
                 WHERE {} >= DATE('now', 'localtime', '-{} days')
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            created_date, TOKEN_SUM, created_date, day_offset
        ))?;

        let rows = stmt.query_map([], Self::map_daily_trend_row)?;
        rows.collect()
    }

    fn request_log_get_daily_trend_for_range(
        &self,
        time_range: &str,
    ) -> Result<Vec<DailyTrendItem>, rusqlite::Error> {
        let created_date = Self::local_date_expr("created_at");
        let where_clause = self.billable_request_logs_where("created_at", time_range);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} as d,
                    COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM request_logs
                 {} GROUP BY d ORDER BY d ASC",
            created_date, TOKEN_SUM, where_clause
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
            "SELECT {} as d,
                    COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
                 FROM request_logs
                 WHERE strftime('%Y-%m', {}) = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            created_date, TOKEN_SUM, created_date
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
        let where_clause = self.billable_request_logs_where("created_at", time_range);

        let (
            total_requests,
            total_input_tokens,
            total_output_tokens,
            total_cache_read_tokens,
            total_cache_creation_tokens,
            avg_latency_ms,
        ) = self.conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
                        AVG(latency_ms)
                 FROM request_logs {}",
                where_clause
            ),
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                ))
            },
        )?;

        // Failures are counted over the full log for the same range, not the
        // billable subset — a failed request never carries tokens.
        let failure_where = match self.time_range_where("created_at", time_range) {
            clause if clause.is_empty() => {
                "WHERE outcome IS NOT NULL AND outcome != 'success'".to_string()
            }
            clause => format!(
                "{} AND outcome IS NOT NULL AND outcome != 'success'",
                clause
            ),
        };

        let failed_requests: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM request_logs {}", failure_where),
            [],
            |row| row.get(0),
        )?;

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
        };

        let dimension_where =
            self.billable_request_logs_where_with_alias("r.created_at", "r", time_range);

        let mut key_stmt = self.conn.prepare(&format!(
            "SELECT COALESCE(r.api_key_id, 'unassigned'),
                    COALESCE(NULLIF(r.key_alias, ''), NULLIF(k.alias, ''), 'Unknown key'),
                    COALESCE(NULLIF(r.provider_name, ''), NULLIF(p.name, ''), ''),
                    COALESCE(SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens), 0),
                    COUNT(*)
             FROM request_logs r
             LEFT JOIN api_keys k ON r.api_key_id = k.id
             LEFT JOIN providers p ON r.provider_id = p.id
             {}
             GROUP BY 1, 2, 3
             ORDER BY 4 DESC, 5 DESC",
            dimension_where
        ))?;
        let key_usage = key_stmt
            .query_map([], |row| {
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
            "SELECT COALESCE(r.project_id, ps.cli_type, 'unassigned'),
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
             FROM request_logs r
             LEFT JOIN projects pr ON r.project_id = pr.id
             LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
             {}
             GROUP BY 1, 2, 3
             ORDER BY 4 DESC, 5 DESC",
            dimension_where
        ))?;
        let project_usage = project_stmt
            .query_map([], |row| {
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
        let mut model_stmt = self.conn.prepare(&format!(
            "SELECT {} AS d,
                    COALESCE(NULLIF(TRIM(model), ''), NULLIF(TRIM(request_model), ''), ''),
                    COALESCE(SUM({}), 0)
             FROM request_logs {}
             GROUP BY d, 2
             ORDER BY d DESC, 3 DESC, 2 ASC",
            created_date, TOKEN_SUM, where_clause
        ))?;
        let daily_model_usage = model_stmt
            .query_map([], |row| {
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
        let range_clause = self.time_range_where("created_at", time_range);
        let scoped_where = if range_clause.is_empty() {
            "WHERE (?1 IS NULL OR provider_id = ?1) AND (?2 IS NULL OR api_key_id = ?2)".to_string()
        } else {
            format!(
                "{} AND (?1 IS NULL OR provider_id = ?1) AND (?2 IS NULL OR api_key_id = ?2)",
                range_clause
            )
        };

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
        ) = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM({}), 0), COUNT(*),
                        COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') = 'success' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') != 'success' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(input_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
                        COALESCE(SUM(cache_creation_tokens), 0), AVG(latency_ms), AVG(first_token_ms)
                 FROM request_logs {}",
                TOKEN_SUM, scoped_where
            ),
            rusqlite::params![provider_id, api_key_id],
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
        };

        let created_date = Self::local_date_expr("created_at");
        let trend_granularity = Self::trend_granularity(time_range);
        let trend_bucket = Self::trend_bucket_expr(&created_date, trend_granularity);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} AS d, COALESCE(SUM({}), 0), COUNT(*),
                    COALESCE(SUM(CASE WHEN COALESCE(outcome, 'success') != 'success' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
                    AVG(latency_ms), AVG(first_token_ms)
             FROM request_logs {} GROUP BY d ORDER BY d ASC",
            trend_bucket, TOKEN_SUM, scoped_where
        ))?;
        let daily_trend = stmt
            .query_map(rusqlite::params![provider_id, api_key_id], |row| {
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
        let page = page.max(1);
        let page_size = page_size.max(1).min(100);
        let offset = (page - 1) * page_size;
        let where_clause = self.time_range_where("r.created_at", time_range);

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM request_logs r {}", where_clause),
            [],
            |row| row.get(0),
        )?;

        let mut stmt = self.conn.prepare(&format!(
            "SELECT r.id, r.model, COALESCE(r.key_alias, k.alias), COALESCE(r.provider_name, p.name),
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
                        r.latency_ms, r.status_code, r.outcome, r.error_message, r.created_at
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
                 {} ORDER BY r.created_at DESC LIMIT ?1 OFFSET ?2",
            where_clause
        ))?;
        let items: Vec<RecentRequestLogDisplay> = stmt
            .query_map([page_size, offset], |row| {
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
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

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

        let (today_tokens, today_requests) = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM({}), 0), COUNT(*)
                 FROM request_logs
                 WHERE {} = ?1 AND ({})",
                TOKEN_SUM, created_date, usage_clause
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
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            latency_ms: Some(100),
            first_token_ms: None,
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
        let invalid = db
            .request_log_get_statistics("custom:not-a-date:2026-07-31")
            .unwrap();
        assert_eq!(invalid.summary.total_requests, 0);
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
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            session_kind: "desktop".into(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            revoked_at: None,
            revoked_reason: None,
            cli_type: Some("codex-app".into()),
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
    fn daily_trend_totals_include_cache_buckets() {
        let db = Database::new_in_memory().unwrap();
        let mut cache_only = mk_billable_log("cache-only", chrono::Utc::now().to_rfc3339());
        cache_only.input_tokens = 0;
        cache_only.output_tokens = 0;
        cache_only.cache_read_tokens = 1_000;
        db.request_log_create(&cache_only).unwrap();

        let stats = db.request_log_get_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 1);
        // v3.7.0: cache traffic is part of the headline token number.
        let trend = db.request_log_get_daily_trend_for_range("all").unwrap();
        assert_eq!(trend[0].tokens, 1_000);
        assert_eq!(trend[0].cache_read_tokens, 1_000);

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
        assert_eq!(key_stats.daily_trend.len(), 1);
        assert_eq!(key_stats.daily_trend[0].failed_requests, 1);
        assert_eq!(key_stats.daily_trend[0].input_tokens, 100);
        assert_eq!(key_stats.daily_trend[0].output_tokens, 50);
        assert_eq!(key_stats.daily_trend[0].cache_read_tokens, 300);
        assert_eq!(key_stats.daily_trend[0].cache_creation_tokens, 0);
        assert_eq!(key_stats.trend_granularity, "month");

        let provider_stats = db
            .request_log_get_resource_statistics("all", Some("provider-1"), None)
            .unwrap();
        assert_eq!(provider_stats.summary.total_requests, 3);
        assert_eq!(provider_stats.summary.total_tokens, 480);
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
}
