//! Client catalogs and gateway forwarding are independent per launchpad.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn client_key(kind: &str) -> &str {
    match kind {
        "claude" | "claude_code" => "claude_code",
        "codex-app" | "codex" => "codex",
        other => other,
    }
}

pub fn remove_retired_rules(value: &mut Value) -> bool {
    let mut changed = false;
    if let Some(object) = value.as_object_mut() {
        changed |= object.remove("modelOverrides").is_some();
        if let Some(clients) = object.get_mut("clients").and_then(Value::as_object_mut) {
            for client in clients.values_mut() {
                if let Some(upstream) = client.get_mut("upstream").and_then(Value::as_object_mut) {
                    changed |= upstream.remove("modelOverrides").is_some();
                }
            }
        }
    }
    changed
}

pub fn sanitize_mapping(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return Some(raw.to_string());
    };
    remove_retired_rules(&mut value);
    if value.as_object().is_some_and(|object| object.is_empty()) {
        None
    } else {
        Some(value.to_string())
    }
}

pub fn upstream_mapping(mapping: &str, kind: &str) -> Option<String> {
    let mut value: Value = serde_json::from_str(mapping).ok()?;
    remove_retired_rules(&mut value);
    let key = client_key(kind);
    if value["version"] == 2 {
        return Some(
            value["clients"][key]["upstream"]
                .as_object()
                .cloned()
                .map(Value::Object)
                .unwrap_or_else(|| json!({}))
                .to_string(),
        );
    }
    let target = if matches!(key, "codex" | "grok") {
        value[key].as_str()
    } else {
        None
    };
    if let Some(target) = target.filter(|model| !model.trim().is_empty()) {
        return Some(json!({"mode":"fixed","model":target}).to_string());
    }
    if key == "claude_code" {
        return Some(json!({"mode":"family","haiku":value["haiku"],"sonnet":value["sonnet"],"opus":value["opus"],"autoMode":value["autoMode"]}).to_string());
    }
    Some(json!({"mode":"follow"}).to_string())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientModel {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub supports1m: bool,
}

/// Desktop role slots. Each exposes one catalog model under a canonical
/// Claude route id so Claude Desktop's tier and effort detection apply.
pub const CLIENT_ROLES: [&str; 4] = ["sonnet", "opus", "haiku", "fable"];

/// Canonical route id per Desktop role, verified against the installed app's
/// validation and capability tables.
pub fn role_route_id(role: &str) -> Option<&'static str> {
    match role {
        "sonnet" => Some("claude-sonnet-5"),
        "opus" => Some("claude-opus-5"),
        "haiku" => Some("claude-haiku-4-5"),
        "fable" => Some("claude-fable-5"),
        _ => None,
    }
}

/// Role → model id, from `clients.<kind>.catalog.roles`.
pub fn client_roles(
    mapping: Option<&str>,
    kind: &str,
) -> std::collections::BTreeMap<String, String> {
    let Some(value) = mapping.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) else {
        return std::collections::BTreeMap::new();
    };
    let scope = &value["clients"][client_key(kind)];
    let raw = scope["catalog"].get("roles").unwrap_or(&scope["roles"]);
    let Some(object) = raw.as_object() else {
        return std::collections::BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(role, model)| {
            let role = role.trim();
            let model = model.as_str()?.trim();
            if !CLIENT_ROLES.contains(&role) || model.is_empty() {
                return None;
            }
            Some((role.to_string(), model.to_string()))
        })
        .collect()
}

/// A model id that Claude's clients recognize without any namespacing.
fn carries_anthropic_token(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    lower.contains("claude") || lower.contains("anthropic")
}

/// One assigned role, resolved into the route id the clients understand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRoleEntry {
    pub role: String,
    pub route: String,
    pub upstream: String,
    pub display_name: String,
    pub supports_1m: bool,
}

/// Assigned role slots, in the stable sonnet/opus/haiku/fable order. A role
/// with no model, or one that is not in the catalog list, contributes nothing.
/// Only Claude's clients have roles.
pub fn client_role_entries(mapping: Option<&str>, kind: &str) -> Vec<ClientRoleEntry> {
    // Claude Desktop is the client whose menu and tier resolution are built
    // from role slots; Claude Code gets its tiers through startup variables
    // instead, so it has no role entries here.
    if client_key(kind) != "claude_desktop" {
        return Vec::new();
    }
    let roles = client_roles(mapping, kind);
    if roles.is_empty() {
        return Vec::new();
    }
    let models = client_models(mapping, kind);
    let mut entries = Vec::new();
    for role in CLIENT_ROLES {
        let Some(upstream) = roles
            .get(role)
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty())
        else {
            continue;
        };
        let Some(route) = role_route_id(role) else {
            continue;
        };
        let model = models.iter().find(|model| model.id == upstream);
        entries.push(ClientRoleEntry {
            role: role.to_string(),
            route: route.to_string(),
            display_name: model
                .map(|model| model.display_name.trim())
                .filter(|name| !name.is_empty())
                .unwrap_or(&upstream)
                .to_string(),
            supports_1m: model.is_some_and(|model| model.supports1m),
            upstream,
        });
    }
    entries
}

