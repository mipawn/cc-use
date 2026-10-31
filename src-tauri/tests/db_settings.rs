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

/// R8/T23: LAN access is an explicit opt-in. A missing key (fresh install or
/// upgraded database) must read as loopback-only, and `lan` must round-trip.
#[test]
fn proxy_listen_scope_defaults_to_loopback_and_roundtrips_lan() {
    let fixture = TempDb::new();

    let settings = fixture.db.settings_get().unwrap();
    assert_eq!(settings.proxy_listen_scope, "loopback");

    let updated = fixture
        .db
        .settings_update(&serde_json::json!({ "proxyListenScope": "lan" }))
        .unwrap();
    assert_eq!(updated.proxy_listen_scope, "lan");
    assert_eq!(
        fixture.db.settings_get().unwrap().proxy_listen_scope,
        "lan",
        "the scope is persisted with the rest of GlobalSettings"
    );

    let updated = fixture
        .db
        .settings_update(&serde_json::json!({ "proxyListenScope": "loopback" }))
        .unwrap();
    assert_eq!(updated.proxy_listen_scope, "loopback");
}

/// Anything that is not the exact `lan` value must never enable the LAN
/// listener, no matter how it got into the settings table.
#[test]
fn invalid_proxy_listen_scope_normalizes_to_loopback() {
    let fixture = TempDb::new();

    for value in ["LAN", "Lan", "0.0.0.0", "true", "garbage", ""] {
        let updated = fixture
            .db
            .settings_update(&serde_json::json!({ "proxyListenScope": value }))
            .unwrap();
        assert_eq!(
            updated.proxy_listen_scope, "loopback",
            "scope {:?} must fall back to loopback",
            value
        );
    }

    // A value written directly (e.g. an older build or hand-edited DB) is also
    // normalized on read, without touching the raw row.
    fixture
        .db
        .settings_set_value("proxyListenScope", "garbage")
        .unwrap();
    assert_eq!(
        fixture.db.settings_get().unwrap().proxy_listen_scope,
        "loopback"
    );

    fixture
        .db
        .settings_delete_value("proxyListenScope")
        .unwrap();
    assert_eq!(
        fixture.db.settings_get().unwrap().proxy_listen_scope,
        "loopback",
        "a missing key is loopback-only"
    );
}
