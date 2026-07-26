use crate::db::Database;
use crate::models::{
    CostStatistics, CostStatsSummary, DailyCostTrendItem, DashboardCostStats,
    PaginatedRecentRequests, RecentRequestLogDisplay, RequestLog, TopKeyCostItem, TopModelCostItem,
    TopProjectCostItem, TopProviderCostItem,
};

impl Database {
    fn billable_request_logs_where(&self, col: &str, time_range: &str) -> String {
        let usage_clause = "input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0";
        match self.time_range_where(col, time_range) {
            where_clause if where_clause.is_empty() => format!("WHERE {}", usage_clause),
            where_clause => format!("{} AND ({})", where_clause, usage_clause),
        }
    }

    fn billable_request_logs_where_with_alias(
        &self,
        alias: &str,
        col: &str,
        time_range: &str,
    ) -> String {
        let usage_clause = format!(
            "{}.input_tokens > 0 OR {}.output_tokens > 0 OR {}.cache_read_tokens > 0 OR {}.cache_creation_tokens > 0",
            alias, alias, alias, alias
        );
        match self.time_range_where(col, time_range) {
            where_clause if where_clause.is_empty() => format!("WHERE {}", usage_clause),
            where_clause => format!("{} AND ({})", where_clause, usage_clause),
        }
    }

