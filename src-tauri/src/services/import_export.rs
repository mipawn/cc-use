use crate::db::Database;
use crate::models::{ExportData, ExportProvider, ExportApiKey, ImportOptions, ImportResult, CreateProviderInput, CreateApiKeyInput};

pub fn export_all(db: &Database) -> Result<ExportData, String> {
    let providers = db.provider_list().map_err(|e| e.to_string())?;
    let mut export_providers = Vec::new();

    for provider in providers {
        let keys = db.api_key_list(&provider.id).map_err(|e| e.to_string())?;
        let export_keys: Vec<ExportApiKey> = keys.into_iter().map(|k| ExportApiKey {
            alias: k.alias,
            value: k.value,
            types: Some(k.types),
            priority: k.priority,
            cost_multiplier: Some(k.cost_multiplier),
        }).collect();

        export_providers.push(ExportProvider {
            name: provider.name,
            provider_type: provider.provider_type.unwrap_or_else(|| "claude".to_string()),
            base_url: provider.base_url,
            website: provider.website,
            remark: provider.remark,
            icon: provider.icon,
            wallet_balance_type: Some(provider.wallet_balance_type),
            wallet_balance_url: provider.wallet_balance_url,
            wallet_balance_path: provider.wallet_balance_path,
            wallet_balance_headers: provider.wallet_balance_headers,
            usage_type: Some(provider.usage_type),
            usage_url: provider.usage_url,
            usage_path: provider.usage_path,
            usage_headers: provider.usage_headers,
            api_keys: export_keys,
        });
    }

    Ok(ExportData {
        version: "1.0".to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        providers: export_providers,
    })
}

pub fn import_all(db: &Database, data: &ExportData, options: &ImportOptions) -> Result<ImportResult, String> {
    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();

    for ep in &data.providers {
        // Check if provider with same name exists
        let existing = db.provider_list().map_err(|e| e.to_string())?;
        let exists = existing.iter().find(|p| p.name == ep.name);

        if exists.is_some() && !options.overwrite {
            skipped += 1;
            continue;
        }

        // Delete existing if overwriting
        if let Some(existing_provider) = exists {
            if options.overwrite {
                let _ = db.provider_delete(&existing_provider.id);
            }
        }

        // Create provider
        match db.provider_create(&CreateProviderInput {
            name: ep.name.clone(),
            base_url: ep.base_url.clone(),
            provider_type: Some(ep.provider_type.clone()),
            website: ep.website.clone(),
            remark: ep.remark.clone(),
            token: None,
            icon: ep.icon.clone(),
            wallet_balance_type: ep.wallet_balance_type.clone(),
            wallet_balance_url: ep.wallet_balance_url.clone(),
            wallet_balance_path: ep.wallet_balance_path.clone(),
            wallet_balance_headers: ep.wallet_balance_headers.clone(),
            wallet_balance_user_id: None,
            usage_type: ep.usage_type.clone(),
            usage_url: ep.usage_url.clone(),
            usage_path: ep.usage_path.clone(),
            usage_headers: ep.usage_headers.clone(),
        }) {
            Ok(provider) => {
                // Create API keys
                for ek in &ep.api_keys {
                    let _ = db.api_key_create(&CreateApiKeyInput {
                        provider_id: provider.id.clone(),
                        alias: ek.alias.clone(),
                        value: ek.value.clone(),
                        types: ek.types.clone(),
                        priority: Some(ek.priority),
                        is_active: Some(true),
                        config: None,
                        cost_multiplier: ek.cost_multiplier,
                        usage_type: None,
                        usage_url: None,
                        usage_path: None,
                        usage_headers: None,
                    });
                }
                imported += 1;
            }
            Err(e) => {
                errors.push(format!("Failed to import {}: {}", ep.name, e));
            }
        }
    }

    Ok(ImportResult { imported, skipped, errors })
}

pub fn validate(data: &serde_json::Value) -> bool {
    data.get("version").is_some() && data.get("providers").and_then(|p| p.as_array()).is_some()
}
