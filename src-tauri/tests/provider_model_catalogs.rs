mod support;
use cc_use_lib::commands::providers::{
    provider_model_catalog_query_inner, ProviderModelCatalogQueryInput,
};
use cc_use_lib::db::Database;
use cc_use_lib::models::GatewayConnectionConfig;
use cc_use_lib::shared_runtime::model_mapping::ClientModel;
use std::sync::{Arc, Mutex};
use support::TempDb;

fn model(id: &str) -> ClientModel {
    ClientModel {
        id: id.into(),
        display_name: format!("Name {id}"),
        supports1m: true,
    }
}

#[test]
fn provider_catalog_round_trip_revision_conflict_and_independent_key_configuration() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "catalog-provider", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    let before = serde_json::to_value(fixture.db.api_key_get(&key.id).unwrap()).unwrap();
    assert_eq!(
        fixture
            .db
            .provider_model_catalog_get(&provider.id)
            .unwrap()
            .revision,
        0
    );
    let saved = fixture
        .db
        .provider_model_catalog_save(&provider.id, &[model("one"), model("one"), model("two")], 0)
        .unwrap();
    assert_eq!(saved.models.len(), 2);
    assert_eq!(saved.revision, 1);
    assert!(saved.models[0].supports1m);
    assert_eq!(saved.models[0].display_name, "Name one");
    assert!(fixture
        .db
        .provider_model_catalog_save(&provider.id, &[], 0)
        .unwrap_err()
        .contains("changed"));
    let reopened =
        Database::open_at(std::path::Path::new(fixture.db.conn.path().unwrap())).unwrap();
    let reloaded = reopened.provider_model_catalog_get(&provider.id).unwrap();
    assert_eq!(reloaded.models[0].id, "one");
    assert_eq!(reloaded.revision, 1);
    reopened
        .provider_model_catalog_save(&provider.id, &[], 1)
        .unwrap();
    assert_eq!(
        serde_json::to_value(fixture.db.api_key_get(&key.id).unwrap()).unwrap(),
        before
    );
    assert!(fixture
        .db
        .provider_model_catalog_get(&provider.id)
        .unwrap()
        .models
        .is_empty());
    fixture.db.provider_delete(&provider.id).unwrap();
    assert_eq!(
        fixture
            .db
            .conn
            .query_row("SELECT COUNT(*) FROM provider_model_catalogs", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn provider_catalog_validation_does_not_overwrite_saved_models() {
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    fixture
        .db
        .provider_model_catalog_save(&provider.id, &[model("good")], 0)
        .unwrap();
    for id in ["", "https://example.test/model", "bad id", "x\ny"] {
        assert!(fixture
            .db
            .provider_model_catalog_save(&provider.id, &[model(id)], 1)
            .is_err());
    }
    assert_eq!(
        fixture
            .db
            .provider_model_catalog_get(&provider.id)
            .unwrap()
            .models[0]
            .id,
        "good"
    );
}

#[tokio::test]
async fn independent_query_uses_saved_credentials_and_explicit_connection_without_writes() {
    use axum::{http::HeaderMap, routing::get, Router};
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let app = Router::new().route(
        "/relay/v1/models",
        get(move |headers: HeaderMap| {
            let capture = capture.clone();
            async move {
                *capture.lock().unwrap() = Some(headers);
                axum::Json(
                    serde_json::json!({"data":[{"id":"actual","display_name":"Actual model"}]}),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let fixture = TempDb::new();
    let provider = support::create_provider(&fixture.db, "p", "custom");
    let key = support::create_api_key(&fixture.db, &provider.id, "claude_code");
    fixture.db.conn.execute("UPDATE api_keys SET client_configs=?1 WHERE id=?2",rusqlite::params![r#"{"claude_code":{"baseUrl":"https://must-not-use.invalid","proxyUserAgent":"wrong"}}"#,key.id]).unwrap();
    let db = Arc::new(Mutex::new(
        Database::open_at(std::path::Path::new(fixture.db.conn.path().unwrap())).unwrap(),
    ));
    let before = serde_json::to_value(db.lock().unwrap().api_key_get(&key.id).unwrap()).unwrap();
    let result = provider_model_catalog_query_inner(
        &db,
        ProviderModelCatalogQueryInput {
            provider_id: provider.id.clone(),
            api_key_id: key.id.clone(),
            connection_config: GatewayConnectionConfig {
                base_url: Some(format!("http://127.0.0.1:{port}/relay")),
                auth_scheme: "x-api-key".into(),
                user_agent: Some("independent/1".into()),
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(result.models[0].id, "actual");
    let headers = captured.lock().unwrap().clone().unwrap();
    assert_eq!(headers["x-api-key"], key.value);
    assert!(!headers.contains_key("authorization"));
    assert_eq!(headers["user-agent"], "independent/1");
    let db = db.lock().unwrap();
    assert_eq!(
        serde_json::to_value(db.api_key_get(&key.id).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        db.provider_model_catalog_get(&provider.id)
            .unwrap()
            .revision,
        0
    );
    task.abort();
}
