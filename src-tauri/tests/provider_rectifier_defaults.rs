mod support;

use cc_use_lib::db::Database;
use cc_use_lib::models::{
    CreateProviderInput, ExportData, ImportOptions, Provider, UpdateProviderInput,
};
use cc_use_lib::services::import_export::{export_all, import_all};
use serde_json::json;
use support::TempDb;

fn create_input(name: &str, enabled: Option<bool>) -> CreateProviderInput {
    let mut value = json!({"name": name, "baseUrl": "https://example.com"});
    if let Some(enabled) = enabled {
        value["responsesRectifier"] = json!(enabled);
    }
    serde_json::from_value(value).unwrap()
}

fn update_input(id: &str, enabled: Option<bool>) -> UpdateProviderInput {
    let mut value = json!({"id": id, "remark": "unrelated edit"});
    if let Some(enabled) = enabled {
        value["responsesRectifier"] = json!(enabled);
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn omitted_create_and_fresh_sql_defaults_are_off() {
    let fixture = TempDb::new();
    let provider = fixture
        .db
        .provider_create(&create_input("omitted", None))
        .unwrap();
    assert!(!provider.responses_rectifier);
    fixture.db.conn.execute(
        "INSERT INTO providers (id, name, base_url) VALUES ('sql-default', 'SQL', 'https://example.com')",
        [],
    ).unwrap();
    assert!(
        !fixture
            .db
            .provider_get("sql-default")
            .unwrap()
            .unwrap()
            .responses_rectifier
    );

    let mut wire = serde_json::to_value(provider).unwrap();
    wire.as_object_mut().unwrap().remove("responsesRectifier");
    assert!(
        !serde_json::from_value::<Provider>(wire)
            .unwrap()
            .responses_rectifier
    );
}

#[test]
fn explicit_flags_round_trip_and_omitted_updates_preserve_them() {
    let fixture = TempDb::new();
    for enabled in [true, false] {
        let provider = fixture
            .db
            .provider_create(&create_input(&format!("explicit-{enabled}"), Some(enabled)))
            .unwrap();
        assert_eq!(provider.responses_rectifier, enabled);
        assert_eq!(
            fixture
                .db
                .provider_get(&provider.id)
                .unwrap()
                .unwrap()
                .responses_rectifier,
            enabled
        );
        assert_eq!(
            fixture
                .db
                .provider_update(&update_input(&provider.id, None))
                .unwrap()
                .responses_rectifier,
            enabled
        );
        assert_eq!(
            fixture
                .db
                .provider_update(&update_input(&provider.id, Some(!enabled)))
                .unwrap()
                .responses_rectifier,
            !enabled
        );
    }
}

#[test]
fn pre_column_migration_is_off_and_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    let db = Database::open_at(&path).unwrap();
    db.conn
        .execute("ALTER TABLE providers DROP COLUMN responses_rectifier", [])
        .unwrap();
    db.conn.execute(
        "INSERT INTO providers (id, name, base_url) VALUES ('legacy', 'Legacy', 'https://example.com')",
        [],
    ).unwrap();
    drop(db);
    for _ in 0..2 {
        let db = Database::open_at(&path).unwrap();
        assert!(
            !db.provider_get("legacy")
                .unwrap()
                .unwrap()
                .responses_rectifier
        );
        let default: String = db.conn.query_row(
            "SELECT dflt_value FROM pragma_table_info('providers') WHERE name = 'responses_rectifier'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(default, "0");
    }
}

#[test]
fn old_default_on_schema_preserves_saved_flags_but_app_creates_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("default-on.db");
    let db = Database::open_at(&path).unwrap();
    db.conn
        .execute("ALTER TABLE providers DROP COLUMN responses_rectifier", [])
        .unwrap();
    db.conn
        .execute(
            "ALTER TABLE providers ADD COLUMN responses_rectifier INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .unwrap();
    db.conn
        .execute(
            "INSERT INTO providers (id, name, base_url, responses_rectifier) VALUES
            ('saved-on', 'Saved on', 'https://example.com', 1),
            ('saved-off', 'Saved off', 'https://example.com', 0)",
            [],
        )
        .unwrap();
    drop(db);

    for _ in 0..2 {
        let db = Database::open_at(&path).unwrap();
        for (id, enabled) in [("saved-on", true), ("saved-off", false)] {
            assert_eq!(
                db.provider_get(id).unwrap().unwrap().responses_rectifier,
                enabled
            );
            assert_eq!(
                db.provider_update(&update_input(id, None))
                    .unwrap()
                    .responses_rectifier,
                enabled
            );
        }
        assert!(
            !db.provider_create(&create_input("new via API", None))
                .unwrap()
                .responses_rectifier
        );
    }
}

#[test]
fn import_missing_flag_is_off_in_both_id_paths() {
    let source = TempDb::new();
    source
        .db
        .provider_create(&create_input("old export", Some(true)))
        .unwrap();
    let mut wire = serde_json::to_value(export_all(&source.db).unwrap()).unwrap();
    wire["providers"][0]
        .as_object_mut()
        .unwrap()
        .remove("responsesRectifier");
    for version in ["1.0", "2.0"] {
        wire["version"] = json!(version);
        let data: ExportData = serde_json::from_value(wire.clone()).unwrap();
        assert!(!data.providers[0].responses_rectifier);
        let target = TempDb::new();
        let result = import_all(&target.db, &data, &ImportOptions { overwrite: false }).unwrap();
        assert_eq!(result.imported, 1);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(!target.db.provider_list().unwrap()[0].responses_rectifier);
    }
}

#[test]
fn export_import_preserves_explicit_flags_in_both_id_paths() {
    let source = TempDb::new();
    for enabled in [true, false] {
        source
            .db
            .provider_create(&create_input(&format!("saved-{enabled}"), Some(enabled)))
            .unwrap();
    }
    for version in ["1.0", "2.0"] {
        let mut data = export_all(&source.db).unwrap();
        data.version = version.to_string();
        let data: ExportData =
            serde_json::from_str(&serde_json::to_string(&data).unwrap()).unwrap();
        let target = TempDb::new();
        let result = import_all(&target.db, &data, &ImportOptions { overwrite: false }).unwrap();
        assert_eq!(result.imported, 2);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        for provider in target.db.provider_list().unwrap() {
            assert_eq!(provider.responses_rectifier, provider.name == "saved-true");
        }
    }
}
