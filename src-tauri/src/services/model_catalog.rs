//! Model catalogue discovery shared by the commands and the proxy.
//!
//! This service owns the network implementation (pagination, limits, payload
//! parsing and snapshot conversion). It deliberately does not call into
//! `commands`: a service that depended on a command could not be used by the
//! daemon and would invert the layer direction.

use crate::{
    db::Database,
    models::{ApiKey, Provider},
    shared_runtime::{gateway_connection::GatewayConnection, model_mapping, user_agent},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// What this app calls itself when no User-Agent was chosen for an active
/// catalogue query. Never used to replace a request's inbound User-Agent on
/// plain forwarding.
pub const DEFAULT_MODEL_LIST_USER_AGENT: &str = "cc-use/3.x";

const MAX_CATALOG_PAGES: usize = 10;
const MAX_CATALOG_MODELS: usize = 10_000;
const MAX_CATALOG_PAGE_BYTES: usize = 8 * 1024 * 1024;
const CATALOG_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const CATALOG_PAGE_LIMIT: usize = 1000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub catalog: Value,
    pub fetched_at: String,
    #[serde(default)]
    pub from_cache: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// IPC shape shared by the provider and gateway model-preview commands. The
/// renderer consumes this as `ClientCatalog`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogResult {
    pub models: Vec<model_mapping::ClientModel>,
    pub from_cache: bool,
    pub fetched_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ModelCatalogResult {
    pub fn from_snapshot(snapshot: CatalogSnapshot) -> Self {
        let models = snapshot.catalog["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let id = entry["id"].as_str()?.to_string();
                let display_name = entry["display_name"].as_str().unwrap_or(&id).to_string();
                Some(model_mapping::ClientModel {
                    id,
                    display_name,
                    supports1m: entry["supports1m"].as_bool().unwrap_or(false),
                })
            })
            .collect();
        Self {
            models,
            from_cache: snapshot.from_cache,
            fetched_at: snapshot.fetched_at,
            error: snapshot.error,
        }
    }
}

