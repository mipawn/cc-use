//! Provider preset catalogue.
//!
//! A preset is an *initialisation template*, not a lock. Picking one fills in a
//! full, sensible configuration — provider address, query settings, the request
//! adapter, and the defaults a new key inherits — and everything stays editable
//! afterwards. `preset_id` records where a provider came from; it never proves
//! that the current endpoint is still the vendor's, so nothing may re-derive
//! behaviour from it after the fact.
//!
//! The catalogue is shared Rust so the create path, the export format and the
//! daemon all agree on what a preset contains.

use serde::{Deserialize, Serialize};

use super::{account_scripts, query_schemes};

pub const PRESET_CUSTOM: &str = "custom";
pub const PRESET_OPENCODE_GO: &str = "opencode-go";
pub const PRESET_DEEPSEEK: &str = "deepseek";
pub const PRESET_NEWAPI: &str = "newapi";
pub const PRESET_COMMAND_CODE: &str = "command-code";

/// Request adapter ids. An adapter is saved configuration, not something the
/// preset label forces: editing the provider keeps whichever one is stored.
pub const ADAPTER_NONE: &str = crate::shared_runtime::ADAPTER_NONE_ID;

/// A retired adapter id, kept only so stored values can still be recognised.
///
/// Until v3.10.2 this id made the proxy supply an `x-opencode-session` header
/// whenever the client did not. OpenCode recognises native session headers, so
/// the adapter is gone and the id now means nothing — but providers saved
/// under it exist, and refusing the value would lock them out of being edited.
const RETIRED_ADAPTER_OPENCODE_GO: &str = "opencode-go";

/// Defaults a newly created key for this provider starts from.
///
/// Deliberately stores the same shapes the key editor already uses, so a key
/// created without opening any advanced tab is still complete. It never holds
/// an inference credential — that is entered per key.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultKeyConfig {
    /// Clients the key is offered for.
    #[serde(default)]
    pub types: Vec<String>,
    /// Per-client endpoint / auth overrides, keyed by client kind.
    #[serde(default)]
    pub client_configs: serde_json::Value,
    /// Model mapping applied to a new key, serialised as the editor stores it.
    #[serde(default)]
    pub model_mapping: Option<String>,
    /// CLI-side config overlay written into the key's local config.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    /// Quota query settings for the key.
    #[serde(default)]
    pub usage_type: Option<String>,
    #[serde(default)]
    pub usage_url: Option<String>,
    #[serde(default)]
    pub usage_path: Option<String>,
    #[serde(default)]
    pub usage_headers: Option<String>,
}

impl DefaultKeyConfig {
    fn with_clients(types: &[&str], client_configs: serde_json::Value) -> Self {
        Self {
            types: types.iter().map(|value| value.to_string()).collect(),
            client_configs,
            ..Self::default()
        }
    }
}

/// One entry of the catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    /// Suggested provider name when creating a new instance.
    pub default_name: String,
    /// Root address of the service. Empty when the user must supply one.
    pub base_url: String,
    pub icon: String,
    /// Which scope this service's quota is asked in: `account` for a provider
    /// account query, `key` when the quota belongs to each API key (one key is
    /// one account). A new provider inherits it from the preset it is created
    /// from, and the editor never changes it afterwards.
    pub query_scope: String,
    /// The site address is the user's own and cannot be preset (New API).
    pub requires_site_address: bool,
    /// Balance / quota queries need a separate account credential that is not
    /// the inference key.
    pub needs_account_credential: bool,
    /// Kept for the presets' own bookkeeping and for the migration; the
    /// running query is `wallet_balance_script`.
    pub wallet_balance_type: String,
    pub wallet_balance_url: Option<String>,
    #[serde(default)]
    pub wallet_balance_headers: Option<String>,
    pub usage_type: String,
    pub usage_url: Option<String>,
    #[serde(default)]
    pub usage_headers: Option<String>,
    /// The account query itself: request and reader in one editable script.
    #[serde(default)]
    pub wallet_balance_script: Option<String>,
    /// Request adapter to run for this provider's traffic.
    pub request_adapter: String,
    pub default_key_config: DefaultKeyConfig,
}

/// The catalogue entry for a service, which is also where that service's
/// address and headers come from.
fn script_of(kind: &str) -> &'static account_scripts::AccountScript {
    account_scripts::for_legacy_kind(kind).expect("the catalogue names every kind it ships")
}

