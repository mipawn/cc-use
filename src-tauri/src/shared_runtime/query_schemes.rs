//! The named query schemes the catalogue ships, and the account/key boundary.
//!
//! A scheme is a *named configuration* for one of the queries the product has
//! verified: which credential it needs, whether it reports metering windows,
//! and the exact script that runs. The user picks a scheme by name; the
//! renderer shows the credential fields and the ability labels, not the code.
//! The script text is composed from `account_scripts`, so the catalogue here
//! stays the single owner of what a supported query actually sends.
//!
//! Two scopes exist and they do not share entries:
//! - `account` — "how much does this provider account have left". These are
//!   the provider-level queries (DeepSeek, New API).
//! - `key` — "how much does *this one API key* have left, on its own". New
//!   API's per-key route, plus OpenCode Go's and Command Code's metering
//!   queries, whose quotas are per key: one key is one account.
//!
//! The boundary is enforced where queries run, not asserted by labels: a
//! script whose requests point at the remaining account destinations may not
//! be run as a key quota query (see [`account_target_urls`] and its runtime
//! guard). The OpenCode Go `/v1/usage` and Command Code billing endpoints are
//! deliberately *not* on that list any more — they are legitimate key-scope
//! targets now.

/// Scope ids as they appear in `queryConfig.schemeId` and the IPC surface.
pub const SCOPE_ACCOUNT: &str = "account";
pub const SCOPE_KEY: &str = "key";

/// The per-provider account schemes.
pub const SCHEME_DEEPSEEK_ACCOUNT: &str = "deepseek-account";
pub const SCHEME_NEWAPI_ACCOUNT: &str = "newapi-account";
/// The verified per-key quota schemes.
pub const SCHEME_NEWAPI_KEY: &str = "newapi-key";
pub const SCHEME_OPENCODE_GO_KEY: &str = "opencode-go-key";
pub const SCHEME_COMMAND_CODE_KEY: &str = "command-code-key";
/// Any script the catalogue cannot recognise is the user's own.
pub const SCHEME_CUSTOM: &str = "custom";

/// The per-scheme association between an enabled flag and the chosen scheme.
///
/// Stored next to the script (providers and keys) because "off but remember
/// what was configured" must survive a save: a closed query keeps its scheme
/// and its script, and turning it back on runs exactly what was there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryConfig {
    pub enabled: bool,
    /// A catalogue id, or `custom` for a hand-written script.
    pub scheme_id: String,
}

impl QueryConfig {
    pub fn disabled_custom() -> Self {
        Self {
            enabled: false,
            scheme_id: SCHEME_CUSTOM.to_string(),
        }
    }
}

/// What a scheme needs before its requests can resolve at all.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CredentialRequirement {
    /// An API key. For the account scope this is borrowed from the enabled,
    /// unexhausted keys of the provider; for the key scope it is that key.
    ApiKey,
    /// The service's account token (New API), separate from the key.
    AccessToken,
    /// The service's account user id (New API), sent beside the token.
    UserId,
}

impl CredentialRequirement {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ApiKey => "apiKey",
            Self::AccessToken => "accessToken",
            Self::UserId => "userId",
        }
    }
}

/// One catalogue entry. `script` is composed at access time so the text and
/// `account_scripts` cannot drift apart.
#[derive(Debug, Clone)]
pub struct QueryScheme {
    pub id: &'static str,
    pub scope: &'static str,
    /// i18n key for the user-facing name (`querySchemes.<…>`).
    pub label_key: &'static str,
    /// i18n key for one line naming the endpoint and the credential.
    pub description_key: &'static str,
    pub credentials: &'static [CredentialRequirement],
    /// `true` when the service reports metering periods (5h / weekly /
    /// monthly) rather than only an amount. A capability of the scheme in
    /// either scope: the key scope renders windows too.
    pub supports_windows: bool,
}