    pub fn request_log_list_all(&self) -> Result<Vec<RequestLog>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, api_key_id, project_id, session_id,
                    model, request_model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens,
                    input_cost_usd, output_cost_usd, cache_read_cost_usd,
                    cache_creation_cost_usd, total_cost_usd, cost_multiplier,
                    latency_ms, first_token_ms, status_code, error_message,
                    is_streaming, created_at,
                    key_alias, provider_name, project_name
             FROM request_logs ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            let is_streaming: i32 = row.get(21)?;
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
                input_cost_usd: row.get(11)?,
                output_cost_usd: row.get(12)?,
                cache_read_cost_usd: row.get(13)?,
                cache_creation_cost_usd: row.get(14)?,
                total_cost_usd: row.get(15)?,
                cost_multiplier: row.get(16)?,
                latency_ms: row.get(17)?,
                first_token_ms: row.get(18)?,
                status_code: row.get(19)?,
                error_message: row.get(20)?,
                is_streaming: is_streaming != 0,
                created_at: row.get(22)?,
                key_alias: row.get(23)?,
                provider_name: row.get(24)?,
                project_name: row.get(25)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_create(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, input_cost_usd, output_cost_usd, cache_read_cost_usd,
                cache_creation_cost_usd, total_cost_usd, cost_multiplier, latency_ms,
                first_token_ms, status_code, error_message, is_streaming, created_at,
                key_alias, provider_name, project_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
            rusqlite::params![
                log.id, log.provider_id, log.api_key_id, log.project_id, log.session_id,
                log.model, log.request_model, log.input_tokens, log.output_tokens,
                log.cache_read_tokens, log.cache_creation_tokens,
                log.input_cost_usd, log.output_cost_usd, log.cache_read_cost_usd,
                log.cache_creation_cost_usd, log.total_cost_usd, log.cost_multiplier,
                log.latency_ms, log.first_token_ms, log.status_code, log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 }, log.created_at,
                log.key_alias, log.provider_name, log.project_name,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_upsert(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, input_cost_usd, output_cost_usd, cache_read_cost_usd,
                cache_creation_cost_usd, total_cost_usd, cost_multiplier, latency_ms,
                first_token_ms, status_code, error_message, is_streaming, created_at,
                key_alias, provider_name, project_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
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
                log.input_cost_usd,
                log.output_cost_usd,
                log.cache_read_cost_usd,
                log.cache_creation_cost_usd,
                log.total_cost_usd,
                log.cost_multiplier,
                log.latency_ms,
                log.first_token_ms,
                log.status_code,
                log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 },
                log.created_at,
                log.key_alias,
                log.provider_name,
                log.project_name,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_get_cost_stats(&self) -> Result<serde_json::Value, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let created_date = Self::local_date_expr("created_at");

        let today_cost: f64 = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs
                 WHERE {} = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)",
                created_date
            ),
            [&today],
            |row| row.get(0),
        )?;

        let total_balance: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(cached_wallet_balance), 0) FROM providers WHERE cached_wallet_balance IS NOT NULL",
            [],
            |row| row.get(0),
        )?;

        Ok(serde_json::json!({
            "todayCost": today_cost,
            "totalBalance": total_balance,
        }))
    }

    pub fn request_log_get_key_costs(&self) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let created_date = Self::local_date_expr("created_at");

        let mut stmt = self.conn.prepare(&format!(
            "SELECT api_key_id,
                    COALESCE(SUM(CASE WHEN {} = ?1 THEN total_cost_usd ELSE 0 END), 0) as today_cost,
                    COALESCE(SUM(total_cost_usd), 0) as total_cost
             FROM request_logs
             WHERE api_key_id IS NOT NULL
               AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
             GROUP BY api_key_id",
            created_date
        ))?;

        let rows = stmt.query_map([&today], |row| {
            Ok(serde_json::json!({
                "keyId": row.get::<_, String>(0)?,
                "todayCost": row.get::<_, f64>(1)?,
                "totalCost": row.get::<_, f64>(2)?,
            }))
        })?;

        rows.collect()
    }

    pub fn request_log_get_daily_trend(
        &self,
        days: i64,
    ) -> Result<Vec<DailyCostTrendItem>, rusqlite::Error> {
        let created_date = Self::local_date_expr("created_at");
        let day_offset = days.clamp(1, 366) - 1;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} as d, COALESCE(SUM(total_cost_usd), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0), COUNT(*)
                 FROM request_logs
                 WHERE {} >= DATE('now', 'localtime', '-{} days')
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            created_date,
            created_date,
            day_offset
        ))?;

        let rows = stmt.query_map([], |row| {
            Ok(DailyCostTrendItem {
                date: row.get(0)?,
                cost: row.get(1)?,
                tokens: row.get(2)?,
                requests: row.get(3)?,
            })
        })?;

        rows.collect()
    }

    fn request_log_get_daily_trend_for_range(
        &self,
        time_range: &str,
    ) -> Result<Vec<DailyCostTrendItem>, rusqlite::Error> {
        let created_date = Self::local_date_expr("created_at");
        let where_clause = self.billable_request_logs_where("created_at", time_range);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} as d, COALESCE(SUM(total_cost_usd), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0), COUNT(*)
                 FROM request_logs
                 {} GROUP BY d ORDER BY d ASC",
            created_date, where_clause
        ))?;

        let rows = stmt.query_map([], |row| {
            Ok(DailyCostTrendItem {
                date: row.get(0)?,
                cost: row.get(1)?,
                tokens: row.get(2)?,
                requests: row.get(3)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_get_monthly_trend(
        &self,
        year: i64,
        month: i64,
    ) -> Result<Vec<DailyCostTrendItem>, rusqlite::Error> {
        let ym = format!("{:04}-{:02}", year, month);
        let created_date = Self::local_date_expr("created_at");
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} as d, COALESCE(SUM(total_cost_usd), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0), COUNT(*)
                 FROM request_logs
                 WHERE strftime('%Y-%m', {}) = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)
                 GROUP BY d ORDER BY d ASC",
            created_date, created_date
        ))?;

        let rows = stmt.query_map([&ym], |row| {
            Ok(DailyCostTrendItem {
                date: row.get(0)?,
                cost: row.get(1)?,
                tokens: row.get(2)?,
                requests: row.get(3)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_get_cost_statistics(
        &self,
        time_range: &str,
    ) -> Result<CostStatistics, rusqlite::Error> {
        self.request_log_get_statistics(time_range, "cost")
    }

    pub fn request_log_get_statistics(
        &self,
        time_range: &str,
        metric: &str,
    ) -> Result<CostStatistics, rusqlite::Error> {
        let where_clause = self.billable_request_logs_where("created_at", time_range);
        let r_where_clause =
            self.billable_request_logs_where_with_alias("r", "r.created_at", time_range);
        let ranking_expression = if metric == "tokens" {
            "SUM(r.input_tokens + r.output_tokens)"
        } else {
            "SUM(r.total_cost_usd)"
        };
        let model_ranking_expression = if metric == "tokens" {
            "SUM(input_tokens + output_tokens)"
        } else {
            "SUM(total_cost_usd)"
        };

        // Summary
        let summary = self.conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
                        COALESCE(SUM(COALESCE(cache_read_cost_usd, 0) +
                                     COALESCE(cache_creation_cost_usd, 0)), 0),
                        COALESCE(SUM(total_cost_usd), 0), AVG(latency_ms)
                 FROM request_logs {}",
                where_clause
            ),
            [],
            |row| {
                Ok(CostStatsSummary {
                    total_requests: row.get(0)?,
                    total_input_tokens: row.get(1)?,
                    total_output_tokens: row.get(2)?,
                    total_cache_read_tokens: row.get(3)?,
                    total_cache_creation_tokens: row.get(4)?,
                    total_cache_cost_usd: row.get(5)?,
                    total_cost_usd: row.get(6)?,
                    avg_latency_ms: row.get(7)?,
                })
            },
        )?;

        // Top keys
        let mut stmt = self.conn.prepare(&format!(
            "SELECT r.api_key_id, COALESCE(r.key_alias, k.alias, ''), COALESCE(r.provider_name, p.name, ''),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 {} GROUP BY r.api_key_id ORDER BY {} DESC LIMIT 10",
            if r_where_clause.is_empty() {
                ""
            } else {
                &r_where_clause
            },
            ranking_expression
        ))?;
        let top_keys: Vec<TopKeyCostItem> = stmt
            .query_map([], |row| {
                Ok(TopKeyCostItem {
                    key_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    key_alias: row.get(1)?,
                    provider_name: row.get(2)?,
                    total_cost: row.get(3)?,
                    total_requests: row.get(4)?,
                    total_tokens: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Top providers
        let mut stmt = self.conn.prepare(&format!(
            "SELECT r.provider_id, COALESCE(r.provider_name, p.name, ''),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN providers p ON r.provider_id = p.id
                 {} GROUP BY r.provider_id ORDER BY {} DESC LIMIT 10",
            if r_where_clause.is_empty() {
                ""
            } else {
                &r_where_clause
            },
            ranking_expression
        ))?;
        let top_providers: Vec<TopProviderCostItem> = stmt
            .query_map([], |row| {
                Ok(TopProviderCostItem {
                    provider_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    provider_name: row.get(1)?,
                    total_cost: row.get(2)?,
                    total_requests: row.get(3)?,
                    total_tokens: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Top projects. Config-takeover clients such as Codex Desktop do not
        // carry a project_id, so group them under a clear client bucket instead
        // of surfacing an ambiguous "Unknown" project.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT
                        CASE
                            WHEN r.project_id IS NOT NULL THEN r.project_id
                            WHEN ps.cli_type IS NOT NULL THEN '__client__' || ps.cli_type
                            ELSE '__other__'
                        END,
                        COALESCE(
                            r.project_name,
                            pr.name,
                            CASE ps.cli_type
                                WHEN 'codex-app' THEN 'Codex Desktop'
                                WHEN 'claude_desktop' THEN 'Claude Desktop'
                                ELSE NULL
                            END,
                            'Other'
                        ),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
                 {} GROUP BY 1, 2 ORDER BY {} DESC LIMIT 10",
            if r_where_clause.is_empty() {
                ""
            } else {
                &r_where_clause
            },
            ranking_expression
        ))?;
        let top_projects: Vec<TopProjectCostItem> = stmt
            .query_map([], |row| {
                Ok(TopProjectCostItem {
                    project_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    project_name: row.get(1)?,
                    total_cost: row.get(2)?,
                    total_requests: row.get(3)?,
                    total_tokens: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Top models
        let mut stmt = self.conn.prepare(&format!(
            "SELECT COALESCE(model, 'unknown'), SUM(total_cost_usd), COUNT(*),
                        SUM(input_tokens + output_tokens)
                 FROM request_logs
                 {} GROUP BY model ORDER BY {} DESC LIMIT 10",
            where_clause, model_ranking_expression
        ))?;
        let top_models: Vec<TopModelCostItem> = stmt
            .query_map([], |row| {
                Ok(TopModelCostItem {
                    model: row.get(0)?,
                    total_cost: row.get(1)?,
                    total_requests: row.get(2)?,
                    total_tokens: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Keep the trend on the same local-time range as the summary and rankings.
        let daily_trend = self.request_log_get_daily_trend_for_range(time_range)?;

        Ok(CostStatistics {
            summary,
            top_keys,
            top_providers,
            top_projects,
            top_models,
            daily_trend,
        })
    }

    pub fn request_log_get_recent_paginated(
        &self,
        time_range: &str,
        page: i64,
        page_size: i64,
    ) -> Result<PaginatedRecentRequests, rusqlite::Error> {
        let page = page.max(1);
        let page_size = page_size.max(1).min(100);
        let offset = (page - 1) * page_size;
        let where_clause =
            self.billable_request_logs_where_with_alias("r", "r.created_at", time_range);

        let total: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 {}",
                if where_clause.is_empty() {
                    ""
                } else {
                    &where_clause
                }
            ),
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
                        r.total_cost_usd, r.input_tokens, r.output_tokens,
                        r.cache_read_tokens, r.cache_creation_tokens,
                        r.latency_ms, r.status_code, r.created_at
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
                 {} ORDER BY r.created_at DESC LIMIT ?1 OFFSET ?2",
            if where_clause.is_empty() {
                ""
            } else {
                &where_clause
            }
        ))?;
        let items: Vec<RecentRequestLogDisplay> = stmt
            .query_map([page_size, offset], |row| {
                Ok(RecentRequestLogDisplay {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    key_alias: row.get(2)?,
                    provider_name: row.get(3)?,
                    project_name: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    input_tokens: row.get(6)?,
                    output_tokens: row.get(7)?,
                    cache_read_tokens: row.get(8)?,
                    cache_creation_tokens: row.get(9)?,
                    latency_ms: row.get(10)?,
                    status_code: row.get(11)?,
                    created_at: row.get(12)?,
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

    pub fn request_log_get_dashboard_stats(&self) -> Result<DashboardCostStats, rusqlite::Error> {
        self.request_log_get_dashboard_stats_by_metric("cost")
    }

    pub fn request_log_get_dashboard_stats_by_metric(
        &self,
        metric: &str,
    ) -> Result<DashboardCostStats, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let created_date = Self::local_date_expr("created_at");
        let ranking_expression = if metric == "tokens" {
            "SUM(r.input_tokens + r.output_tokens)"
        } else {
            "SUM(r.total_cost_usd)"
        };

        let today_cost: f64 = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs
                 WHERE {} = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)",
                created_date
            ),
            [&today],
            |row| row.get(0),
        )?;

        let total_cost: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs
             WHERE input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0",
            [],
            |row| row.get(0),
        )?;

        let today_requests: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM request_logs
                 WHERE {} = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)",
                created_date
            ),
            [&today],
            |row| row.get(0),
        )?;

        let today_tokens: i64 = self.conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM request_logs
                 WHERE {} = ?1
                   AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0)",
                created_date
            ),
            [&today],
            |row| row.get(0),
        )?;

        let total_tokens: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM request_logs
             WHERE input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_creation_tokens > 0",
            [],
            |row| row.get(0),
        )?;

        let weekly_trend = self.request_log_get_daily_trend(7)?;

        // Top keys (all time, limit 5)
        let mut stmt = self.conn.prepare(&format!(
            "SELECT r.api_key_id, COALESCE(r.key_alias, k.alias, ''), COALESCE(r.provider_name, p.name, ''),
                    SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
             FROM request_logs r
             LEFT JOIN api_keys k ON r.api_key_id = k.id
             LEFT JOIN providers p ON r.provider_id = p.id
             WHERE r.input_tokens > 0 OR r.output_tokens > 0 OR r.cache_read_tokens > 0 OR r.cache_creation_tokens > 0
             GROUP BY r.api_key_id ORDER BY {} DESC LIMIT 5",
            ranking_expression
        ))?;
        let top_keys: Vec<TopKeyCostItem> = stmt
            .query_map([], |row| {
                Ok(TopKeyCostItem {
                    key_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    key_alias: row.get(1)?,
                    provider_name: row.get(2)?,
                    total_cost: row.get(3)?,
                    total_requests: row.get(4)?,
                    total_tokens: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Top projects (all time, limit 5)
        let mut stmt = self.conn.prepare(&format!(
            "SELECT
                    CASE
                        WHEN r.project_id IS NOT NULL THEN r.project_id
                        WHEN ps.cli_type IS NOT NULL THEN '__client__' || ps.cli_type
                        ELSE '__other__'
                    END,
                    COALESCE(
                        r.project_name,
                        pr.name,
                        CASE ps.cli_type
                            WHEN 'codex-app' THEN 'Codex Desktop'
                            WHEN 'claude_desktop' THEN 'Claude Desktop'
                            ELSE NULL
                        END,
                        'Other'
                    ),
                    SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
             FROM request_logs r
             LEFT JOIN projects pr ON r.project_id = pr.id
             LEFT JOIN proxy_sessions ps ON r.session_id = ps.session_token
             WHERE r.input_tokens > 0 OR r.output_tokens > 0 OR r.cache_read_tokens > 0 OR r.cache_creation_tokens > 0
             GROUP BY 1, 2 ORDER BY {} DESC LIMIT 5",
            ranking_expression
        ))?;
        let top_projects: Vec<TopProjectCostItem> = stmt
            .query_map([], |row| {
                Ok(TopProjectCostItem {
                    project_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    project_name: row.get(1)?,
                    total_cost: row.get(2)?,
                    total_requests: row.get(3)?,
                    total_tokens: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(DashboardCostStats {
            today_cost,
            total_cost,
            today_requests,
            today_tokens,
            total_tokens,
            weekly_trend,
            top_keys,
            top_projects,
        })
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

    /// Recalculate and update costs for all request_logs using current default + custom pricing.
    /// Returns the count of rows updated.
    pub fn request_log_repair_costs(&self) -> Result<i64, rusqlite::Error> {
        let custom_pricing: std::collections::HashMap<String, crate::models::ModelPricing> = self
            .settings_get_value("customModelPricing")
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let mut stmt = self.conn.prepare(
            "SELECT id, model, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, cost_multiplier
             FROM request_logs WHERE model IS NOT NULL",
        )?;

        let rows: Vec<(String, String, i64, i64, i64, i64, f64)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut updated = 0i64;
        for (id, model, input, output, cache_read, cache_creation, multiplier) in rows {
            let (input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost) =
                crate::services::cost_calculator::calculate_cost(
                    &model,
                    input,
                    output,
                    cache_read,
                    cache_creation,
                    multiplier,
                    &custom_pricing,
                );

            self.conn.execute(
                "UPDATE request_logs SET input_cost_usd = ?1, output_cost_usd = ?2,
                        cache_read_cost_usd = ?3, cache_creation_cost_usd = ?4,
                        total_cost_usd = ?5 WHERE id = ?6",
                rusqlite::params![
                    input_cost,
                    output_cost,
                    cache_read_cost,
                    cache_creation_cost,
                    total_cost,
                    id,
                ],
            )?;
            updated += 1;
        }

        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ProxySession;

    fn mk_billable_log(id: &str, created_at: String, total_cost_usd: f64) -> RequestLog {
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
            input_cost_usd: 0.01,
            output_cost_usd: 0.02,
            cache_read_cost_usd: 0.0,
            cache_creation_cost_usd: 0.0,
            total_cost_usd,
            cost_multiplier: 1.0,
            latency_ms: Some(100),
            first_token_ms: None,
            status_code: Some(200),
            error_message: None,
            is_streaming: false,
            created_at,
            key_alias: Some("codex-key".into()),
            provider_name: Some("codex-provider".into()),
            project_name: Some("Codex Desktop".into()),
        }
    }

    #[test]
    fn cleanup_removes_old_logs() {
        let db = Database::new_in_memory().unwrap();

        fn mk_log(id: &str, created_at: String) -> RequestLog {
            RequestLog {
                id: id.into(),
                provider_id: None,
                api_key_id: None,
                project_id: None,
                session_id: None,
                model: None,
                request_model: None,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                input_cost_usd: 0.0,
                output_cost_usd: 0.0,
                cache_read_cost_usd: 0.0,
                cache_creation_cost_usd: 0.0,
                total_cost_usd: 0.0,
                cost_multiplier: 1.0,
                latency_ms: None,
                first_token_ms: None,
                status_code: None,
                error_message: None,
                is_streaming: false,
                created_at,
                key_alias: None,
                provider_name: None,
                project_name: None,
            }
        }

        let old_log = mk_log(
            "old-1",
            (chrono::Utc::now() - chrono::Duration::days(100)).to_rfc3339(),
        );
        db.request_log_create(&old_log).unwrap();

        let recent_log = mk_log("recent-1", chrono::Utc::now().to_rfc3339());
        db.request_log_create(&recent_log).unwrap();

        let deleted = db.request_log_cleanup_old(90).unwrap();
        assert!(deleted >= 1);

        let remaining = db.request_log_list_all().unwrap();
        let has_recent = remaining.iter().any(|r| r.id == "recent-1");
        let has_old = remaining.iter().any(|r| r.id == "old-1");
        assert!(has_recent);
        assert!(!has_old);
    }

    #[test]
    fn dashboard_today_cost_uses_local_day_for_utc_logs() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Local::now();
        let today_log =
            mk_billable_log("today", now.with_timezone(&chrono::Utc).to_rfc3339(), 0.03);
        let yesterday_log = mk_billable_log(
            "yesterday",
            (now - chrono::Duration::days(1))
                .with_timezone(&chrono::Utc)
                .to_rfc3339(),
            9.99,
        );

        db.request_log_create(&today_log).unwrap();
        db.request_log_create(&yesterday_log).unwrap();

        let stats = db.request_log_get_dashboard_stats().unwrap();
        assert!((stats.today_cost - 0.03).abs() < 1e-6);
        assert_eq!(stats.today_requests, 1);
        assert_eq!(stats.today_tokens, 30);
        assert_eq!(stats.total_tokens, 60);
        assert_eq!(
            stats
                .weekly_trend
                .iter()
                .find(|item| item.date == now.format("%Y-%m-%d").to_string())
                .map(|item| item.tokens),
            Some(30)
        );
    }

    #[test]
    fn cost_stats_today_uses_local_day_for_utc_logs() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Local::now();

        db.request_log_create(&mk_billable_log(
            "today",
            now.with_timezone(&chrono::Utc).to_rfc3339(),
            0.03,
        ))
        .unwrap();
        db.request_log_create(&mk_billable_log(
            "yesterday",
            (now - chrono::Duration::days(1))
                .with_timezone(&chrono::Utc)
                .to_rfc3339(),
            9.99,
        ))
        .unwrap();

        let stats = db.request_log_get_cost_stats().unwrap();
        assert!((stats["todayCost"].as_f64().unwrap() - 0.03).abs() < 1e-6);
    }

    #[test]
    fn cost_statistics_labels_codex_app_without_project_as_client_source() {
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

        let log = RequestLog {
            id: "log-1".into(),
            provider_id: None,
            api_key_id: None,
            project_id: None,
            session_id: Some(session.session_token),
            model: Some("gpt-5.5".into()),
            request_model: Some("gpt-5.5".into()),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            input_cost_usd: 0.01,
            output_cost_usd: 0.02,
            cache_read_cost_usd: 0.0,
            cache_creation_cost_usd: 0.0,
            total_cost_usd: 0.03,
            cost_multiplier: 1.0,
            latency_ms: Some(100),
            first_token_ms: None,
            status_code: Some(200),
            error_message: None,
            is_streaming: false,
            created_at: chrono::Utc::now().to_rfc3339(),
            key_alias: Some("codex-key".into()),
            provider_name: Some("codex-provider".into()),
            project_name: None,
        };
        db.request_log_create(&log).unwrap();

        let stats = db.request_log_get_cost_statistics("all").unwrap();
        assert_eq!(stats.top_projects.len(), 1);
        assert_eq!(stats.top_projects[0].project_id, "__client__codex-app");
        assert_eq!(stats.top_projects[0].project_name, "Codex Desktop");

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(
            recent.items[0].project_name.as_deref(),
            Some("Codex Desktop")
        );
    }

    #[test]
    fn cost_statistics_labels_claude_desktop_without_project_as_client_source() {
        let db = Database::new_in_memory().unwrap();

        let session = ProxySession {
            session_token: "session-claude-desktop".into(),
            provider_id: "provider-1".into(),
            api_key_id: "key-1".into(),
            project_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            session_kind: "desktop".into(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            revoked_at: None,
            revoked_reason: None,
            cli_type: Some("claude_desktop".into()),
        };
        db.proxy_session_create(&session).unwrap();

        let log = RequestLog {
            id: "log-1".into(),
            provider_id: None,
            api_key_id: None,
            project_id: None,
            session_id: Some(session.session_token),
            model: Some("claude-sonnet-4".into()),
            request_model: Some("claude-sonnet-4".into()),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            input_cost_usd: 0.01,
            output_cost_usd: 0.02,
            cache_read_cost_usd: 0.0,
            cache_creation_cost_usd: 0.0,
            total_cost_usd: 0.03,
            cost_multiplier: 1.0,
            latency_ms: Some(100),
            first_token_ms: None,
            status_code: Some(200),
            error_message: None,
            is_streaming: false,
            created_at: chrono::Utc::now().to_rfc3339(),
            key_alias: Some("desktop-key".into()),
            provider_name: Some("desktop-provider".into()),
            project_name: None,
        };
        db.request_log_create(&log).unwrap();

        let stats = db.request_log_get_cost_statistics("all").unwrap();
        assert_eq!(stats.top_projects.len(), 1);
        assert_eq!(stats.top_projects[0].project_id, "__client__claude_desktop");
        assert_eq!(stats.top_projects[0].project_name, "Claude Desktop");

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(
            recent.items[0].project_name.as_deref(),
            Some("Claude Desktop")
        );
    }

    #[test]
    fn cost_statistics_ignore_zero_usage_request_logs() {
        let db = Database::new_in_memory().unwrap();

        fn mk_log(id: &str, input_tokens: i64, output_tokens: i64) -> RequestLog {
            RequestLog {
                id: id.into(),
                provider_id: None,
                api_key_id: None,
                project_id: None,
                session_id: None,
                model: Some("gpt-5.5".into()),
                request_model: Some("gpt-5.5".into()),
                input_tokens,
                output_tokens,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                input_cost_usd: if input_tokens > 0 { 0.01 } else { 0.0 },
                output_cost_usd: if output_tokens > 0 { 0.02 } else { 0.0 },
                cache_read_cost_usd: 0.0,
                cache_creation_cost_usd: 0.0,
                total_cost_usd: if input_tokens > 0 || output_tokens > 0 {
                    0.03
                } else {
                    0.0
                },
                cost_multiplier: 1.0,
                latency_ms: Some(100),
                first_token_ms: None,
                status_code: Some(200),
                error_message: None,
                is_streaming: false,
                created_at: chrono::Utc::now().to_rfc3339(),
                key_alias: Some("codex-key".into()),
                provider_name: Some("codex-provider".into()),
                project_name: Some("Codex Desktop".into()),
            }
        }

        db.request_log_create(&mk_log("models-request", 0, 0))
            .unwrap();
        db.request_log_create(&mk_log("real-response", 10, 20))
            .unwrap();

        let stats = db.request_log_get_cost_statistics("all").unwrap();
        assert_eq!(stats.summary.total_requests, 1);
        assert_eq!(stats.summary.total_input_tokens, 10);
        assert_eq!(stats.summary.total_output_tokens, 20);
        assert_eq!(stats.top_models.len(), 1);
        assert_eq!(stats.top_models[0].total_requests, 1);

        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(recent.total, 1);
        assert_eq!(recent.items.len(), 1);
        assert_eq!(recent.items[0].id, "real-response");
    }

    #[test]
    fn statistics_rankings_follow_selected_metric() {
        let db = Database::new_in_memory().unwrap();
        let created_at = chrono::Utc::now().to_rfc3339();

        let mut cost_heavy = mk_billable_log("cost-heavy", created_at.clone(), 10.0);
        cost_heavy.model = Some("cost-heavy-model".into());
        cost_heavy.input_tokens = 10;
        cost_heavy.output_tokens = 10;

        let mut token_heavy = mk_billable_log("token-heavy", created_at, 0.01);
        token_heavy.model = Some("token-heavy-model".into());
        token_heavy.input_tokens = 10_000;
        token_heavy.output_tokens = 20_000;

        db.request_log_create(&cost_heavy).unwrap();
        db.request_log_create(&token_heavy).unwrap();

        let cost_stats = db.request_log_get_statistics("all", "cost").unwrap();
        let token_stats = db.request_log_get_statistics("all", "tokens").unwrap();
        let unknown_stats = db.request_log_get_statistics("all", "requests").unwrap();

        assert_eq!(cost_stats.top_models[0].model, "cost-heavy-model");
        assert_eq!(token_stats.top_models[0].model, "token-heavy-model");
        assert_eq!(unknown_stats.top_models[0].model, "cost-heavy-model");
        assert_eq!(
            token_stats.daily_trend.last().map(|day| day.tokens),
            Some(30_020)
        );
    }

    #[test]
    fn statistics_trend_uses_the_selected_time_range() {
        let db = Database::new_in_memory().unwrap();
        let now = chrono::Local::now();

        db.request_log_create(&mk_billable_log(
            "today",
            now.with_timezone(&chrono::Utc).to_rfc3339(),
            0.03,
        ))
        .unwrap();
        db.request_log_create(&mk_billable_log(
            "older",
            (now - chrono::Duration::days(10))
                .with_timezone(&chrono::Utc)
                .to_rfc3339(),
            0.04,
        ))
        .unwrap();

        let today = db.request_log_get_statistics("today", "tokens").unwrap();
        let all = db.request_log_get_statistics("all", "tokens").unwrap();

        assert_eq!(today.summary.total_requests, 1);
        assert_eq!(today.daily_trend.len(), 1);
        assert_eq!(today.daily_trend[0].requests, 1);
        assert_eq!(all.summary.total_requests, 2);
        assert_eq!(all.daily_trend.len(), 2);
    }

    #[test]
    fn cache_only_usage_counts_as_a_request_but_not_as_main_tokens() {
        let db = Database::new_in_memory().unwrap();
        let mut cache_only = mk_billable_log("cache-only", chrono::Utc::now().to_rfc3339(), 0.05);
        cache_only.input_tokens = 0;
        cache_only.output_tokens = 0;
        cache_only.cache_read_tokens = 1_000;
        cache_only.cache_read_cost_usd = 0.05;

        db.request_log_create(&cache_only).unwrap();

        let stats = db.request_log_get_statistics("all", "tokens").unwrap();
        let dashboard = db
            .request_log_get_dashboard_stats_by_metric("tokens")
            .unwrap();

        assert_eq!(stats.summary.total_requests, 1);
        assert_eq!(stats.summary.total_cache_read_tokens, 1_000);
        assert!((stats.summary.total_cache_cost_usd - 0.05).abs() < 1e-6);
        assert_eq!(stats.daily_trend[0].tokens, 0);
        assert!((stats.daily_trend[0].cost - 0.05).abs() < 1e-6);
        let recent = db.request_log_get_recent_paginated("all", 1, 10).unwrap();
        assert_eq!(recent.items[0].cache_read_tokens, 1_000);
        assert_eq!(recent.items[0].cache_creation_tokens, 0);
        assert_eq!(dashboard.today_requests, 1);
        assert_eq!(dashboard.today_tokens, 0);
        assert_eq!(dashboard.total_tokens, 0);
    }
}