/// DeepSeek: Anthropic-compatible endpoint for Claude clients, native
/// Responses for Codex, plus the documented balance endpoint.
fn deepseek_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_DEEPSEEK.to_string(),
        default_name: "deepseek".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        icon: "deepseek".to_string(),
        query_scope: query_schemes::SCOPE_ACCOUNT.to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        wallet_balance_type: "deepseek".to_string(),
        wallet_balance_url: Some(script_of("deepseek").url.to_string()),
        wallet_balance_headers: Some(script_of("deepseek").headers.to_string()),
        wallet_balance_script: Some(account_scripts::script_for(
            &account_scripts::for_legacy_kind("deepseek").expect("deepseek script"),
        )),
        usage_type: "none".to_string(),
        usage_url: None,
        usage_headers: None,
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig {
            types: vec![
                "claude_code".to_string(),
                "codex".to_string(),
                "claude_desktop".to_string(),
            ],
            client_configs: serde_json::json!({
                "claude_code": { "baseUrl": "https://api.deepseek.com/anthropic", "authScheme": "bearer" },
                "codex": { "baseUrl": "https://api.deepseek.com", "authScheme": "bearer" },
                "claude_desktop": { "baseUrl": "https://api.deepseek.com/anthropic", "authScheme": "bearer" },
            }),
            model_mapping: Some(
                serde_json::json!({
                    "haiku": "deepseek-v4-flash",
                    "sonnet": "deepseek-v4-pro[1m]",
                    "opus": "deepseek-v4-pro[1m]",
                })
                .to_string(),
            ),
            // DeepSeek's own Claude Code guide, minus the two lines cc-use
            // sets itself: the endpoint and the credential are the local proxy
            // and the session token, so carrying them here would be overwritten
            // at launch anyway.
            config: Some(serde_json::json!({
                "ANTHROPIC_MODEL": "deepseek-flash[1m]",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-flash[1m]",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-flash[1m]",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-flash",
                "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-flash",
                "CLAUDE_CODE_EFFORT_LEVEL": "max",
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "786432",
            })),
            ..DefaultKeyConfig::default()
        },
    }
}

/// New API: the site belongs to the user, so only the query kinds are preset.
/// Account balance and key quota are separate capabilities with separate
/// credentials, and neither is faked when its credential is missing.
fn newapi_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_NEWAPI.to_string(),
        default_name: "".to_string(),
        base_url: String::new(),
        icon: "newapi".to_string(),
        query_scope: query_schemes::SCOPE_ACCOUNT.to_string(),
        requires_site_address: true,
        needs_account_credential: true,
        wallet_balance_type: "newapi".to_string(),
        wallet_balance_url: Some(script_of("newapi").url.to_string()),
        wallet_balance_headers: Some(script_of("newapi").headers.to_string()),
        wallet_balance_script: Some(account_scripts::script_for(
            &account_scripts::for_legacy_kind("newapi").expect("newapi script"),
        )),
        usage_type: "none".to_string(),
        usage_url: None,
        usage_headers: None,
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig::with_clients(&["claude_code"], serde_json::json!({})),
    }
}

/// OpenCode Go: speaks the client's own protocols per model, and its session
/// rule is an adapter rather than a URL rewrite.
///
/// Its quota is per key — one key is one account — so the preset ships no
/// account query at all. The `/v1/usage` script is offered as the
/// `opencode-go-key` key scheme instead.
fn opencode_go_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_OPENCODE_GO.to_string(),
        default_name: "opencode go".to_string(),
        base_url: "https://opencode.ai/zen/go".to_string(),
        icon: "claude".to_string(),
        query_scope: query_schemes::SCOPE_KEY.to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        // No account query: the quota lives on each key, where the user opts
        // into the shipped key scheme per key.
        wallet_balance_type: "none".to_string(),
        wallet_balance_url: None,
        wallet_balance_headers: None,
        wallet_balance_script: None,
        usage_type: "none".to_string(),
        usage_url: None,
        usage_headers: None,
        // The Go adapter is gone; the preset no longer shapes the request.
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig {
            types: vec!["claude_code".to_string(), "codex".to_string()],
            // Model selection belongs to the user, including for Go.
            model_mapping: None,
            // Verified against the live endpoint: `/v1/messages` authenticates
            // with `x-api-key` and rejects a Bearer token, while the
            // OpenAI-shaped routes take Bearer.
            client_configs: serde_json::json!({
                "claude_code": { "baseUrl": "https://opencode.ai/zen/go", "authScheme": "x-api-key" },
                "codex": { "baseUrl": "https://opencode.ai/zen/go", "authScheme": "bearer" },
            }),
            ..DefaultKeyConfig::default()
        },
    }
}