pub fn client_models(mapping: Option<&str>, kind: &str) -> Vec<ClientModel> {
    let Some(value) = mapping.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) else {
        return vec![];
    };
    let scope = &value["clients"][client_key(kind)];
    let raw = scope["catalog"].get("models").unwrap_or(&scope["models"]);
    let mut seen = std::collections::HashSet::new();
    raw.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry["id"].as_str()?.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let name = entry["displayName"].as_str().unwrap_or("").trim();
            Some(ClientModel {
                id: id.to_string(),
                display_name: if name.is_empty() {
                    id.to_string()
                } else {
                    name.to_string()
                },
                supports1m: entry["supports1m"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

pub fn catalog_mode(mapping: Option<&str>, kind: &str) -> &'static str {
    let Some(value) = mapping.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) else {
        return "provider";
    };
    let scope = &value["clients"][client_key(kind)];
    match scope["catalog"]["mode"].as_str() {
        Some("custom") => "custom",
        Some("append") => "append",
        Some(_) => "provider",
        None if !client_models(mapping, kind).is_empty() => "custom",
        None => "provider",
    }
}

pub fn client_default_model(mapping: Option<&str>, kind: &str) -> Option<String> {
    let value: Value = serde_json::from_str(mapping?).ok()?;
    let key = client_key(kind);
    let model = if key == "grok" {
        if value["version"] == 2 {
            &value["clients"][key]["model"]
        } else {
            &value["grok"]
        }
    } else {
        &value["clients"][key]["catalog"]["defaultModel"]
    };
    model
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

pub fn grok_client_model(mapping: Option<&str>) -> Option<String> {
    client_default_model(mapping, "grok")
}

pub fn effective_catalog(
    mapping: Option<&str>,
    kind: &str,
    provider: Option<&Value>,
) -> Result<Value, String> {
    effective_catalog_ex(mapping, kind, provider).map(|(catalog, _)| catalog)
}

/// The served catalog plus the exposed-id → upstream-id table the gateway
/// decodes requests with. Claude's clients only accept ids that look like
/// Claude models, so ids are namespaced on the way out; the table is the only
/// thing that maps a picked id back, and it also marks which ids belong to the
/// catalog at all (those bypass the family and fixed forwarding rules).
pub type AliasTable = std::collections::BTreeMap<String, String>;

pub fn effective_catalog_ex(
    mapping: Option<&str>,
    kind: &str,
    provider: Option<&Value>,
) -> Result<(Value, AliasTable), String> {
    let anthropic = matches!(client_key(kind), "claude_code" | "claude_desktop");
    // Role slots replace the raw catalog for Claude's clients. They are the
    // ids those clients fully support, and building them needs no provider
    // call — a provider whose model-list endpoint is unavailable still gets a
    // usable menu.
    let roles = client_role_entries(mapping, kind);
    if !roles.is_empty() {
        let mut aliases = AliasTable::new();
        let mut data = Vec::with_capacity(roles.len());
        // Two roles can name the same model; the menu offers it once (the
        // first role in sonnet/opus/haiku/fable order wins) while every route
        // stays resolvable, so tier traffic still reaches that model.
        let mut listed: std::collections::HashSet<String> = std::collections::HashSet::new();
        for entry in roles {
            aliases.insert(entry.route.clone(), entry.upstream.clone());
            if !listed.insert(entry.upstream.clone()) {
                continue;
            }
            let (id, display_name) = if entry.supports_1m {
                (
                    format!("{}[1m]", entry.route),
                    format!("{} · 1M", entry.display_name),
                )
            } else {
                (entry.route.clone(), entry.display_name.clone())
            };
            data.push(json!({
                "id": id,
                "display_name": display_name,
                "description": format!("上游: {}", entry.upstream),
            }));
        }
        return Ok((finish_catalog(data, anthropic), aliases));
    }
    let mode = catalog_mode(mapping, kind);
    let custom = client_models(mapping, kind);
    if mode == "custom" && custom.is_empty() {
        return Err("自定义模型列表至少需要一个模型".to_string());
    }
    let mut data = if mode == "custom" {
        vec![]
    } else {
        provider
            .and_then(|catalog| catalog["data"].as_array())
            .cloned()
            .ok_or_else(|| "供应商模型目录不可用，无法生成有效列表".to_string())?
    };
    for entry in &mut data {
        if let Some(id) = entry["id"].as_str().map(str::trim).map(str::to_string) {
            entry["id"] = Value::String(id);
        }
    }
    let custom_ids = custom
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let one_m_by_id = custom
        .iter()
        .filter(|model| model.supports1m)
        .map(|model| model.id.clone())
        .collect::<std::collections::HashSet<_>>();
    if mode != "provider" {
        for model in custom {
            if let Some(entry) = data
                .iter_mut()
                .find(|entry| entry["id"].as_str() == Some(model.id.as_str()))
            {
                entry["display_name"] = json!(model.display_name);
            } else {
                data.push(json!({"id":model.id,"display_name":model.display_name}));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    data.retain(|entry| {
        entry["id"]
            .as_str()
            .is_some_and(|id| !id.trim().is_empty() && seen.insert(id.to_string()))
    });
    if data.is_empty() {
        return Err("有效模型目录为空".to_string());
    }

    // Namespacing is Claude Code only: it is the client that filters ids down
    // to `claude`/`anthropic`, and it can only be served through discovery.
    let namespacing = client_key(kind) == "claude_code";
    let mut aliases = AliasTable::new();
    if namespacing {
        let mut taken = data
            .iter()
            .filter_map(|entry| entry["id"].as_str().map(str::to_string))
            .collect::<std::collections::HashSet<_>>();
        let configured = custom_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        for entry in &mut data {
            let Some(upstream) = entry["id"].as_str().map(str::to_string) else {
                continue;
            };
            let alias = format!("claude-{upstream}");
            if carries_anthropic_token(&upstream) || taken.contains(&alias) {
                // Already recognizable, or an alias would collide with a real
                // catalog id: leave it alone rather than guess later.
                aliases.insert(upstream.clone(), upstream);
                continue;
            }
            taken.insert(alias.clone());
            aliases.insert(alias.clone(), upstream.clone());
            // A model the catalog itself carries — the list the tier variables
            // and the person's choices come from — passes through under its own
            // name too, so the family and fixed rules cannot hijack it.
            if configured.contains(upstream.as_str()) {
                aliases.insert(upstream.clone(), upstream.clone());
            }
            entry["id"] = Value::String(alias);
        }
        let mut expanded = Vec::with_capacity(data.len());
        for entry in data {
            let Some(exposed) = entry["id"].as_str().map(str::to_string) else {
                continue;
            };
            let upstream = aliases.get(&exposed).cloned().unwrap_or_default();
            let one_m =
                one_m_by_id.contains(&upstream) || entry["supports1m"].as_bool() == Some(true);
            let mut entry = entry;
            // A model that supports 1M is offered as the 1M entry only: two
            // rows for one model would just be a 200K twin nobody wants.
            if one_m {
                let display = entry["display_name"]
                    .as_str()
                    .unwrap_or(&upstream)
                    .to_string();
                entry["id"] = json!(format!("{exposed}[1m]"));
                entry["display_name"] = json!(format!("{display} · 1M"));
            }
            expanded.push(entry);
        }
        data = expanded;
    }

    Ok((finish_catalog(data, anthropic), aliases))
}

fn finish_catalog(mut data: Vec<Value>, anthropic: bool) -> Value {
    for entry in &mut data {
        if let Some(object) = entry.as_object_mut() {
            if anthropic {
                object.insert("type".into(), json!("model"));
                object
                    .entry("created_at")
                    .or_insert(json!("1970-01-01T00:00:00Z"));
            } else {
                object.entry("object").or_insert(json!("model"));
                object.entry("created").or_insert(json!(0));
                object.entry("owned_by").or_insert(json!("cc-use"));
            }
        }
    }
    if anthropic {
        json!({"first_id":data.first().and_then(|entry| entry.get("id")),"last_id":data.last().and_then(|entry| entry.get("id")),"data":data,"has_more":false})
    } else {
        json!({"object":"list","data":data})
    }
}

/// The settings key an alias table lives under, scoped to one key and client.
pub fn alias_table_key(api_key_id: &str, kind: &str) -> String {
    format!("model-alias-map.{}.{}", api_key_id, client_key(kind))
}
