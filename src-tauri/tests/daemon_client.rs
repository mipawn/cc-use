use cc_use_lib::daemon_client::parse_daemon_status;

#[test]
fn parse_daemon_status_marks_loaded_as_running() {
    let status = parse_daemon_status(
    "cc-use-daemon status; management_token_present=true; launch_agent=loaded:gui/501/com.mipawn.cc-use.daemon = {",
    22345,
  )
  .expect("parse loaded status");

    assert!(status.is_running);
    assert_eq!(status.port, 22345);
    assert_eq!(status.last_error, None);
}

#[test]
fn parse_daemon_status_marks_installed_as_stopped() {
    let status = parse_daemon_status(
    "cc-use-daemon status; management_token_present=true; launch_agent=installed:/tmp/test.plist",
    22345,
  )
  .expect("parse installed status");

    assert!(!status.is_running);
    assert_eq!(status.last_error, None);
}

#[test]
fn parse_daemon_status_marks_not_installed_as_stopped() {
    let status = parse_daemon_status(
        "cc-use-daemon status; management_token_present=true; launch_agent=not_installed",
        22345,
    )
    .expect("parse not installed status");

    assert!(!status.is_running);
    assert_eq!(status.last_error, None);
}

#[test]
fn parse_daemon_status_rejects_unexpected_output() {
    let error =
        parse_daemon_status("unexpected", 22345).expect_err("unexpected output should fail");
    assert!(error.contains("Unexpected daemon status output"));
}
