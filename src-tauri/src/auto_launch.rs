//! Login-item (auto-launch on boot) management.
//!
//! Wraps the `auto-launch` crate so the rest of the app talks to a single
//! `AutoLaunch`-shaped helper instead of re-deriving the binary path on every
//! call. The app name and binary path are resolved once at construction time
//! from the current executable, which is correct for both dev and bundled
//! builds — dev uses `cargo run`, prod uses the `.app` bundle, and in both
//! cases `std::env::current_exe()` points at the thing we want to relaunch.

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use std::path::PathBuf;

/// Build an `AutoLaunch` handle for the current executable.
///
/// `app_name` doubles as the macOS login-item label and the Linux desktop
/// entry basename; on Windows it is the registry value name. We keep it stable
/// across dev/prod by reading the compile-time package name.
fn build() -> Result<AutoLaunch, String> {
    let exe: PathBuf = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_name = if cfg!(debug_assertions) {
        "CC Use Dev"
    } else {
        "CC Use"
    };

    AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&exe.to_string_lossy())
        .build()
        .map_err(|e| e.to_string())
}

/// Enable auto-launch at login. Idempotent — returns Ok if already enabled.
pub fn enable() -> Result<(), String> {
    let al = build()?;
    al.enable().map_err(|e| e.to_string())
}

/// Disable auto-launch at login. Idempotent — returns Ok if already disabled.
pub fn disable() -> Result<(), String> {
    let al = build()?;
    al.disable().map_err(|e| e.to_string())
}

/// Returns whether the app is registered as a login item.
pub fn is_enabled() -> Result<bool, String> {
    let al = build()?;
    al.is_enabled().map_err(|e| e.to_string())
}