/// Command Code: the provider is billed per key in credits, so the preset
/// ships no account query. Its three-request credits script is offered as the
/// `command-code-key` key scheme instead.
fn command_code_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_COMMAND_CODE.to_string(),
        default_name: "command code".to_string(),
        base_url: "https://api.commandcode.ai/provider".to_string(),
        // No dedicated icon ships; like Go, Claude's is the closest and stays
        // the user's to change.
        icon: "claude".to_string(),
        query_scope: query_schemes::SCOPE_KEY.to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        // No account query: each key answers for itself.
        wallet_balance_type: "none".to_string(),
        wallet_balance_url: None,
        wallet_balance_headers: None,
        wallet_balance_script: None,
        usage_type: "none".to_string(),
        usage_url: None,
        usage_headers: None,
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig {
            types: vec!["claude_code".to_string(), "codex".to_string()],
            // Both clients speak to the provider root with a Bearer key, the
            // way DeepSeek's codex client does.
            client_configs: serde_json::json!({
                "claude_code": { "baseUrl": "https://api.commandcode.ai/provider", "authScheme": "bearer" },
                "codex": { "baseUrl": "https://api.commandcode.ai/provider", "authScheme": "bearer" },
            }),
            ..DefaultKeyConfig::default()
        },
    }
}

/// Blank template: nothing pre-filled, no capability assumed.
fn custom_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_CUSTOM.to_string(),
        default_name: "".to_string(),
        base_url: String::new(),
        icon: "custom".to_string(),
        query_scope: query_schemes::SCOPE_ACCOUNT.to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        wallet_balance_type: "none".to_string(),
        wallet_balance_url: None,
        wallet_balance_headers: None,
        usage_type: "none".to_string(),
        usage_url: None,
        usage_headers: None,
        wallet_balance_script: None,
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig::with_clients(&["claude_code"], serde_json::json!({})),
    }
}

/// The whole catalogue, in the order the picker shows it.
pub fn provider_presets() -> Vec<ProviderPreset> {
    vec![
        custom_preset(),
        deepseek_preset(),
        newapi_preset(),
        opencode_go_preset(),
        command_code_preset(),
    ]
}

/// Look up one preset by id. An unknown id (a provider imported from a newer
/// build, say) yields `None` rather than a guessed template.
pub fn provider_preset(id: &str) -> Option<ProviderPreset> {
    provider_presets()
        .into_iter()
        .find(|preset| preset.id == id)
}

/// Which query scope a provider created from this origin starts in.
///
/// `opencode-go` and `command-code` ask their quota per key — one key is one
/// account — so a provider created from either starts in the `key` scope.
/// Every other origin, including an unknown/newer preset id, is the
/// provider-level `account` scope. The id is trimmed the same way
/// `provider_create` normalises the stored `preset_id`.
pub fn query_scope_for_preset(preset_id: Option<&str>) -> &'static str {
    match preset_id.map(str::trim) {
        Some(PRESET_OPENCODE_GO) | Some(PRESET_COMMAND_CODE) => query_schemes::SCOPE_KEY,
        _ => query_schemes::SCOPE_ACCOUNT,
    }
}

/// `account`, owned, for `#[serde(default = ...)]` on `Provider.query_scope`.
pub fn default_query_scope_string() -> String {
    query_schemes::SCOPE_ACCOUNT.to_string()
}

/// Adapter ids this build implements. Anything else is rejected on save rather
/// than silently treated as `none`, so a provider imported from a newer build
/// reports the problem instead of quietly losing its request shaping.
///
/// A retired id counts as supported because it is read back as `none` — see
/// [`normalize_request_adapter`]. Rejecting it would fail the save of an
/// untouched provider, which is a worse outcome than accepting a value that
/// now means nothing.
pub fn is_supported_request_adapter(id: &str) -> bool {
    let id = normalize_request_adapter(id);
    id.is_empty() || id == ADAPTER_NONE
}

/// The adapter id this build acts on.
///
/// A retired id maps onto the behaviour that replaced it instead of being
/// rejected: a stored `opencode-go` used to add a session header and now adds
/// nothing, which is exactly what `none` means. Called wherever a stored value
/// is read, so a legacy row never has to be rewritten to keep working.
pub fn normalize_request_adapter(id: &str) -> &str {
    let id = id.trim();
    if id == RETIRED_ADAPTER_OPENCODE_GO {
        ADAPTER_NONE
    } else {
        id
    }
}

/// Preset id to record for a provider whose origin we do not know.
pub fn default_preset_id() -> String {
    PRESET_CUSTOM.to_string()
}

