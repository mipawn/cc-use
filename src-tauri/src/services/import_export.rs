use crate::db::Database;
use crate::models::{
    CreateApiKeyInput, CreateProviderInput, ExportApiKey, ExportData, ExportOptions,
    ExportProvider, ImportOptions, ImportResult,
};

pub fn export_all(db: &Database) -> Result<ExportData, String> {
    export_selected(db, &ExportOptions::default())
}

pub fn export_selected(db: &Database, options: &ExportOptions) -> Result<ExportData, String> {
    let mut export_providers = Vec::new();

    if options.include_providers {
        let providers = db.provider_list().map_err(|e| e.to_string())?;
        for provider in providers {
            let keys = db.api_key_list(&provider.id).map_err(|e| e.to_string())?;
            let export_keys: Vec<ExportApiKey> = keys
                .into_iter()
                .map(|k| ExportApiKey {
                    id: k.id,
                    alias: k.alias,
                    value: k.value,
                    types: Some(k.types),
                    priority: k.priority,
                    cost_multiplier: Some(k.cost_multiplier),
                })
                .collect();

            export_providers.push(ExportProvider {
                id: provider.id,
                name: provider.name,
                provider_type: provider
                    .provider_type
                    .unwrap_or_else(|| "claude".to_string()),
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
    }

    let usage_logs = if options.include_usage_logs {
        db.usage_log_list_all().map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let request_logs = if options.include_request_logs {
        db.request_log_list_all().map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };

    Ok(ExportData {
        version: "2.0".to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        providers: export_providers,
        usage_logs,
        request_logs,
    })
}

pub fn import_all(
    db: &Database,
    data: &ExportData,
    options: &ImportOptions,
) -> Result<ImportResult, String> {
    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();

    let preserve_ids = data.version.starts_with('2');

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
                if let Err(e) = db.provider_delete(&existing_provider.id) {
                    errors.push(format!(
                        "Failed to delete existing provider {}: {}",
                        ep.name, e
                    ));
                    continue;
                }
            }
        }

        // Create provider
        if preserve_ids && !ep.id.is_empty() {
            // NOTE: we preserve IDs from export so that logs keep relationships.
            if let Err(e) = db.conn.execute(
                "INSERT OR REPLACE INTO providers (id, name, base_url, type, website, remark, token, icon,
                    wallet_balance_type, wallet_balance_url, wallet_balance_path, wallet_balance_headers,
                    wallet_balance_user_id, usage_type, usage_url, usage_path, usage_headers, is_active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14, ?15, 1)",
                rusqlite::params![
                    ep.id,
                    ep.name,
                    ep.base_url,
                    ep.provider_type,
                    ep.website,
                    ep.remark,
                    ep.icon,
                    ep.wallet_balance_type.as_deref().unwrap_or("none"),
                    ep.wallet_balance_url,
                    ep.wallet_balance_path,
                    ep.wallet_balance_headers,
                    ep.usage_type.as_deref().unwrap_or("none"),
                    ep.usage_url,
                    ep.usage_path,
                    ep.usage_headers,
                ],
            ) {
                errors.push(format!("Failed to import {}: {}", ep.name, e));
                continue;
            }

            // Create API keys (preserve IDs)
            for ek in &ep.api_keys {
                if ek.id.is_empty() {
                    continue;
                }
                let types_json = serde_json::to_string(
                    &ek.types
                        .clone()
                        .unwrap_or_else(|| vec!["claude".to_string()]),
                )
                .unwrap_or_else(|_| "[\"claude\"]".to_string());

                if let Err(e) = db.conn.execute(
                    "INSERT OR REPLACE INTO api_keys (id, provider_id, alias, value, types, priority, is_exhausted, is_active,
                        config, usage_type, usage_url, usage_path, usage_headers, cost_multiplier)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 1, NULL, 'none', NULL, NULL, NULL, ?7)",
                    rusqlite::params![
                        ek.id,
                        ep.id,
                        ek.alias,
                        ek.value,
                        types_json,
                        ek.priority,
                        ek.cost_multiplier.unwrap_or(1.0),
                    ],
                ) {
                    errors.push(format!("Failed to import key for {}: {}", ep.name, e));
                }
            }

            imported += 1;
        } else {
            // Backward-compatible import for old exports that don't carry stable IDs.
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
                    for ek in &ep.api_keys {
                        if let Err(e) = db.api_key_create(&CreateApiKeyInput {
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
                            model_mapping: None,
                        }) {
                            errors.push(format!("Failed to import key for {}: {}", ep.name, e));
                        }
                    }
                    imported += 1;
                }
                Err(e) => errors.push(format!("Failed to import {}: {}", ep.name, e)),
            }
        }
    }

    // Import logs (usage + request). Projects are intentionally NOT imported, so we temporarily
    // disable foreign key checks while inserting logs that reference project_id.
    // Only import logs if present (old exports default to empty lists).
    if data.usage_logs.is_empty() && data.request_logs.is_empty() {
        return Ok(ImportResult {
            imported,
            skipped,
            errors,
        });
    }

    let disable_fk_and_begin = db
        .conn
        .execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string());

    if disable_fk_and_begin.is_ok() {
        let import_logs_result: Result<(), String> = (|| {
            for log in &data.usage_logs {
                db.usage_log_upsert(log).map_err(|e| e.to_string())?;
            }
            for log in &data.request_logs {
                db.request_log_upsert(log).map_err(|e| e.to_string())?;
            }
            Ok(())
        })();

        match import_logs_result {
            Ok(()) => {
                let _ = db.conn.execute_batch("COMMIT; PRAGMA foreign_keys = ON;");
            }
            Err(e) => {
                let _ = db.conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
                errors.push(format!("Failed to import logs: {}", e));
            }
        }
    } else {
        errors.push("Failed to start log import transaction".to_string());
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors,
    })
}

pub fn validate(data: &serde_json::Value) -> bool {
    data.get("version").is_some() && data.get("providers").and_then(|p| p.as_array()).is_some()
}
