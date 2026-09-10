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

pub const PRESET_CUSTOM: &str = "custom";
pub const PRESET_OPENCODE_GO: &str = "opencode-go";
pub const PRESET_DEEPSEEK: &str = "deepseek";
pub const PRESET_NEWAPI: &str = "newapi";

/// Request adapter ids. An adapter is saved configuration, not something the
/// preset label forces: editing the provider keeps whichever one is stored.
pub const ADAPTER_OPENCODE_GO: &str = "opencode-go";
pub const ADAPTER_NONE: &str = "none";

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
    /// The site address is the user's own and cannot be preset (New API).
    pub requires_site_address: bool,
    /// Balance / quota queries need a separate account credential that is not
    /// the inference key.
    pub needs_account_credential: bool,
    pub wallet_balance_type: String,
    pub wallet_balance_url: Option<String>,
    pub usage_type: String,
    pub usage_url: Option<String>,
    /// Request adapter to run for this provider's traffic.
    pub request_adapter: String,
    pub default_key_config: DefaultKeyConfig,
}

/// DeepSeek: Anthropic-compatible endpoint for Claude clients, native
/// Responses for Codex, plus the documented balance endpoint.
fn deepseek_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_DEEPSEEK.to_string(),
        default_name: "deepseek".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        icon: "deepseek".to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        wallet_balance_type: "deepseek".to_string(),
        wallet_balance_url: Some("https://api.deepseek.com/user/balance".to_string()),
        usage_type: "none".to_string(),
        usage_url: None,
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
        requires_site_address: true,
        needs_account_credential: true,
        wallet_balance_type: "newapi".to_string(),
        wallet_balance_url: None,
        usage_type: "newapi".to_string(),
        usage_url: None,
        request_adapter: ADAPTER_NONE.to_string(),
        default_key_config: DefaultKeyConfig::with_clients(&["claude_code"], serde_json::json!({})),
    }
}

/// OpenCode Go: speaks the client's own protocols per model, and its session
/// rule is an adapter rather than a URL rewrite.
fn opencode_go_preset() -> ProviderPreset {
    ProviderPreset {
        id: PRESET_OPENCODE_GO.to_string(),
        default_name: "opencode go".to_string(),
        base_url: "https://opencode.ai/zen/go".to_string(),
        icon: "claude".to_string(),
        requires_site_address: false,
        needs_account_credential: false,
        wallet_balance_type: "none".to_string(),
        wallet_balance_url: None,
        // Filled in by the Go adapter, which reports the rolling windows.
        usage_type: "opencode-go".to_string(),
        usage_url: None,
        request_adapter: ADAPTER_OPENCODE_GO.to_string(),
        default_key_config: DefaultKeyConfig {
            types: vec!["claude_code".to_string(), "codex".to_string()],
            // Models are chosen per protocol after real verification, so no
            // model mapping is preset here; guessing one would promise
            // compatibility that has not been checked.
            client_configs: serde_json::json!({
                "claude_code": { "baseUrl": "https://opencode.ai/zen/go", "authScheme": "bearer" },
                "codex": { "baseUrl": "https://opencode.ai/zen/go", "authScheme": "bearer" },
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
        requires_site_address: false,
        needs_account_credential: false,
        wallet_balance_type: "none".to_string(),
        wallet_balance_url: None,
        usage_type: "none".to_string(),
        usage_url: None,
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
    ]
}

/// Look up one preset by id. An unknown id (a provider imported from a newer
/// build, say) yields `None` rather than a guessed template.
pub fn provider_preset(id: &str) -> Option<ProviderPreset> {
    provider_presets()
        .into_iter()
        .find(|preset| preset.id == id)
}

/// Preset id to record for a provider whose origin we do not know.
pub fn default_preset_id() -> String {
    PRESET_CUSTOM.to_string()
}

/// Serialise a key-defaults object for storage.
pub fn serialize_default_key_config(config: &DefaultKeyConfig) -> Option<String> {
    serde_json::to_string(config).ok()
}

/// Read a stored key-defaults object. An unreadable value yields `None`, which
/// callers treat as "no defaults saved" instead of substituting a template.
pub fn parse_default_key_config(raw: Option<&str>) -> Option<DefaultKeyConfig> {
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(raw).ok()
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
        }

        // An empty address means the user supplies it: the blank template, and
        // the one preset whose whole point is a site the user owns.
        let presets = provider_presets();
        let addressless: Vec<&str> = presets
            .iter()
            .filter(|preset| preset.base_url.is_empty())
            .map(|preset| preset.id.as_str())
            .collect();
        assert_eq!(addressless, vec![PRESET_CUSTOM, PRESET_NEWAPI]);
    }

    #[test]
    fn deepseek_carries_the_documented_endpoints_and_balance_query() {
        let preset = provider_preset(PRESET_DEEPSEEK).expect("deepseek preset");

        assert_eq!(preset.base_url, "https://api.deepseek.com");
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
        assert_eq!(preset.usage_type, "newapi");
    }

    #[test]
    fn opencode_go_selects_its_adapter_and_keeps_zen_in_the_path() {
        let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");

        assert_eq!(preset.base_url, "https://opencode.ai/zen/go");
        assert_eq!(preset.request_adapter, ADAPTER_OPENCODE_GO);
        assert_eq!(preset.usage_type, "opencode-go");
        // No model mapping is promised before the protocols are verified.
        assert!(preset.default_key_config.model_mapping.is_none());
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