/// The full script text a scheme runs, in the engine's single form. The
/// multi-request Command Code script ships whole already.
pub fn scheme_script(id: &str) -> Option<String> {
    use super::account_scripts::{
        command_code_script, for_legacy_kind, key_usage_for_legacy_kind, script_for,
    };

    let script = match id {
        SCHEME_DEEPSEEK_ACCOUNT => script_for(for_legacy_kind("deepseek")?),
        SCHEME_NEWAPI_ACCOUNT => script_for(for_legacy_kind("newapi")?),
        SCHEME_NEWAPI_KEY => script_for(key_usage_for_legacy_kind("newapi")?),
        // The Go account script is the per-key script: it answers with the
        // key's own metering periods and needs nothing but `{{apiKey}}`.
        SCHEME_OPENCODE_GO_KEY => script_for(for_legacy_kind("opencode-go")?),
        // Command Code's multi-request script is a constant, not a composed
        // single form.
        SCHEME_COMMAND_CODE_KEY => command_code_script().to_string(),
        _ => return None,
    };
    Some(script)
}

/// The account-scope entries, in display order.
pub fn account_schemes() -> Vec<QueryScheme> {
    vec![
        QueryScheme {
            id: SCHEME_DEEPSEEK_ACCOUNT,
            scope: SCOPE_ACCOUNT,
            label_key: "querySchemes.deepseekAccount",
            description_key: "querySchemes.deepseekAccountDescription",
            credentials: &[CredentialRequirement::ApiKey],
            supports_windows: false,
        },
        QueryScheme {
            id: SCHEME_NEWAPI_ACCOUNT,
            scope: SCOPE_ACCOUNT,
            label_key: "querySchemes.newApiAccount",
            description_key: "querySchemes.newApiAccountDescription",
            credentials: &[
                CredentialRequirement::AccessToken,
                CredentialRequirement::UserId,
            ],
            supports_windows: false,
        },
    ]
}

/// The key-scope entries, in display order. Only services whose quota is
/// genuinely per key ship here; no account entry doubles as one.
pub fn key_schemes() -> Vec<QueryScheme> {
    vec![
        QueryScheme {
            id: SCHEME_NEWAPI_KEY,
            scope: SCOPE_KEY,
            label_key: "querySchemes.newApiKey",
            description_key: "querySchemes.newApiKeyDescription",
            credentials: &[CredentialRequirement::ApiKey],
            supports_windows: false,
        },
        QueryScheme {
            id: SCHEME_OPENCODE_GO_KEY,
            scope: SCOPE_KEY,
            label_key: "querySchemes.openCodeGoKey",
            description_key: "querySchemes.openCodeGoKeyDescription",
            credentials: &[CredentialRequirement::ApiKey],
            supports_windows: true,
        },
        QueryScheme {
            id: SCHEME_COMMAND_CODE_KEY,
            scope: SCOPE_KEY,
            label_key: "querySchemes.commandCodeKey",
            description_key: "querySchemes.commandCodeKeyDescription",
            credentials: &[CredentialRequirement::ApiKey],
            supports_windows: true,
        },
    ]
}

pub fn scheme_for(scope: &str, id: &str) -> Option<QueryScheme> {
    let schemes = match scope {
        SCOPE_ACCOUNT => account_schemes(),
        SCOPE_KEY => key_schemes(),
        _ => return None,
    };
    schemes.into_iter().find(|scheme| scheme.id == id)
}

/// An entry for the IPC surface. Serde-camels the fields; the labels stay
/// localization keys so zh/en copy lives in one place per language.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySchemeInfo {
    pub id: String,
    pub scope: String,
    pub label_key: String,
    pub description_key: String,
    pub credential_requirements: Vec<String>,
    pub supports_windows: bool,
    /// The whole script the scheme runs. The editor stores it verbatim on
    /// save (the migration contract), and "基于此方案自定义" reads from it.
    pub script: String,
}

impl From<&QueryScheme> for QuerySchemeInfo {
    fn from(scheme: &QueryScheme) -> Self {
        Self {
            id: scheme.id.to_string(),
            scope: scheme.scope.to_string(),
            label_key: scheme.label_key.to_string(),
            description_key: scheme.description_key.to_string(),
            credential_requirements: scheme
                .credentials
                .iter()
                .map(CredentialRequirement::as_str)
                .map(str::to_string)
                .collect(),
            supports_windows: scheme.supports_windows,
            script: scheme_script(scheme.id).unwrap_or_default(),
        }
    }
}

