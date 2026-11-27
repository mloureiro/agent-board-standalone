mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use common::Bed;
use rumo_server_core::app::Host;
use rumo_server_core::check_worker::{dropped_checks, evaluate, find_on_path};
use rumo_server_core::credential_flow::{Pair, run_command, write_pair};
use rumo_server_core::login_item::Build;
use rumo_server_core::overrides::Overrides;

const DOCTOR: &str = r#"[
 {"name":"node","level":"ok","message":"node 24"},
 {"name":"launchd agents","level":"fail","message":"missing"},
 {"name":"dispatch state","level":"warn","message":"not loaded"},
 {"name":"git","level":"warn","message":"git did not run","hint":"install git"}
]"#;

fn tool(dir: &std::path::Path, name: &str) {
    fs::create_dir_all(dir).unwrap();
    let file = dir.join(name);
    fs::write(&file, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn server_app_020_the_checks_the_app_names_are_dropped_and_the_rest_are_counted() {
    let bed = Bed::new();
    let bin = bed.dir.path().join("bin");
    tool(&bin, "claude");
    tool(&bin, "gh");

    let report = evaluate(DOCTOR, &dropped_checks(), &bin.display().to_string()).unwrap();

    assert_eq!(report.problems, 1);
    assert_eq!(report.summary(), "check: 1 problem(s)");
    let text = report.lines.join("\n");
    assert!(text.contains("node: node 24"));
    assert!(text.contains("hint: install git"));
    assert!(!text.contains("launchd agents"));
    assert!(!text.contains("dispatch state"));
    assert!(text.contains(&format!("claude: {}", bin.join("claude").display())));
}

#[test]
fn server_app_020_a_missing_claude_or_gh_on_the_worker_path_is_a_problem() {
    let bed = Bed::new();
    let bin = bed.dir.path().join("bin");
    tool(&bin, "gh");

    let report = evaluate("[]", &[], &bin.display().to_string()).unwrap();

    assert_eq!(report.problems, 1);
    assert!(
        report
            .lines
            .iter()
            .any(|line| line.contains("claude: not found on the worker PATH"))
    );
    assert!(find_on_path("claude", "/nonexistent").is_none());
}

#[test]
fn server_app_020_secrets_in_the_report_are_withheld_and_a_bad_report_is_refused() {
    let report = evaluate(
        r#"[{"name":"token","level":"fail","message":"abm_Secret99 was refused"}]"#,
        &[],
        "",
    )
    .unwrap();
    assert!(!report.lines.join("\n").contains("abm_Secret99"));
    assert!(evaluate("not json", &[], "").is_err());
}

#[test]
fn server_app_020_every_dropped_check_names_a_launchd_or_update_check() {
    let dropped = dropped_checks();
    assert!(dropped.contains(&"launchd agents".to_string()));
    assert!(dropped.iter().all(|name| !name.is_empty()));
}

fn host(bed: &Bed, store: Option<PathBuf>) -> Host {
    Host {
        home: bed.home.clone(),
        login_name: "Ines".to_string(),
        root_env: Some(bed.dir.path().join("board-root").into_os_string()),
        overrides: Overrides {
            credential_store_file: store,
            ..Overrides::default()
        },
        build: Build::Debug,
        executable: PathBuf::from("/x/board"),
    }
}

#[test]
fn server_app_053_the_credentials_command_prints_the_stored_pair_for_the_cli() {
    let bed = Bed::new();
    let file = bed.dir.path().join("creds.json");
    let host = host(&bed, Some(file));
    let service = host.root().unwrap().keychain_service();
    let store = rumo_server_core::credentials::open_store(&host.overrides);
    let pair = Pair {
        token: "abm_t".to_string(),
        data_key: "abk1_k".to_string(),
    };
    write_pair(store.as_ref(), &service, false, &pair).unwrap();
    write_pair(
        store.as_ref(),
        &service,
        true,
        &Pair {
            token: "abm_pending".to_string(),
            data_key: "abk1_pending".to_string(),
        },
    )
    .unwrap();

    let mut out = Vec::new();
    assert_eq!(run_command(&host, false, &mut out), 0);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "RUMO_TOKEN=abm_t\nRUMO_DATA_KEY=abk1_k\n"
    );
    let mut pending = Vec::new();
    assert_eq!(run_command(&host, true, &mut pending), 0);
    assert!(String::from_utf8(pending).unwrap().contains("abm_pending"));
}

#[test]
fn server_app_053_without_a_stored_pair_the_credentials_command_prints_nothing_and_fails() {
    let bed = Bed::new();
    let host = host(&bed, Some(bed.dir.path().join("empty.json")));
    let mut out = Vec::new();

    assert_eq!(run_command(&host, false, &mut out), 1);
    assert!(out.is_empty());
}

#[test]
fn server_app_053_the_credentials_command_flags_parse_to_the_hidden_invocation() {
    use rumo_server_core::cli::{Invocation, parse};
    let parse_args = |args: &[&str]| parse(args.iter().map(std::ffi::OsString::from));
    assert_eq!(
        parse_args(&["--worker-credentials"]),
        Invocation::WorkerCredentials { pending: false }
    );
    assert_eq!(
        parse_args(&["--worker-credentials", "--pending"]),
        Invocation::WorkerCredentials { pending: true }
    );
    assert_eq!(parse_args(&["--pending"]), Invocation::Usage);
}
