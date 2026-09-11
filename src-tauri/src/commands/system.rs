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

    save_icon(&icons_dir, &buffer, &filename)
}

fn icon_mime(filename: &str) -> Option<&'static str> {
    match std::path::Path::new(filename)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn save_icon(directory: &std::path::Path, buffer: &[u8], filename: &str) -> Result<String, String> {
    if buffer.is_empty() || buffer.len() > 5 * 1024 * 1024 {
        return Err("图标文件必须在 5 MB 以内且不能为空".into());
    }
    icon_mime(filename).ok_or("请选择 PNG、JPEG、WebP、GIF、SVG 或 ICO 图片")?;
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap();
    // A new upload is a new library entry, even when the original names match.
    let name = format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        extension.to_ascii_lowercase()
    );
    std::fs::write(directory.join(&name), buffer).map_err(|e| e.to_string())?;
    Ok(name)
}

fn read_icon(directory: &std::path::Path, path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let name = urlencoding::decode(path.trim_start_matches('/')).map_err(|e| e.to_string())?;
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Invalid icon name".into());
    }
    let mime = icon_mime(&name).ok_or("Unsupported icon format")?;
    let file = directory.join(name.as_ref());
    // The protocol serves regular library files only, never symlinks elsewhere.
    let metadata = std::fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 5 * 1024 * 1024 {
        return Err("Invalid icon file".into());
    }
    Ok((std::fs::read(file).map_err(|e| e.to_string())?, mime))
}

pub fn icon_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    match get_icons_dir().and_then(|directory| read_icon(&directory, path)) {
        Ok((bytes, mime)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'",
            )
            .body(bytes)
            .unwrap(),
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap(),
    }
}

#[tauri::command]
pub fn icon_list() -> Result<serde_json::Value, String> {
    let preset = vec![
        "claude", "codex", "gemini", "zhipu", "minimax", "xiaomi", "deepseek", "custom",
    ];

    let icons_dir = get_icons_dir()?;
    let uploaded: Vec<String> = if icons_dir.exists() {
        std::fs::read_dir(&icons_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                entry
                    .ok()
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .and_then(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|name| icon_mime(name).is_some())
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
    #[cfg(not(target_os = "macos"))]
    let base = PathBuf::from(".");

    Ok(base.join(dir_name).join("icons"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploads_are_distinct_library_entries_and_can_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_icon(dir.path(), b"test image", "logo.png").unwrap();
        let second = save_icon(dir.path(), b"another image", "logo.png").unwrap();
        assert_ne!(first, second);
        let (data, mime) = read_icon(dir.path(), &format!("/{first}")).unwrap();
        assert_eq!(data, b"test image");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn library_rejects_traversal_and_non_images() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_icon(dir.path(), "/%2e%2e%2fsecret.png").is_err());
        assert!(save_icon(dir.path(), b"html", "logo.html").is_err());
        assert!(save_icon(dir.path(), b"", "logo.png").is_err());
    }
}
