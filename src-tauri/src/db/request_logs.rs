use crate::db::Database;
use crate::models::{
    CostStatsSummary, TopKeyCostItem, TopProviderCostItem, TopProjectCostItem,
    TopModelCostItem, DailyCostTrendItem, RecentRequestLogDisplay, CostStatistics,
    DashboardCostStats, RequestLog,
};

impl Database {
    pub fn request_log_create(&self, log: &RequestLog) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO request_logs (id, provider_id, api_key_id, project_id, session_id,
                model, request_model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, input_cost_usd, output_cost_usd, cache_read_cost_usd,
                cache_creation_cost_usd, total_cost_usd, cost_multiplier, latency_ms,
                first_token_ms, status_code, error_message, is_streaming, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            rusqlite::params![
                log.id, log.provider_id, log.api_key_id, log.project_id, log.session_id,
                log.model, log.request_model, log.input_tokens, log.output_tokens,
                log.cache_read_tokens, log.cache_creation_tokens,
                log.input_cost_usd, log.output_cost_usd, log.cache_read_cost_usd,
                log.cache_creation_cost_usd, log.total_cost_usd, log.cost_multiplier,
                log.latency_ms, log.first_token_ms, log.status_code, log.error_message,
                if log.is_streaming { 1i32 } else { 0i32 }, log.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn request_log_get_cost_stats(&self) -> Result<serde_json::Value, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let today_cost: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs WHERE DATE(created_at) = ?1",
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

        let mut stmt = self.conn.prepare(
            "SELECT api_key_id,
                    COALESCE(SUM(CASE WHEN DATE(created_at) = ?1 THEN total_cost_usd ELSE 0 END), 0) as today_cost,
                    COALESCE(SUM(total_cost_usd), 0) as total_cost
             FROM request_logs
             WHERE api_key_id IS NOT NULL
             GROUP BY api_key_id"
        )?;

        let rows = stmt.query_map([&today], |row| {
            Ok(serde_json::json!({
                "keyId": row.get::<_, String>(0)?,
                "todayCost": row.get::<_, f64>(1)?,
                "totalCost": row.get::<_, f64>(2)?,
            }))
        })?;

        rows.collect()
    }

    pub fn request_log_get_daily_trend(&self, days: i64) -> Result<Vec<DailyCostTrendItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT DATE(created_at) as d, COALESCE(SUM(total_cost_usd), 0), COUNT(*)
                 FROM request_logs
                 WHERE created_at >= DATE('now', 'localtime', '-{} days')
                 GROUP BY d ORDER BY d ASC",
                days
            )
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DailyCostTrendItem {
                date: row.get(0)?,
                cost: row.get(1)?,
                requests: row.get(2)?,
            })
        })?;

        rows.collect()
    }

    pub fn request_log_get_cost_statistics(&self, time_range: &str) -> Result<CostStatistics, rusqlite::Error> {
        let where_clause = self.time_range_where("created_at", time_range);

        // Summary
        let summary = self.conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
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
                    total_cost_usd: row.get(5)?,
                    avg_latency_ms: row.get(6)?,
                })
            },
        )?;

        // Top keys
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT r.api_key_id, COALESCE(k.alias, ''), COALESCE(p.name, ''),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 {} GROUP BY r.api_key_id ORDER BY SUM(r.total_cost_usd) DESC LIMIT 10",
                if where_clause.is_empty() { "" } else { &where_clause }
            )
        )?;
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
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT r.provider_id, COALESCE(p.name, ''),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN providers p ON r.provider_id = p.id
                 {} GROUP BY r.provider_id ORDER BY SUM(r.total_cost_usd) DESC LIMIT 10",
                if where_clause.is_empty() { "" } else { &where_clause }
            )
        )?;
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

        // Top projects
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT r.project_id, COALESCE(pr.name, 'Unknown'),
                        SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
                 FROM request_logs r
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 {} GROUP BY r.project_id ORDER BY SUM(r.total_cost_usd) DESC LIMIT 10",
                if where_clause.is_empty() { "" } else { &where_clause }
            )
        )?;
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
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT COALESCE(model, 'unknown'), SUM(total_cost_usd), COUNT(*),
                        SUM(input_tokens + output_tokens)
                 FROM request_logs
                 {} GROUP BY model ORDER BY SUM(total_cost_usd) DESC LIMIT 10",
                where_clause
            )
        )?;
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

        // Daily trend
        let daily_trend = self.request_log_get_daily_trend(30)?;

        // Recent requests
        let mut stmt = self.conn.prepare(
            &format!(
                "SELECT r.id, r.model, k.alias, p.name, pr.name,
                        r.total_cost_usd, r.input_tokens, r.output_tokens,
                        r.latency_ms, r.status_code, r.created_at
                 FROM request_logs r
                 LEFT JOIN api_keys k ON r.api_key_id = k.id
                 LEFT JOIN providers p ON r.provider_id = p.id
                 LEFT JOIN projects pr ON r.project_id = pr.id
                 {} ORDER BY r.created_at DESC LIMIT 20",
                if where_clause.is_empty() { "" } else { &where_clause }
            )
        )?;
        let recent_requests: Vec<RecentRequestLogDisplay> = stmt
            .query_map([], |row| {
                Ok(RecentRequestLogDisplay {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    key_alias: row.get(2)?,
                    provider_name: row.get(3)?,
                    project_name: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    input_tokens: row.get(6)?,
                    output_tokens: row.get(7)?,
                    latency_ms: row.get(8)?,
                    status_code: row.get(9)?,
                    created_at: row.get(10)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(CostStatistics {
            summary,
            top_keys,
            top_providers,
            top_projects,
            top_models,
            daily_trend,
            recent_requests,
        })
    }

    pub fn request_log_get_dashboard_stats(&self) -> Result<DashboardCostStats, rusqlite::Error> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let today_cost: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs WHERE DATE(created_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        let total_cost: f64 = self.conn.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM request_logs",
            [],
            |row| row.get(0),
        )?;

        let today_requests: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM request_logs WHERE DATE(created_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        let today_tokens: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM request_logs WHERE DATE(created_at) = ?1",
            [&today],
            |row| row.get(0),
        )?;

        let weekly_trend = self.request_log_get_daily_trend(7)?;

        // Top keys (all time, limit 5)
        let mut stmt = self.conn.prepare(
            "SELECT r.api_key_id, COALESCE(k.alias, ''), COALESCE(p.name, ''),
                    SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
             FROM request_logs r
             LEFT JOIN api_keys k ON r.api_key_id = k.id
             LEFT JOIN providers p ON r.provider_id = p.id
             GROUP BY r.api_key_id ORDER BY SUM(r.total_cost_usd) DESC LIMIT 5"
        )?;
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
        let mut stmt = self.conn.prepare(
            "SELECT r.project_id, COALESCE(pr.name, 'Unknown'),
                    SUM(r.total_cost_usd), COUNT(*), SUM(r.input_tokens + r.output_tokens)
             FROM request_logs r
             LEFT JOIN projects pr ON r.project_id = pr.id
             GROUP BY r.project_id ORDER BY SUM(r.total_cost_usd) DESC LIMIT 5"
        )?;
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
            weekly_trend,
            top_keys,
            top_projects,
        })
    }
}