/// Serialise a key-defaults object for storage.
pub fn serialize_default_key_config(config: &DefaultKeyConfig) -> Option<String> {
    let mut value = serde_json::to_value(config).ok()?;
    value["modelMapping"] =
        crate::shared_runtime::model_mapping::sanitize_mapping(config.model_mapping.as_deref())
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&value).ok()
}

/// Read a stored key-defaults object. An unreadable value yields `None`, which
/// callers treat as "no defaults saved" instead of substituting a template.
pub fn parse_default_key_config(raw: Option<&str>) -> Option<DefaultKeyConfig> {
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    let mut config: DefaultKeyConfig = serde_json::from_str(raw).ok()?;
    config.model_mapping =
        crate::shared_runtime::model_mapping::sanitize_mapping(config.model_mapping.as_deref());
    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_self_consistent() {
        for preset in provider_presets() {
            assert!(!preset.id.is_empty(), "preset needs an id");
            if preset.requires_site_address {
                assert!(
                    preset.base_url.is_empty(),
                    "{} must not ship a third-party site address",
                    preset.id
                );
            } else if !preset.base_url.is_empty() {
                assert!(
                    preset.base_url.starts_with("https://"),
                    "{} needs an https root address",
                    preset.id
                );
            }
            assert!(!preset.default_key_config.types.is_empty());
            assert!(
                preset.query_scope == query_schemes::SCOPE_ACCOUNT
                    || preset.query_scope == query_schemes::SCOPE_KEY,
                "{} needs a known query scope",
                preset.id
            );
        }

        // The quota scope is a property of the service, not of the preset
        // count: only the two per-key metering services are `key`.
        let presets = provider_presets();
        let key_scoped: Vec<&str> = presets
            .iter()
            .filter(|preset| preset.query_scope == query_schemes::SCOPE_KEY)
            .map(|preset| preset.id.as_str())
            .collect();
        assert_eq!(key_scoped, vec![PRESET_OPENCODE_GO, PRESET_COMMAND_CODE]);

        // An empty address means the user supplies it: the blank template, and
        // the one preset whose whole point is a site the user owns.
        let addressless: Vec<&str> = presets
            .iter()
            .filter(|preset| preset.base_url.is_empty())
            .map(|preset| preset.id.as_str())
            .collect();
        assert_eq!(addressless, vec![PRESET_CUSTOM, PRESET_NEWAPI]);
    }

    fn blank_input(preset_id: Option<&str>) -> crate::models::CreateProviderInput {
        crate::models::CreateProviderInput {
            query_config: None,
            request_headers: None,
            wallet_balance_script: None,
            name: String::new(),
            base_url: String::new(),
            http_proxy: None,
            website: None,
            remark: None,
            token: None,
            icon: None,
            wallet_balance_type: None,
            wallet_balance_url: None,
            wallet_balance_path: None,
            wallet_balance_headers: None,
            wallet_balance_user_id: None,
            usage_type: None,
            usage_url: None,
            usage_path: None,
            usage_headers: None,
            preset_id: preset_id.map(str::to_string),
            default_key_config: None,
            request_adapter: None,
        }
    }

    #[test]
    fn a_preset_fills_every_field_the_form_never_showed() {
        let merged = apply_preset_defaults(blank_input(Some(PRESET_DEEPSEEK)));

        assert_eq!(merged.base_url, "https://api.deepseek.com");
        assert_eq!(merged.name, "deepseek");
        assert_eq!(merged.icon.as_deref(), Some("deepseek"));
        assert_eq!(merged.wallet_balance_type.as_deref(), Some("deepseek"));
        assert_eq!(
            merged.wallet_balance_url.as_deref(),
            Some("https://api.deepseek.com/user/balance")
        );
        let defaults = merged.default_key_config.expect("defaults filled in");
        assert_eq!(defaults.types.len(), 3);
        assert!(defaults.model_mapping.is_some());
    }

    #[test]
    fn an_explicit_choice_always_beats_the_template() {
        let mut input = blank_input(Some(PRESET_DEEPSEEK));
        input.name = "my deepseek".to_string();
        input.base_url = "https://relay.example.com".to_string();
        input.wallet_balance_type = Some("none".to_string());
        input.usage_type = Some("custom".to_string());
        input.usage_url = Some("https://quota.example.com".to_string());
        // An explicit empty defaults object means the user cleared it.
        input.default_key_config = Some(DefaultKeyConfig::default());

        let merged = apply_preset_defaults(input);

        assert_eq!(merged.name, "my deepseek");
        assert_eq!(merged.base_url, "https://relay.example.com");
        assert_eq!(merged.wallet_balance_type.as_deref(), Some("none"));
        assert_eq!(merged.usage_type.as_deref(), Some("custom"));
        assert_eq!(
            merged.usage_url.as_deref(),
            Some("https://quota.example.com")
        );
        assert_eq!(merged.default_key_config, Some(DefaultKeyConfig::default()));
        // A field the user left alone still comes from the template.
        assert_eq!(merged.icon.as_deref(), Some("deepseek"));
    }

    #[test]
    fn an_unknown_origin_is_preserved_and_changes_nothing() {
        let merged = apply_preset_defaults(blank_input(Some("from-a-newer-build")));

        assert_eq!(merged.preset_id.as_deref(), Some("from-a-newer-build"));
        assert!(merged.base_url.is_empty(), "no template is invented");
        assert!(merged.default_key_config.is_none());
        assert!(merged.wallet_balance_type.is_none());
    }

    /// The blank template invents no address, name or vendor capability; the
    /// only thing it supplies is the baseline client set a key already
    /// defaulted to before presets existed.
    #[test]
    fn the_blank_template_records_its_origin_and_nothing_vendor_specific() {
        let merged = apply_preset_defaults(blank_input(None));

        assert_eq!(merged.preset_id.as_deref(), Some(PRESET_CUSTOM));
        assert!(merged.base_url.is_empty());
        assert!(merged.name.is_empty());
        // Neutral, not vendor-specific: no endpoint and no query capability.
        assert_eq!(merged.icon.as_deref(), Some("custom"));
        assert_eq!(merged.wallet_balance_type.as_deref(), Some("none"));
        assert_eq!(merged.usage_type.as_deref(), Some("none"));
        assert!(merged.wallet_balance_url.is_none());
        assert_eq!(
            merged.default_key_config.expect("baseline clients").types,
            vec!["claude_code".to_string()]
        );
    }

    #[test]
    fn a_whitespace_name_is_treated_as_not_provided() {
        let mut input = blank_input(Some(PRESET_OPENCODE_GO));
        input.name = "   ".to_string();

        assert_eq!(apply_preset_defaults(input).name, "opencode go");
    }

    #[test]
    fn deepseek_carries_the_documented_endpoints_and_balance_query() {
        let preset = provider_preset(PRESET_DEEPSEEK).expect("deepseek preset");

        assert_eq!(preset.base_url, "https://api.deepseek.com");
        assert_eq!(preset.query_scope, query_schemes::SCOPE_ACCOUNT);
        assert_eq!(preset.wallet_balance_type, "deepseek");
        assert_eq!(
            preset.wallet_balance_url.as_deref(),
            Some("https://api.deepseek.com/user/balance")
        );
        assert_eq!(
            preset.default_key_config.client_configs["claude_code"]["baseUrl"],
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(
            preset.default_key_config.client_configs["codex"]["baseUrl"],
            "https://api.deepseek.com"
        );
        let mapping: serde_json::Value =
            serde_json::from_str(preset.default_key_config.model_mapping.as_deref().unwrap())
                .unwrap();
        assert_eq!(mapping["haiku"], "deepseek-v4-flash");
        assert_eq!(mapping["sonnet"], "deepseek-v4-pro[1m]");
    }

    /// The settings dialog shows the request and lets it be edited, so a preset
    /// that queries has to ship a whole request — a url with no headers would
    /// leave the dialog showing half of what will actually be sent.
    #[test]
    fn a_preset_that_queries_carries_the_whole_request() {
        for preset in provider_presets() {
            if !matches!(preset.wallet_balance_type.as_str(), "none" | "custom") {
                assert!(
                    preset.wallet_balance_url.is_some(),
                    "{}: balance url",
                    preset.id
                );
                assert!(
                    preset.wallet_balance_headers.is_some(),
                    "{}: balance headers",
                    preset.id
                );
                assert!(
                    preset.wallet_balance_script.is_some(),
                    "{}: balance script",
                    preset.id
                );
            }
            if !matches!(preset.usage_type.as_str(), "none" | "custom") {
                assert!(preset.usage_url.is_some(), "{}: usage url", preset.id);
                assert!(
                    preset.usage_headers.is_some(),
                    "{}: usage headers",
                    preset.id
                );
            }
        }
        // The two per-key services ship no account query at all; their script
        // lives in the key-scope catalogue instead.
        for id in [PRESET_OPENCODE_GO, PRESET_COMMAND_CODE] {
            let preset = provider_preset(id).expect("preset");
            assert_eq!(preset.wallet_balance_type, "none");
            assert_eq!(preset.usage_type, "none");
            assert!(preset.wallet_balance_script.is_none());
            assert!(preset.wallet_balance_url.is_none());
        }
    }

    /// The account query is on for the account-scoped presets that know how to
    /// ask; the blank template and the two per-key services leave it off.
    #[test]
    fn only_the_account_scope_presets_ship_an_account_query() {
        let presets = provider_presets();
        let silent: Vec<&str> = presets
            .iter()
            .filter(|preset| {
                preset.wallet_balance_type == "none"
                    && preset.wallet_balance_script.is_none()
                    && preset.usage_type == "none"
            })
            .map(|preset| preset.id.as_str())
            .collect();

        assert_eq!(
            silent,
            vec![PRESET_CUSTOM, PRESET_OPENCODE_GO, PRESET_COMMAND_CODE]
        );
        for id in [PRESET_DEEPSEEK, PRESET_NEWAPI] {
            let preset = provider_preset(id).expect("preset");
            assert!(
                preset.wallet_balance_script.is_some(),
                "{} keeps its account query",
                preset.id
            );
        }
    }

    /// DeepSeek's Claude Code guide, carried into the key defaults so a new
    /// key is complete without anyone transcribing the page.
    #[test]
    fn deepseek_carries_the_documented_claude_code_environment() {
        let preset = provider_preset(PRESET_DEEPSEEK).expect("deepseek preset");
        let config = preset.default_key_config.config.expect("config preset");

        assert_eq!(config["ANTHROPIC_MODEL"], "deepseek-flash[1m]");
        assert_eq!(config["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "deepseek-flash");
        assert_eq!(config["CLAUDE_CODE_EFFORT_LEVEL"], "max");
        assert_eq!(config["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "786432");

        // These two are the proxy's to set: carrying the guide's values here
        // would put a vendor address and a vendor token in the key's config,
        // and both are overwritten at launch regardless.
        assert!(config.get("ANTHROPIC_BASE_URL").is_none());
        assert!(config.get("ANTHROPIC_AUTH_TOKEN").is_none());
    }

    /// New API's account balance is read with a separate account credential, so
    /// its script has to name both placeholders the dialog asks for.
    #[test]
    fn the_newapi_balance_script_names_the_credential_it_needs() {
        let preset = provider_preset(PRESET_NEWAPI).expect("newapi preset");
        let script = preset.wallet_balance_script.expect("script preset");

        assert!(script.contains("{{accessToken}}"));
        assert!(script.contains("{{userId}}"));
        assert!(script.contains("{{baseUrl}}/api/user/self"));
    }

    #[test]
    fn newapi_leaves_the_site_address_to_the_user() {
        let preset = provider_preset(PRESET_NEWAPI).expect("newapi preset");

        assert!(preset.requires_site_address);
        assert!(
            preset.base_url.is_empty(),
            "no third-party domain is preset"
        );
        assert!(preset.needs_account_credential);
        assert_eq!(preset.wallet_balance_type, "newapi");
        // Its account script is its one query; a second usage route would be a
        // second thing to keep in step.
        assert_eq!(preset.usage_type, "none");
    }

    #[test]
    fn opencode_go_keeps_zen_in_the_path_without_an_adapter() {
        let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");

        assert_eq!(preset.base_url, "https://opencode.ai/zen/go");
        // The Go adapter is retired: the preset brings the endpoint but no
        // longer shapes the request.
        assert_eq!(preset.request_adapter, ADAPTER_NONE);
        // The quota is per key now; the preset carries no account query.
        assert_eq!(preset.query_scope, query_schemes::SCOPE_KEY);
        assert_eq!(preset.wallet_balance_type, "none");
        assert_eq!(preset.usage_type, "none");
        assert!(preset.wallet_balance_script.is_none());
        assert!(preset.usage_url.is_none());

        assert!(preset.default_key_config.model_mapping.is_none());
    }

    /// Verified against the live endpoint: `/v1/messages` authenticates with
    /// `x-api-key` and rejects a Bearer token; the OpenAI-shaped routes take
    /// Bearer. Getting this wrong makes every Claude Code request 401.
    #[test]
    fn opencode_go_uses_the_auth_scheme_each_protocol_actually_accepts() {
        let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");
        let clients = &preset.default_key_config.client_configs;

        assert_eq!(clients["claude_code"]["authScheme"], "x-api-key");
        assert_eq!(clients["codex"]["authScheme"], "bearer");
    }

    /// The credits service is billed per key: the preset keeps its address and
    /// key defaults but ships no account query. The three-request script lives
    /// in the key-scope catalogue (`query_schemes`), not here.
    #[test]
    fn command_code_preset_declares_the_key_scope_and_no_account_query() {
        let preset = provider_preset(PRESET_COMMAND_CODE).expect("command code preset");

        assert_eq!(preset.id, "command-code");
        assert_eq!(preset.default_name, "command code");
        assert_eq!(preset.base_url, "https://api.commandcode.ai/provider");
        assert_eq!(preset.icon, "claude");
        assert_eq!(preset.query_scope, query_schemes::SCOPE_KEY);
        assert!(!preset.requires_site_address);
        assert!(!preset.needs_account_credential);

        // Everything that would have made it an account query is gone.
        assert_eq!(preset.wallet_balance_type, "none");
        assert!(preset.wallet_balance_url.is_none());
        assert!(preset.wallet_balance_headers.is_none());
        assert!(preset.wallet_balance_script.is_none());
        assert_eq!(preset.usage_type, "none");
        assert!(preset.usage_url.is_none());
        assert_eq!(preset.request_adapter, ADAPTER_NONE);

        // The script itself is still shipped — as the key scheme it now is.
        let key_script = query_schemes::scheme_script(query_schemes::SCHEME_COMMAND_CODE_KEY)
            .expect("command code key script");
        assert!(key_script.contains(r#""https://api.commandcode.ai/alpha/billing/credits""#));
        assert!(key_script.contains(r#""https://api.commandcode.ai/alpha/billing/subscriptions""#));
        assert!(key_script.contains(r#""https://api.commandcode.ai/alpha/usage/summary""#));
        assert_eq!(key_script.matches("optional: true").count(), 2);
    }

    #[test]
    fn command_code_key_defaults_speak_bearer_to_the_provider_root() {
        let preset = provider_preset(PRESET_COMMAND_CODE).expect("command code preset");
        let clients = &preset.default_key_config.client_configs;

        assert_eq!(
            preset.default_key_config.types,
            vec!["claude_code".to_string(), "codex".to_string()]
        );
        assert_eq!(
            clients["claude_code"]["baseUrl"],
            "https://api.commandcode.ai/provider"
        );
        assert_eq!(clients["claude_code"]["authScheme"], "bearer");
        assert_eq!(
            clients["codex"]["baseUrl"],
            "https://api.commandcode.ai/provider"
        );
        assert_eq!(clients["codex"]["authScheme"], "bearer");
        assert!(preset.default_key_config.model_mapping.is_none());
    }

    #[test]
    fn the_catalogue_appends_command_code_after_the_older_entries() {
        let presets = provider_presets();
        let ids = presets
            .iter()
            .map(|preset| preset.id.as_str())
            .collect::<Vec<&str>>();

        assert_eq!(
            ids,
            vec![
                PRESET_CUSTOM,
                PRESET_DEEPSEEK,
                PRESET_NEWAPI,
                PRESET_OPENCODE_GO,
                PRESET_COMMAND_CODE,
            ]
        );
    }

    #[test]
    fn creating_from_command_code_fills_the_address_and_key_defaults_without_an_account_query() {
        let merged = apply_preset_defaults(blank_input(Some(PRESET_COMMAND_CODE)));

        assert_eq!(merged.name, "command code");
        assert_eq!(merged.base_url, "https://api.commandcode.ai/provider");
        // No account query is pre-filled: the quota is enabled per key.
        assert_eq!(merged.wallet_balance_type.as_deref(), Some("none"));
        assert!(merged.wallet_balance_url.is_none());
        assert_eq!(merged.usage_type.as_deref(), Some("none"));
        assert!(merged.wallet_balance_script.is_none());
        let defaults = merged.default_key_config.expect("defaults filled in");
        assert_eq!(defaults.types.len(), 2);
        assert!(defaults.model_mapping.is_none());
        // The preset itself carries no account script any more.
        assert!(provider_preset(PRESET_COMMAND_CODE)
            .and_then(|preset| preset.wallet_balance_script)
            .is_none());
    }

    /// The create path derives the stored scope from the origin: these two
    /// services ask their quota per key, every other origin is an account.
    #[test]
    fn a_preset_decides_the_query_scope_of_a_new_provider() {
        assert_eq!(query_scope_for_preset(Some(PRESET_OPENCODE_GO)), "key");
        assert_eq!(query_scope_for_preset(Some(PRESET_COMMAND_CODE)), "key");
        assert_eq!(query_scope_for_preset(Some(" opencode-go ")), "key");
        for account in [
            Some(PRESET_CUSTOM),
            Some(PRESET_DEEPSEEK),
            Some(PRESET_NEWAPI),
            Some("from-a-newer-build"),
            None,
        ] {
            assert_eq!(query_scope_for_preset(account), "account");
        }
        assert_eq!(default_query_scope_string(), "account");
    }

    /// `ProviderPreset` crosses IPC with camelCase names; the new field has to
    /// reach the renderer as `queryScope`.
    #[test]
    fn the_preset_wire_shape_names_the_scope_query_scope() {
        let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");
        let value = serde_json::to_value(&preset).expect("serialises");

        assert_eq!(value["queryScope"], "key");
        assert!(value.get("query_scope").is_none());
        // The removed account query is absent from the wire too.
        assert_eq!(value["walletBalanceType"], "none");
        assert_eq!(value["usageType"], "none");
        assert!(value["walletBalanceScript"].is_null());
    }

    #[test]
    fn only_implemented_adapter_ids_are_accepted() {
        assert!(is_supported_request_adapter(""));
        assert!(is_supported_request_adapter("none"));
        assert!(!is_supported_request_adapter("from-a-newer-build"));
    }

    #[test]
    fn a_retired_adapter_id_reads_as_none_rather_than_being_rejected() {
        // Providers saved before the Go adapter was retired still carry this
        // id. Refusing it would fail the save of an untouched provider, so it
        // is accepted and read as the behaviour that replaced it.
        assert!(is_supported_request_adapter(RETIRED_ADAPTER_OPENCODE_GO));
        assert_eq!(
            normalize_request_adapter(RETIRED_ADAPTER_OPENCODE_GO),
            ADAPTER_NONE
        );
    }

    #[test]
    fn normalising_leaves_every_other_id_alone() {
        assert_eq!(normalize_request_adapter("none"), "none");
        assert_eq!(normalize_request_adapter("  none  "), "none");
        assert_eq!(
            normalize_request_adapter("from-a-newer-build"),
            "from-a-newer-build"
        );
        assert_eq!(normalize_request_adapter(""), "");
    }

    #[test]
    fn an_unknown_preset_id_resolves_to_nothing_rather_than_a_guess() {
        assert!(provider_preset("from-a-newer-build").is_none());
    }

    #[test]
    fn default_key_config_round_trips_and_tolerates_junk() {
        let config = deepseek_preset().default_key_config;
        let raw = serialize_default_key_config(&config).expect("serialize");

        assert_eq!(parse_default_key_config(Some(&raw)), Some(config));
        assert_eq!(parse_default_key_config(Some("not json")), None);
        assert_eq!(parse_default_key_config(Some("  ")), None);
        assert_eq!(parse_default_key_config(None), None);
    }
}

/// Fill a create input from its preset, keeping every value the caller set.
///
/// Only gaps are filled — `None` means "not provided", so an explicit choice
/// wins over the template even when it is `none` or an empty object. A hidden
/// or unopened form section therefore cannot leave the stored configuration
/// incomplete, and an edited provider is never quietly pushed back to a
/// template default.
pub fn apply_preset_defaults(
    input: crate::models::CreateProviderInput,
) -> crate::models::CreateProviderInput {
    let preset_id = input
        .preset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(PRESET_CUSTOM)
        .to_string();

    // Unknown origin: keep the label, change nothing else. Guessing a template
    // for someone else's id would silently rewrite their configuration.
    let Some(preset) = provider_preset(&preset_id) else {
        return crate::models::CreateProviderInput {
            preset_id: Some(preset_id),
            ..input
        };
    };

    crate::models::CreateProviderInput {
        name: non_empty(input.name).unwrap_or(preset.default_name),
        base_url: non_empty(input.base_url).unwrap_or(preset.base_url),
        icon: input.icon.or_else(|| Some(preset.icon)),
        wallet_balance_type: input
            .wallet_balance_type
            .or_else(|| Some(preset.wallet_balance_type)),
        wallet_balance_url: input.wallet_balance_url.or(preset.wallet_balance_url),
        wallet_balance_headers: input
            .wallet_balance_headers
            .or(preset.wallet_balance_headers),
        usage_type: input.usage_type.or_else(|| Some(preset.usage_type)),
        usage_url: input.usage_url.or(preset.usage_url),
        usage_headers: input.usage_headers.or(preset.usage_headers),
        request_adapter: input
            .request_adapter
            .or_else(|| Some(preset.request_adapter.clone())),
        default_key_config: input.default_key_config.or(Some(preset.default_key_config)),
        preset_id: Some(preset_id),
        ..input
    }
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}