pub fn scheme_infos_for_scope(scope: Option<&str>) -> Result<Vec<QuerySchemeInfo>, String> {
    match scope {
        None => Ok(account_schemes()
            .iter()
            .chain(key_schemes().iter())
            .map(QuerySchemeInfo::from)
            .collect()),
        Some(SCOPE_ACCOUNT) => Ok(account_schemes()
            .iter()
            .map(QuerySchemeInfo::from)
            .collect()),
        Some(SCOPE_KEY) => Ok(key_schemes().iter().map(QuerySchemeInfo::from).collect()),
        Some(other) => Err(format!("未知的查询范围：{other}")),
    }
}

/// Read a stored `query_config` column. A missing, empty or malformed value
/// means "saved before this field existed"; the caller falls back to the
/// script-presence rule instead of guessing a state.
pub fn parse_query_config(raw: Option<&str>) -> Option<QueryConfig> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let config: QueryConfig = serde_json::from_str(raw).ok()?;
    // An unknown scheme id is not silently renamed — the UI explains it as
    // unrecognised and keeps the script as-is.
    Some(config)
}

pub fn serialize_query_config(config: &QueryConfig) -> Option<String> {
    serde_json::to_string(config).ok()
}

/// What "enabled" means for a row before it was ever saved with a config.
///
/// A script that is present was deliberately configured; there was no
/// per-scheme switch below v3.18.0, so the presence is the intent. An empty
/// script means the query was never configured.
pub fn legacy_query_config(script: Option<&str>) -> Option<QueryConfig> {
    let script = script?.trim();
    if script.is_empty() {
        return None;
    }
    Some(QueryConfig {
        enabled: true,
        scheme_id: recognise_account_scheme(script)
            .or_else(|| recognise_key_scheme(script))
            .unwrap_or(SCHEME_CUSTOM)
            .to_string(),
    })
}

/// The effective config for running a row: the stored one when present,
/// otherwise the pre-config legacy rule.
pub fn effective_query_config(
    config: Option<&QueryConfig>,
    script: Option<&str>,
) -> Option<QueryConfig> {
    match config {
        Some(config) => Some(config.clone()),
        None => legacy_query_config(script),
    }
}

/// The catalogue id for a script that is byte-identical to a scheme's text.
///
/// Recognition is evidence, not a label: a script that was merely authored
/// with the same code reads as the scheme it copied; anything else (even a
/// `<scheme script> + comment`) stays custom and is never rewritten.
pub fn recognise_account_scheme(script: &str) -> Option<&'static str> {
    account_schemes()
        .iter()
        .find(|scheme| {
            scheme_script(scheme.id)
                .map(|text| text == script)
                .unwrap_or(false)
        })
        .map(|scheme| scheme.id)
}

pub fn recognise_key_scheme(script: &str) -> Option<&'static str> {
    key_schemes()
        .iter()
        .find(|scheme| {
            scheme_script(scheme.id)
                .map(|text| text == script)
                .unwrap_or(false)
        })
        .map(|scheme| scheme.id)
}

/// The request URLs a key-scope script must not hit, given the provider it
/// runs against.
///
/// The account schemes' URLs are templates; substituting the provider's base
/// address turns them into the concrete targets the account scope reads. A
/// key quota script pointing at one of these is asking the account question,
/// and the runtime refuses it with a repair message instead of reporting the
/// account's numbers as the key's quota.
pub fn account_target_urls(base_url: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let base = base_url.trim().trim_end_matches('/').to_string();
    for scheme in account_schemes() {
        match scheme.id {
            SCHEME_DEEPSEEK_ACCOUNT => {
                urls.push("https://api.deepseek.com/user/balance".to_string());
            }
            SCHEME_NEWAPI_ACCOUNT => {
                urls.push(format!("{base}/api/user/self"));
            }
            _ => {}
        }
    }
    // A hand-written starter/relay account balance endpoint: targeting it
    // answers the account question even though no catalogue entry owns the
    // template.
    urls.push(format!("{base}/api/user/balance"));
    urls
}

