use crate::{
    db::Database,
    models::{ApiKey, Provider},
    shared_runtime::{model_mapping, user_agent},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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

fn cache_key(
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    agent: Option<&str>,
    headers: &BTreeMap<String, String>,
) -> String {
    let route = crate::commands::providers::model_list_upstream_settings(provider, key, Some(kind));
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
    request_headers: Option<&reqwest::header::HeaderMap>,
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

async fn load_catalog(
    db: &Arc<Mutex<Database>>,
    provider: &Provider,
    key: &ApiKey,
    kind: &str,
    prefer_cache: bool,
    request_headers: Option<&reqwest::header::HeaderMap>,
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
    match crate::commands::providers::fetch_provider_model_catalog(
        provider,
        key,
        Some(kind),
        ua.as_deref(),
        Some(&headers),
    )
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
    request_headers: Option<&reqwest::header::HeaderMap>,
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
