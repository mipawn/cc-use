use std::path::Path;
use toml_edit::{DocumentMut, Item, Table};

pub const CC_USE_MODEL_KEY: &str = "cc-use";

fn update_managed_config(path: &Path, proxy_port: i32, upstream_model: &str) -> Result<(), String> {
    let mut document = if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Grok managed config: {}", error))?
            .parse::<DocumentMut>()
            .map_err(|error| format!("Failed to parse Grok managed config: {}", error))?
    } else {
        DocumentMut::new()
    };

    let mut model = Table::new();
    model["model"] = toml_edit::value(upstream_model);
    model["base_url"] = toml_edit::value(format!("http://127.0.0.1:{}/v1", proxy_port));
    model["name"] = toml_edit::value("CC Use");
    model["description"] = toml_edit::value("Local cc-use gateway");
    model["env_key"] = toml_edit::value("CC_USE_GROK_TOKEN");
    model["api_backend"] = toml_edit::value("responses");
    model["supports_backend_search"] = toml_edit::value(false);

    let root = document.as_table_mut();
    if !root.get("model").is_some_and(Item::is_table) {
        root.insert("model", Item::Table(Table::new()));
    }
    let models = root
        .get_mut("model")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Failed to create Grok model config table".to_string())?;
    models.insert(CC_USE_MODEL_KEY, Item::Table(model));

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Grok config directory: {}", error))?;
    }
    std::fs::write(path, document.to_string())
        .map_err(|error| format!("Failed to write Grok managed config: {}", error))
}

pub fn ensure_managed_config(proxy_port: i32, upstream_model: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    update_managed_config(
        &home.join(".grok").join("managed_config.toml"),
        proxy_port,
        upstream_model,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_config_preserves_existing_settings_and_updates_cc_use_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed_config.toml");
        std::fs::write(&path, "[ui]\npermission_mode = \"ask\"\n").unwrap();

        update_managed_config(&path, 12345, "grok-upstream").unwrap();
        let document = std::fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();

        assert_eq!(document["ui"]["permission_mode"].as_str(), Some("ask"));
        assert_eq!(
            document["model"][CC_USE_MODEL_KEY]["model"].as_str(),
            Some("grok-upstream")
        );
        assert_eq!(
            document["model"][CC_USE_MODEL_KEY]["base_url"].as_str(),
            Some("http://127.0.0.1:12345/v1")
        );
        assert_eq!(
            document["model"][CC_USE_MODEL_KEY]["env_key"].as_str(),
            Some("CC_USE_GROK_TOKEN")
        );
    }
}
