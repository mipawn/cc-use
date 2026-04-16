use cc_use_lib::shared_runtime::{
    ensure_management_token, read_management_token, validate_management_token, ManagementTokenPaths,
};
use std::fs;

fn temp_home() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-use-management-token-{}", nanoid::nanoid!(8)));
    fs::create_dir_all(&dir).expect("create temp home");
    dir
}

#[test]
fn ensure_management_token_creates_and_reuses_same_token() {
    let home = temp_home();
    let paths = ManagementTokenPaths::from_home(&home);

    let first = ensure_management_token(&paths).expect("create token");
    let second = ensure_management_token(&paths).expect("reuse token");
    let persisted = read_management_token(&paths).expect("read token");

    assert_eq!(first, second);
    assert_eq!(persisted.as_deref(), Some(first.as_str()));
    assert!(first.starts_with("mgmt-"));
}

#[test]
fn validate_management_token_matches_exact_value() {
    assert!(validate_management_token("mgmt-abc", Some("mgmt-abc")));
    assert!(!validate_management_token("mgmt-abc", Some("mgmt-def")));
    assert!(!validate_management_token("mgmt-abc", None));
}
