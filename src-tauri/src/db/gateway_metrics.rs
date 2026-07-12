use crate::db::Database;
use crate::models::{
    GatewayMetricsWindow, GatewayRequestEvent, RecentGatewayMetrics,
};

const MAX_EVENT_ROWS: i64 = 50_000;

impl Database {
    pub fn gateway_event_upsert(
        &self,
        event: &GatewayRequestEvent,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO gateway_request_events
             (id, created_at, kind, method, path, status_code, latency_ms,
              provider_name, key_alias, is_streaming)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                event.id,
                event.created_at,
                event.kind,
                event.method,
                event.path,
                event.status_code,
                event.latency_ms,
                event.provider_name,
                event.key_alias,
                if event.is_streaming { 1 } else { 0 },
            ],
        )?;
        Ok(())
    }

    pub fn gateway_event_cleanup(&self) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM gateway_request_events
             WHERE created_at < datetime('now', '-30 days')",
            [],
        )?;
        self.conn.execute(
            "DELETE FROM gateway_request_events
             WHERE id IN (
               SELECT id FROM gateway_request_events
               ORDER BY created_at DESC
               LIMIT -1 OFFSET ?1
             )",
            [MAX_EVENT_ROWS],
        )?;
        Ok(())
    }

    pub fn gateway_metrics_recent(&self) -> Result<RecentGatewayMetrics, rusqlite::Error> {
        let windows = [
            ("hour", "-1 hour"),
            ("day", "-24 hours"),
            ("week", "-7 days"),
        ]
        .into_iter()
        .map(|(window, modifier)| self.gateway_metrics_window(window, modifier))
        .collect::<Result<Vec<_>, _>>()?;

        Ok(RecentGatewayMetrics { windows })
    }

    fn gateway_metrics_window(
        &self,
        window: &str,
        modifier: &str,
    ) -> Result<GatewayMetricsWindow, rusqlite::Error> {
        let mut summary = self.conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE
                      WHEN kind = 'ws' OR (kind = 'ok' AND status_code BETWEEN 200 AND 399)
                      THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE
                      WHEN kind = 'upstream_error' OR (kind = 'ok' AND status_code >= 400)
                      THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'rejected' THEN 1 ELSE 0 END), 0),
                    COUNT(DISTINCT CASE WHEN provider_name != '' THEN provider_name END),
                    AVG(latency_ms), MAX(created_at)
             FROM gateway_request_events
             WHERE created_at >= datetime('now', ?1)",
            [modifier],
            |row| {
                Ok(GatewayMetricsWindow {
                    window: window.to_string(),
                    total_requests: row.get(0)?,
                    successful_requests: row.get(1)?,
                    upstream_errors: row.get(2)?,
                    rejected_requests: row.get(3)?,
                    active_providers: row.get(4)?,
                    avg_latency_ms: row.get(5)?,
                    p95_latency_ms: None,
                    last_request_at: row.get(6)?,
                })
            },
        )?;

        let mut stmt = self.conn.prepare(
            "SELECT latency_ms FROM gateway_request_events
             WHERE created_at >= datetime('now', ?1) AND latency_ms IS NOT NULL
             ORDER BY latency_ms ASC",
        )?;
        let latencies = stmt
            .query_map([modifier], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if !latencies.is_empty() {
            let index = ((latencies.len() as f64 * 0.95).ceil() as usize)
                .saturating_sub(1)
                .min(latencies.len() - 1);
            summary.p95_latency_ms = Some(latencies[index]);
        }

        Ok(summary)
    }
}
