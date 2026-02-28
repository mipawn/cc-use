use std::path::PathBuf;

#[tauri::command]
pub fn app_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn system_get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn system_open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn icon_upload(buffer: Vec<u8>, filename: String) -> Result<String, String> {
    let icons_dir = get_icons_dir()?;
    std::fs::create_dir_all(&icons_dir).map_err(|e| e.to_string())?;

    let dest = icons_dir.join(&filename);
    std::fs::write(&dest, &buffer).map_err(|e| e.to_string())?;

    Ok(filename)
}

#[tauri::command]
pub fn icon_list() -> Result<serde_json::Value, String> {
    let preset = vec!["claude", "codex", "gemini", "zhipu", "minimax", "xiaomi", "deepseek", "custom"];

    let icons_dir = get_icons_dir().unwrap_or_default();
    let uploaded: Vec<String> = if icons_dir.exists() {
        std::fs::read_dir(&icons_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                entry.ok().and_then(|e| {
                    e.file_name().to_str().map(|s| s.to_string())
                })
            })
            .collect()
    } else {
        vec![]
    };

    Ok(serde_json::json!({
        "preset": preset,
        "uploaded": uploaded,
    }))
}

fn get_icons_dir() -> Result<PathBuf, String> {
    let dir_name = if cfg!(debug_assertions) {
        "com.mipawn.cc-use.dev"
    } else {
        "com.mipawn.cc-use"
    };

    #[cfg(target_os = "macos")]
    let base = dirs::data_dir().ok_or("Cannot find data dir")?;
    #[cfg(target_os = "windows")]
    let base = dirs::data_dir().ok_or("Cannot find data dir")?;
    #[cfg(target_os = "linux")]
    let base = dirs::data_dir().ok_or("Cannot find data dir")?;
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let base = PathBuf::from(".");

    Ok(base.join(dir_name).join("icons"))
}