fn cache_key(
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    agent: Option<&str>,
    headers: &BTreeMap<String, String>,
) -> String {
    let route = model_list_upstream_settings(provider, key, Some(kind));
    let identity = serde_json::json!([
        provider.id,
        key.id,
        kind,
        route,
        key.value,
        key.client_configs
            .as_ref()
            .and_then(|configs| configs.get(kind)),
        provider.http_proxy,
        provider.request_headers,
        agent,
        headers
    ])
    .to_string();
    let hash = Sha256::digest(identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("");
    format!("model-catalog-cache.{}.{}.{hash}", key.id, kind)
}

pub async fn provider_catalog(
    db: &Arc<Mutex<Database>>,
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    prefer_cache: bool,
    request_headers: Option<&axum::http::HeaderMap>,
) -> Result<CatalogSnapshot, String> {
    load_catalog(db, provider, key, kind, prefer_cache, request_headers, true).await
}

/// A draft query can read a matching cache but never persists credentials or
/// replaces the saved route's catalog.
pub async fn preview_catalog(
    db: &Arc<Mutex<Database>>,
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
) -> Result<CatalogSnapshot, String> {
    load_catalog(db, provider, key, kind, false, None, false).await
}

/// Fetch the upstream catalogue for a gateway connection.
///
/// Uses the same header policy as the forwarded request path (gateway auth,
/// provider additive headers, User-Agent priority) instead of any saved
/// `clientConfigs` entry. Read-only: the draft preview never writes the cache.
pub async fn gateway_catalog(
    provider: &Provider,
    connection: &GatewayConnection,
    inbound_headers: Option<&axum::http::HeaderMap>,
) -> Result<CatalogSnapshot, String> {
    let headers = crate::shared_runtime::gateway_connection::build_headers(
        inbound_headers,
        provider,
        connection,
        crate::shared_runtime::gateway_connection::GatewayTraffic::ModelDiscovery,
        Some(DEFAULT_MODEL_LIST_USER_AGENT),
    )?;
    let endpoint = crate::shared_runtime::gateway_connection::join_upstream_path(
        &connection.effective_base_url,
        "/v1/models",
    )?;
    let pairs = crate::shared_runtime::gateway_connection::header_pairs(&headers);
    let catalog = fetch_catalog_pages(&endpoint, connection.http_proxy.as_deref(), &pairs).await?;
    Ok(CatalogSnapshot {
        catalog,
        fetched_at: chrono::Utc::now().to_rfc3339(),
        from_cache: false,
        error: None,
    })
}

async fn load_catalog(
    db: &Arc<Mutex<Database>>,
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    prefer_cache: bool,
    request_headers: Option<&axum::http::HeaderMap>,
    persist: bool,
) -> Result<CatalogSnapshot, String> {
    let request_agent = request_headers
        .and_then(|headers| headers.get("user-agent"))
        .and_then(|value| value.to_str().ok());
    let headers = request_headers
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter_map(|(name, value)| {
            if matches!(
                name.as_str(),
                "authorization"
                    | "x-api-key"
                    | "user-agent"
                    | "host"
                    | "content-length"
                    | "accept-encoding"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "keep-alive"
                    | "proxy-authorization"
                    | "proxy-authenticate"
                    | "te"
                    | "trailer"
                    | "x-request-id"
                    | "x-client-request-id"
                    | "traceparent"
                    | "tracestate"
                    | "baggage"
            ) {
                return None;
            }
            Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    let configured_agent = key
        .client_configs
        .as_ref()
        .and_then(|configs| configs.get(kind))
        .and_then(|config| config.get("proxyUserAgent"))
        .and_then(Value::as_str)
        .filter(|agent| !agent.trim().is_empty());
    let ua = user_agent::validate(configured_agent.or(request_agent))?;
    // SDK diagnostics and ordinary JSON negotiation do not identify another
    // tenant. Keep custom/organisation/beta headers in the cache identity.
    let cache_headers = headers
        .iter()
        .filter(|(name, value)| {
            !name.starts_with("x-stainless-")
                && !matches!(
                    name.as_str(),
                    "accept" | "content-type" | "cache-control" | "pragma"
                )
                && !(name.as_str() == "anthropic-version" && value.as_str() == "2023-06-01")
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let cache_key = cache_key(provider, key, kind, ua.as_deref(), &cache_headers);
    let cached = db
        .lock()
        .map_err(|error| error.to_string())?
        .settings_get_value(&cache_key)
        .map_err(|error| error.to_string())?
        .and_then(|raw| serde_json::from_str::<CatalogSnapshot>(&raw).ok());
    if prefer_cache {
        if let Some(snapshot) = cached.as_ref().filter(|snapshot| {
            chrono::DateTime::parse_from_rfc3339(&snapshot.fetched_at)
                .ok()
                .is_some_and(|time| {
                    (0..300).contains(&chrono::Utc::now().signed_duration_since(time).num_seconds())
                })
        }) {
            return Ok(CatalogSnapshot {
                from_cache: true,
                ..snapshot.clone()
            });
        }
    }
    match fetch_provider_model_catalog(provider, key, Some(kind), ua.as_deref(), Some(&headers))
        .await
    {
        Ok(catalog) => {
            let snapshot = CatalogSnapshot {
                catalog,
                fetched_at: chrono::Utc::now().to_rfc3339(),
                from_cache: false,
                error: None,
            };
            if persist {
                let db = db.lock().map_err(|error| error.to_string())?;
                db.settings_set_value(
                    &cache_key,
                    &serde_json::to_string(&snapshot).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(snapshot)
        }
        Err(error) => cached
            .map(|snapshot| CatalogSnapshot {
                from_cache: true,
                error: Some(error.clone()),
                ..snapshot
            })
            .ok_or(error),
    }
}

pub async fn effective_catalog(
    db: &Arc<Mutex<Database>>,
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    request_headers: Option<&axum::http::HeaderMap>,
) -> Result<CatalogSnapshot, String> {
    let mapping = key.model_mapping.as_deref();
    // Assigned role slots are built from the key alone, so a provider whose
    // model-list endpoint is missing or rejecting credentials still serves a
    // usable menu.
    let role_slots = !model_mapping::client_role_entries(mapping, kind).is_empty();
    if role_slots || model_mapping::catalog_mode(mapping, kind) == "custom" {
        let (catalog, aliases) = model_mapping::effective_catalog_ex(mapping, kind, None)?;
        persist_aliases(db, &key.id, kind, &aliases)?;
        return Ok(CatalogSnapshot {
            catalog,
            fetched_at: chrono::Utc::now().to_rfc3339(),
            from_cache: false,
            error: None,
        });
    }
    let snapshot = provider_catalog(db, provider, key, kind, true, request_headers).await?;
    let (catalog, aliases) =
        model_mapping::effective_catalog_ex(mapping, kind, Some(&snapshot.catalog))?;
    persist_aliases(db, &key.id, kind, &aliases)?;
    Ok(CatalogSnapshot {
        catalog,
        ..snapshot
    })
}

/// The alias table is written whenever the served catalog is generated, so the
/// request path can decode a picked id without re-deriving the whole list.
fn persist_aliases(
    db: &Arc<Mutex<Database>>,
    api_key_id: &str,
    kind: &str,
    aliases: &model_mapping::AliasTable,
) -> Result<(), String> {
    if aliases.is_empty() {
        return Ok(());
    }
    let value = serde_json::to_string(aliases).map_err(|error| error.to_string())?;
    db.lock()
        .map_err(|error| error.to_string())?
        .settings_set_value(&model_mapping::alias_table_key(api_key_id, kind), &value)
        .map_err(|error| error.to_string())
}

/// Fetch the real model ids exposed by a provider. Passing a client kind makes
/// sure multi-client keys use that client's base URL and auth settings instead
/// of whichever type happens to be first in the stored array.
///
/// `user_agent` arrives already validated; it replaces the default rather than
/// joining it, because a gateway that answers only known clients is matching
/// the whole value.
pub(crate) async fn fetch_provider_model_catalog(
    provider: &Provider,
    api_key: &ApiKey,
    client_kind: Option<&str>,
    user_agent: Option<&str>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<Value, String> {
    let (base_url, auth_scheme) = model_list_upstream_settings(provider, api_key, client_kind);
    let endpoint = build_model_list_endpoint(&base_url)?;

    let mut pairs = vec![(
        "User-Agent".to_string(),
        user_agent
            .unwrap_or(DEFAULT_MODEL_LIST_USER_AGENT)
            .to_string(),
    )];
    let mut extra_headers = request_headers.cloned().unwrap_or_default();
    for (name, value) in
        crate::shared_runtime::request_headers::parse(provider.request_headers.as_deref())
    {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "x-api-key" | "user-agent" | "host" | "content-length"
        ) {
            extra_headers
                .entry(name.to_ascii_lowercase())
                .or_insert_with(|| {
                    crate::shared_runtime::request_headers::resolve(&value, &base_url)
                });
        }
    }
    let kind = client_kind.or_else(|| api_key.types.first().map(String::as_str));
    if matches!(kind, Some("claude" | "claude_code" | "claude_desktop")) {
        extra_headers
            .entry("anthropic-version".into())
            .or_insert_with(|| "2023-06-01".into());
    }
    for (name, value) in extra_headers {
        pairs.push((name, value));
    }
    match auth_scheme.as_str() {
        "bearer" => pairs.push((
            "Authorization".to_string(),
            format!("Bearer {}", api_key.value),
        )),
        "x-api-key" => pairs.push(("x-api-key".to_string(), api_key.value.clone())),
        "none" => {}
        _ => return Err("Unsupported authentication scheme".to_string()),
    }

    fetch_catalog_pages(&endpoint, provider.http_proxy.as_deref(), &pairs).await
}

pub(crate) async fn fetch_provider_model_ids(
    provider: &Provider,
    api_key: &ApiKey,
    client_kind: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Vec<String>, String> {
    let catalog =
        fetch_provider_model_catalog(provider, api_key, client_kind, user_agent, None).await?;
    let mut ids = catalog["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Read every page of an OpenAI-style `/models` response.
///
/// Caps are part of the contract: 10 pages, 10,000 models, 8 MiB per page and a
/// 15 second request timeout. An empty `data` array is a valid empty catalogue,
/// not a failure; only a missing `data` array (or an unreadable/invalid
/// payload) is an error. IDs are de-duplicated across pages.
async fn fetch_catalog_pages(
    endpoint: &str,
    http_proxy: Option<&str>,
    headers: &[(String, String)],
) -> Result<Value, String> {
    let client = crate::services::http_client::outbound_client_builder_for_proxy(http_proxy)?
        .timeout(CATALOG_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut entries: Vec<Value> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::HashSet::new();
    for _ in 0..MAX_CATALOG_PAGES {
        let mut request = client
            .get(endpoint)
            .query(&[("limit", CATALOG_PAGE_LIMIT.to_string())]);
        if let Some(cursor) = &cursor {
            request = request.query(&[("after_id", cursor)]);
        }
        for (name, value) in headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("Failed to fetch models: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Model discovery returned {}", response.status()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Failed to read model catalog: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_PAGE_BYTES {
                return Err("供应商模型目录超出大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Failed to parse model catalog: {error}"))?;
        let models = body["data"]
            .as_array()
            .ok_or("供应商模型目录缺少 data 数组")?;
        if entries.len().saturating_add(models.len()) > MAX_CATALOG_MODELS {
            return Err("供应商模型目录超出模型数量限制".into());
        }
        for model in models {
            let Some(id) = model["id"].as_str().filter(|id| !id.trim().is_empty()) else {
                continue;
            };
            if seen_ids.insert(id.to_string()) {
                entries.push(model.clone());
            }
        }
        if body["has_more"].as_bool() != Some(true) {
            let mut result = body;
            result["data"] = Value::Array(entries);
            result["has_more"] = Value::Bool(false);
            return Ok(result);
        }
        let next = body["last_id"]
            .as_str()
            .or_else(|| models.last().and_then(|model| model["id"].as_str()))
            .filter(|id| !id.is_empty())
            .ok_or("供应商分页模型目录缺少游标")?
            .to_string();
        if !cursors.insert(next.clone()) {
            return Err("供应商模型目录分页重复".to_string());
        }
        cursor = Some(next);
    }
    Err("供应商模型目录超出分页读取限制".to_string())
}

pub(crate) fn model_list_upstream_settings(
    provider: &Provider,
    api_key: &ApiKey,
    requested_client_kind: Option<&str>,
) -> (String, String) {
    let client_kind = requested_client_kind.unwrap_or_else(|| {
        api_key
            .types
            .first()
            .map(String::as_str)
            .unwrap_or("claude_code")
    });
    let client_config = api_key
        .client_configs
        .as_ref()
        .and_then(|configs| configs.get(client_kind));
    let base_url = client_config
        .and_then(|config| config.get("baseUrl"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&provider.base_url)
        .to_string();
    let auth_scheme = client_config
        .and_then(|config| config.get("authScheme"))
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "bearer" | "x-api-key" | "none"))
        .unwrap_or_else(|| match client_kind {
            "codex" | "grok" => "bearer",
            _ => "x-api-key",
        })
        .to_string();

    (base_url, auth_scheme)
}

/// Add a single `/v1/models` to a saved provider/client Base URL without
/// duplicating an existing `/v1`. Built-in client behaviour is pinned by
/// `model_list_upstream_settings`; the gateway path uses
/// `shared_runtime::gateway_connection::join_upstream_path` instead.
pub(crate) fn build_model_list_endpoint(base_url: &str) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base_url).map_err(|_| "Invalid provider base URL".to_string())?;
    if parsed.host_str().is_none() {
        return Err("Invalid provider base URL".to_string());
    }

    if parsed.path().ends_with("/v1") {
        Ok(format!("{}/models", base_url))
    } else {
        Ok(format!("{}/v1/models", base_url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_provider() -> Provider {
        Provider {
            request_headers: None,
            wallet_balance_script: None,
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            base_url: "https://provider.example.com/v1".to_string(),
            http_proxy: None,
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: "none".to_string(),
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            cached_wallet_balance: None,
            cached_wallet_balance_currency: None,
            last_balance_checked_at: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            is_active: true,
            sort_order: 0,
            preset_id: "custom".to_string(),
            default_key_config: None,
            request_adapter: "none".to_string(),
        }
    }

    fn test_key(client_kind: &str, client_configs: Option<serde_json::Value>) -> ApiKey {
        ApiKey {
            usage_script: None,
            id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            alias: None,
            value: "sk-test".to_string(),
            types: vec![client_kind.to_string()],
            priority: 0,
            is_exhausted: false,
            is_active: true,
            config: None,
            usage_type: "none".to_string(),
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            cached_usage: None,
            last_usage_checked_at: None,
            model_mapping: None,
            client_configs,
        }
    }

    #[test]
    fn model_list_uses_selected_keys_upstream_settings() {
        let provider = test_provider();
        let key = test_key(
            "claude_code",
            Some(serde_json::json!({
                "claude_code": {
                    "baseUrl": "https://key.example.com/api/v1",
                    "authScheme": "bearer"
                }
            })),
        );

        assert_eq!(
            model_list_upstream_settings(&provider, &key, None),
            (
                "https://key.example.com/api/v1".to_string(),
                "bearer".to_string()
            )
        );
    }

    #[test]
    fn model_list_uses_clients_default_auth_when_key_has_no_override() {
        let provider = test_provider();

        assert_eq!(
            model_list_upstream_settings(&provider, &test_key("claude_code", None), None).1,
            "x-api-key"
        );
        assert_eq!(
            model_list_upstream_settings(&provider, &test_key("codex", None), None).1,
            "bearer"
        );
    }

    #[test]
    fn requested_client_kind_wins_for_multi_client_keys() {
        let provider = test_provider();
        let mut key = test_key("claude_code", None);
        key.types.push("codex".to_string());
        key.client_configs = Some(serde_json::json!({
            "claude_code": {
                "baseUrl": "https://anthropic.example.com",
                "authScheme": "x-api-key"
            },
            "codex": {
                "baseUrl": "https://responses.example.com/v1",
                "authScheme": "bearer"
            }
        }));

        assert_eq!(
            model_list_upstream_settings(&provider, &key, Some("codex")),
            (
                "https://responses.example.com/v1".to_string(),
                "bearer".to_string()
            )
        );
    }

    #[test]
    fn model_list_endpoint_does_not_duplicate_v1() {
        assert_eq!(
            build_model_list_endpoint("https://example.com").unwrap(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            build_model_list_endpoint("https://example.com/v1").unwrap(),
            "https://example.com/v1/models"
        );
        assert_eq!(
            build_model_list_endpoint("https://example.com/api/v1/").unwrap(),
            "https://example.com/api/v1/models"
        );
    }

    #[test]
    fn catalog_result_maps_models_and_keeps_the_existing_shape() {
        let snapshot = CatalogSnapshot {
            catalog: serde_json::json!({
                "data": [
                    {"id": "m1"},
                    {"id": "m2", "display_name": "Model 2", "supports1m": true},
                    {"display_name": "no id"}
                ]
            }),
            fetched_at: "2026-10-28T00:00:00Z".to_string(),
            from_cache: false,
            error: None,
        };
        let result = ModelCatalogResult::from_snapshot(snapshot);
        assert_eq!(result.models.len(), 2);
        assert_eq!(result.models[1].id, "m2");
        assert_eq!(result.models[1].display_name, "Model 2");
        assert!(result.models[1].supports1m);
        assert!(!result.from_cache);
        let serialized = serde_json::to_value(&result).unwrap();
        assert!(serialized.get("fetchedAt").is_some());
        assert!(serialized.get("fromCache").is_some());
        assert!(
            serialized.get("error").is_none(),
            "error is omitted when absent, matching ClientCatalog"
        );
    }
}
