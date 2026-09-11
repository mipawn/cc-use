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

use super::account_scripts;

pub const PRESET_CUSTOM: &str = "custom";
pub const PRESET_OPENCODE_GO: &str = "opencode-go";
pub const PRESET_DEEPSEEK: &str = "deepseek";
pub const PRESET_NEWAPI: &str = "newapi";

/// Request adapter ids. An adapter is saved configuration, not something the
/// preset label forces: editing the provider keeps whichever one is stored.
pub const ADAPTER_OPENCODE_GO: &str = "opencode-go";
pub const ADAPTER_NONE: &str = crate::shared_runtime::ADAPTER_NONE_ID;

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

/// Models verified against the live Go endpoint on 2026-09-11, grouped by the
/// protocol that actually answered.
///
/// The model list carries no protocol metadata, so this is a small,
/// hand-maintained list rather than a derivation. It is deliberately narrow:
/// a model is listed here only after a real request succeeded on that protocol,
/// and anything absent is left to the user rather than guessed at.
pub mod opencode_go_models {
    /// Anthropic Messages (`POST /v1/messages`).
    pub const MESSAGES: &[&str] = &[
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "kimi-k3",
        "minimax-m3",
        "qwen3.8-max",
    ];
    /// OpenAI Responses (`POST /v1/responses`).
    pub const RESPONSES: &[&str] = &[
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "grok-4.6",
        "gpt-5.6-luna",
    ];
    /// Chat Completions (`POST /v1/chat/completions`).
    pub const CHAT: &[&str] = &[
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "glm-5.3",
        "kimi-k3",
        "minimax-m3",
        "qwen3.8-max",
    ];

    /// Chosen for a new Claude Code key: verified on Messages, and the fastest
    /// of the verified set for the small-model slot.
    pub const DEFAULT_CLAUDE_HAIKU: &str = "deepseek-v4-flash";
    pub const DEFAULT_CLAUDE_SONNET: &str = "deepseek-v4-pro";
    pub const DEFAULT_CLAUDE_OPUS: &str = "deepseek-v4-pro";
    /// Chosen for a new Codex key: verified on Responses.
    pub const DEFAULT_CODEX: &str = "deepseek-v4-pro";
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
        wallet_balance_headers: None,
        // The account query for Go: it reports metering periods rather than a
        // balance, so the answer is read differently, but it is still one
        // request and it is still editable.
        usage_type: "opencode-go".to_string(),
        usage_url: Some(script_of("opencode-go").url.to_string()),
        usage_headers: Some(script_of("opencode-go").headers.to_string()),
        wallet_balance_script: Some(account_scripts::script_for(
            &account_scripts::for_legacy_kind("opencode-go").expect("go script"),
        )),
        request_adapter: ADAPTER_OPENCODE_GO.to_string(),
        default_key_config: DefaultKeyConfig {
            types: vec!["claude_code".to_string(), "codex".to_string()],
            // Every default below comes from `opencode_go_models`, i.e. from a
            // model that answered on that protocol. Nothing here is copied from
            // another vendor's preset.
            model_mapping: Some(
                serde_json::json!({
                    "haiku": opencode_go_models::DEFAULT_CLAUDE_HAIKU,
                    "sonnet": opencode_go_models::DEFAULT_CLAUDE_SONNET,
                    "opus": opencode_go_models::DEFAULT_CLAUDE_OPUS,
                    "codex": opencode_go_models::DEFAULT_CODEX,
                })
                .to_string(),
            ),
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
    ]
}

/// Look up one preset by id. An unknown id (a provider imported from a newer
/// build, say) yields `None` rather than a guessed template.
pub fn provider_preset(id: &str) -> Option<ProviderPreset> {
    provider_presets()
        .into_iter()
        .find(|preset| preset.id == id)
}

/// Adapter ids this build implements. Anything else is rejected on save rather
/// than silently treated as `none`, so a provider imported from a newer build
/// reports the problem instead of quietly losing its request shaping.
pub fn is_supported_request_adapter(id: &str) -> bool {
    let id = id.trim();
    id.is_empty() || id == ADAPTER_NONE || id == ADAPTER_OPENCODE_GO
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

    fn blank_input(preset_id: Option<&str>) -> crate::models::CreateProviderInput {
        crate::models::CreateProviderInput {
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
            }
            if matches!(preset.usage_type.as_str(), "newapi" | "opencode-go") {
                assert!(preset.usage_url.is_some(), "{}: usage url", preset.id);
                assert!(
                    preset.usage_headers.is_some(),
                    "{}: usage headers",
                    preset.id
                );
            }
        }
    }

    /// The account query is on for every preset that knows how to ask; only the
    /// blank template leaves it off, because it knows nothing to ask.
    #[test]
    fn a_preset_queries_the_account_by_default_except_the_blank_one() {
        let presets = provider_presets();
        let silent: Vec<&str> = presets
            .iter()
            .filter(|preset| {
                preset.wallet_balance_type == "none" && preset.usage_type != "opencode-go"
            })
            .map(|preset| preset.id.as_str())
            .collect();

        assert_eq!(silent, vec![PRESET_CUSTOM]);
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
    fn opencode_go_selects_its_adapter_and_keeps_zen_in_the_path() {
        let preset = provider_preset(PRESET_OPENCODE_GO).expect("go preset");

        assert_eq!(preset.base_url, "https://opencode.ai/zen/go");
        assert_eq!(preset.request_adapter, ADAPTER_OPENCODE_GO);
        assert_eq!(preset.usage_type, "opencode-go");

        // Every default is a model that answered on the protocol it is used
        // for; the list is maintained by hand because the model list carries no
        // protocol metadata.
        let mapping: serde_json::Value =
            serde_json::from_str(preset.default_key_config.model_mapping.as_deref().unwrap())
                .unwrap();
        assert!(opencode_go_models::MESSAGES.contains(&mapping["sonnet"].as_str().unwrap()));
        assert!(opencode_go_models::MESSAGES.contains(&mapping["opus"].as_str().unwrap()));
        assert!(opencode_go_models::MESSAGES.contains(&mapping["haiku"].as_str().unwrap()));
        assert!(opencode_go_models::RESPONSES.contains(&mapping["codex"].as_str().unwrap()));
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

    #[test]
    fn only_implemented_adapter_ids_are_accepted() {
        assert!(is_supported_request_adapter(""));
        assert!(is_supported_request_adapter("none"));
        assert!(is_supported_request_adapter("opencode-go"));
        assert!(!is_supported_request_adapter("from-a-newer-build"));
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
