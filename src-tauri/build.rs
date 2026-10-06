fn main() {
    // These workspace sidecars depend on this library. tauri-build normally
    // copies staged externalBin files into target/<profile>, overwriting their
    // current Cargo artifacts (and requiring placeholders on a clean build).
    // Only suppress that build-script copy: the CLI keeps the original bundle
    // config and scripts/cargo-build.mjs stages the freshly built sidecars.
    let mut config: serde_json::Value =
        serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_else(|_| "{}".into()))
            .expect("TAURI_CONFIG must be valid JSON");
    config["bundle"]["externalBin"] = serde_json::json!([]);
    std::env::set_var("TAURI_CONFIG", config.to_string());
    tauri_build::build()
}