/// Domain message a key-scope query gets when its script points at an account
/// destination. Stated as a repair, not as a refusal grudge.
pub const KEY_QUERY_ACCOUNT_TARGET_MESSAGE: &str = "该脚本查询的是账户级额度，不是当前密钥的独立额度；请在“密钥额度”区选择支持的方案或使用自定义脚本";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_scopes_are_separate_catalogues() {
        let account_ids: Vec<_> = account_schemes().iter().map(|s| s.id).collect();
        let key_ids: Vec<_> = key_schemes().iter().map(|s| s.id).collect();

        assert_eq!(
            account_ids,
            [SCHEME_DEEPSEEK_ACCOUNT, SCHEME_NEWAPI_ACCOUNT],
            "OpenCode Go / Command Code no longer offer an account query"
        );
        assert_eq!(
            key_ids,
            [
                SCHEME_NEWAPI_KEY,
                SCHEME_OPENCODE_GO_KEY,
                SCHEME_COMMAND_CODE_KEY
            ],
            "the key catalogue lists one scheme per verified per-key service"
        );
        for scheme in key_schemes() {
            assert_eq!(scheme.scope, SCOPE_KEY);
            assert_eq!(scheme.credentials.len(), 1);
            assert_eq!(scheme.credentials[0], CredentialRequirement::ApiKey);
        }
        for scheme in account_schemes() {
            assert_eq!(scheme.scope, SCOPE_ACCOUNT);
        }
        assert!(scheme_for(SCOPE_KEY, SCHEME_DEEPSEEK_ACCOUNT).is_none());
        assert!(scheme_for(SCOPE_ACCOUNT, SCHEME_NEWAPI_KEY).is_none());
        assert!(scheme_for(SCOPE_ACCOUNT, SCHEME_OPENCODE_GO_KEY).is_none());
        assert!(scheme_for(SCOPE_KEY, SCHEME_COMMAND_CODE_KEY).is_some());
        // The retired account ids are no longer recognised by any catalogue;
        // the migration clears the provider rows that carried them.
        assert!(scheme_for(SCOPE_ACCOUNT, "opencode-go-account").is_none());
        assert!(scheme_for(SCOPE_ACCOUNT, "command-code-account").is_none());
    }

    /// `supports_windows` is a capability of the scheme, not of the scope: the
    /// two metering services report windows as key schemes now.
    #[test]
    fn window_capability_follows_the_service_not_the_scope() {
        for scheme in key_schemes() {
            match scheme.id {
                SCHEME_OPENCODE_GO_KEY | SCHEME_COMMAND_CODE_KEY => {
                    assert!(scheme.supports_windows, "{} meters by period", scheme.id)
                }
                _ => assert!(!scheme.supports_windows),
            }
        }
        for scheme in account_schemes() {
            assert!(!scheme.supports_windows, "{} is amount-only", scheme.id);
        }
    }

    /// The multi-request Command Code script ships whole as a key scheme and
    /// resolves to its three named requests.
    #[test]
    fn the_command_code_key_scheme_resolves_to_its_three_requests() {
        let script = scheme_script(SCHEME_COMMAND_CODE_KEY).expect("command code script");
        let vars = crate::services::query_script::ScriptVars {
            base_url: "https://api.commandcode.ai/provider".to_string(),
            api_key: Some("sk-live".to_string()),
            access_token: None,
            user_id: None,
        };
        let resolved = crate::services::query_script::resolve_requests(
            &script,
            &vars,
            &crate::services::query_script::ScriptLimits::default(),
        )
        .expect("the shipped key script resolves");

        let crate::services::query_script::ResolvedRequests::Many(named) = resolved else {
            panic!("the command code script is a named-request script");
        };
        let mut names: Vec<&str> = named.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, ["credit", "subscription", "summary"]);
        assert!(!named["credit"].optional);
        assert!(named["subscription"].optional);
        assert!(named["summary"].optional);
        assert_eq!(
            named["credit"].request.url,
            super::super::account_scripts::COMMAND_CODE_CREDITS_URL
        );
    }

    #[test]
    fn every_scheme_script_is_composable() {
        for scheme in account_schemes().iter().chain(key_schemes().iter()) {
            let script =
                scheme_script(scheme.id).unwrap_or_else(|| panic!("{} has no script", scheme.id));
            assert!(!script.trim().is_empty());
            assert!(
                script.contains("extractor"),
                "{} must carry an extractor",
                scheme.id
            );
        }
    }

    #[test]
    fn recognition_is_whole_text_only() {
        let deepseek = scheme_script(SCHEME_DEEPSEEK_ACCOUNT).expect("deepseek script");
        assert_eq!(
            recognise_account_scheme(&deepseek),
            Some(SCHEME_DEEPSEEK_ACCOUNT)
        );
        // One character of user edit is a saved choice: custom, original kept.
        let edited = format!("{deepseek}\n// mine");
        assert_eq!(recognise_account_scheme(&edited), None);

        let key_script = scheme_script(SCHEME_NEWAPI_KEY).expect("key script");
        assert_eq!(recognise_key_scheme(&key_script), Some(SCHEME_NEWAPI_KEY));
        assert_eq!(recognise_key_scheme(&deepseek), None);
    }

    #[test]
    fn the_account_script_is_never_recognised_in_the_key_catalogue() {
        let account = scheme_script(SCHEME_NEWAPI_ACCOUNT).expect("newapi script");
        assert_eq!(recognise_key_scheme(&account), None);
        assert_ne!(
            scheme_script(SCHEME_NEWAPI_ACCOUNT),
            scheme_script(SCHEME_NEWAPI_KEY)
        );
    }

    #[test]
    fn stored_configs_parse_and_survive_roundtrip() {
        let config = QueryConfig {
            enabled: false,
            scheme_id: SCHEME_COMMAND_CODE_KEY.to_string(),
        };
        let raw = serialize_query_config(&config).expect("serialises");
        assert_eq!(parse_query_config(Some(&raw)), Some(config));

        // Pre-config rows and junk stay legacy.
        assert_eq!(parse_query_config(None), None);
        assert_eq!(parse_query_config(Some("")), None);
        assert_eq!(parse_query_config(Some("not json")), None);
    }

    #[test]
    fn legacy_rows_enable_the_query_when_a_script_exists() {
        let script = scheme_script(SCHEME_DEEPSEEK_ACCOUNT).expect("deepseek script");
        let derived = legacy_query_config(Some(&script)).expect("script means configured");
        assert!(derived.enabled);
        assert_eq!(derived.scheme_id, SCHEME_DEEPSEEK_ACCOUNT);

        // An unrecognised script is enabled and custom — never rewritten.
        let derived =
            legacy_query_config(Some("({request:{url:'{{baseUrl}}/x'}})")).expect("configured");
        assert_eq!(derived.scheme_id, SCHEME_CUSTOM);

        assert_eq!(legacy_query_config(Some("   ")), None);
        assert_eq!(legacy_query_config(None), None);
    }

    #[test]
    fn account_targets_cover_every_remaining_account_destination() {
        let targets = account_target_urls("https://relay.example.com/");
        assert!(targets.contains(&"https://api.deepseek.com/user/balance".to_string()));
        assert!(targets.contains(&"https://relay.example.com/api/user/self".to_string()));
        assert!(targets.contains(&"https://relay.example.com/api/user/balance".to_string()));
        // OpenCode Go's /v1/usage and the Command Code billing routes are key
        // targets now: refusing them would refuse the shipped key schemes.
        assert!(!targets.contains(&"https://relay.example.com/v1/usage".to_string()));
        assert!(!targets.iter().any(|url| url.contains("commandcode.ai")));
        // The full-text key script for Command Code targets that host, so it
        // must not be blocked by the account-target guard.
        let key_script = scheme_script(SCHEME_COMMAND_CODE_KEY).expect("command code script");
        assert!(key_script.contains("api.commandcode.ai"));
        let key_script = scheme_script(SCHEME_OPENCODE_GO_KEY).expect("opencode script");
        assert!(key_script.contains("{{baseUrl}}/v1/usage"));
    }
}
