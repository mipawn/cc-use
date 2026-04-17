mod support;

use support::TempDb;

#[test]
fn settings_crud() {
    let fixture = TempDb::new();

    let settings = fixture.db.settings_get().unwrap();
    assert_eq!(settings.proxy_port, 12345);
    assert!(settings.close_to_tray);

    let updates = serde_json::json!({
      "proxyPort": 8080,
      "closeToTray": false
    });
    let updated = fixture.db.settings_update(&updates).unwrap();
    assert_eq!(updated.proxy_port, 8080);
    assert!(!updated.close_to_tray);
}
