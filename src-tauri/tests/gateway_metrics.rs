mod support;

use cc_use_lib::models::GatewayRequestEvent;
use support::TempDb;

fn event(id: &str, kind: &str, status_code: Option<i32>, latency_ms: i64) -> GatewayRequestEvent {
    GatewayRequestEvent {
        id: id.to_string(),
        created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        kind: kind.to_string(),
        method: "POST".to_string(),
        path: "/v1/messages".to_string(),
        status_code,
        latency_ms: Some(latency_ms),
        provider_name: Some("Provider A".to_string()),
        key_alias: Some("Key A".to_string()),
        is_streaming: false,
    }
}

#[test]
fn recent_metrics_aggregate_real_terminal_events() {
    let fixture = TempDb::new();
    fixture
        .db
        .gateway_event_upsert(&event("ok", "ok", Some(200), 10))
        .unwrap();
    fixture
        .db
        .gateway_event_upsert(&event("http-error", "ok", Some(500), 20))
        .unwrap();
    fixture
        .db
        .gateway_event_upsert(&event("network-error", "upstream_error", None, 30))
        .unwrap();
    fixture
        .db
        .gateway_event_upsert(&event("rejected", "rejected", None, 40))
        .unwrap();

    let metrics = fixture.db.gateway_metrics_recent().unwrap();
    let day = metrics
        .windows
        .iter()
        .find(|item| item.window == "day")
        .unwrap();

    assert_eq!(day.total_requests, 4);
    assert_eq!(day.successful_requests, 1);
    assert_eq!(day.upstream_errors, 2);
    assert_eq!(day.rejected_requests, 1);
    assert_eq!(day.active_providers, 1);
    assert_eq!(day.avg_latency_ms, Some(25.0));
    assert_eq!(day.p95_latency_ms, Some(40));
    assert!(day.last_request_at.is_some());
}

#[test]
fn provider_metrics_exclude_local_rejections_from_success_rate() {
    let fixture = TempDb::new();
    fixture
        .db
        .gateway_event_upsert(&event("ok", "ok", Some(200), 10))
        .unwrap();
    fixture
        .db
        .gateway_event_upsert(&event("upstream", "upstream_error", Some(502), 20))
        .unwrap();
    fixture
        .db
        .gateway_event_upsert(&event("local", "rejected", Some(401), 5))
        .unwrap();

    let metrics = fixture.db.gateway_metrics_by_provider().unwrap();
    assert_eq!(metrics.len(), 1);
    assert_eq!(metrics[0].provider_name, "Provider A");
    assert_eq!(metrics[0].total_requests, 2);
    assert_eq!(metrics[0].successful_requests, 1);
    assert_eq!(metrics[0].upstream_errors, 1);
}

#[test]
fn cleanup_removes_events_older_than_thirty_days() {
    let fixture = TempDb::new();
    let mut old = event("old", "ok", Some(200), 10);
    old.created_at = "2020-01-01 00:00:00".to_string();
    fixture.db.gateway_event_upsert(&old).unwrap();

    fixture.db.gateway_event_cleanup().unwrap();

    let count: i64 = fixture
        .db
        .conn
        .query_row("SELECT COUNT(*) FROM gateway_request_events", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
