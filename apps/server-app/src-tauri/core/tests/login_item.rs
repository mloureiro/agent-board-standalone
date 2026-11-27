mod common;

use std::fs;
use std::path::Path;

use common::{Bed, RecordingLaunchctl, exists};
use rumo_server_core::app::{self, Host, Start};
use rumo_server_core::login_item::{self, Build, LABEL, Outcome, plist, plist_path};
use rumo_server_core::overrides::Overrides;

const EXECUTABLE: &str = "/Applications/Rumo Server.app/Contents/MacOS/rumo-server";

#[test]
fn server_app_061_a_release_build_on_the_default_root_writes_the_launch_agent() {
    let bed = Bed::new();
    let root = bed.default_root();
    let outcome = login_item::sync(
        &root,
        Build::Release,
        true,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert_eq!(outcome, Outcome::Written);

    let text = fs::read_to_string(plist_path(&bed.agents)).unwrap();
    assert_eq!(LABEL, "dev.mloureiro.rumo-server");
    assert!(plist_path(&bed.agents).ends_with("dev.mloureiro.rumo-server.plist"));
    assert!(text.contains("<key>Label</key>\n  <string>dev.mloureiro.rumo-server</string>"));
    assert!(text.contains(&format!("<string>{EXECUTABLE}</string>")));
    assert!(text.contains("<key>RunAtLoad</key>\n  <true/>"));
    assert!(
        text.contains(
            "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>"
        )
    );
    assert!(text.contains("<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>"));
    assert!(text.contains("<key>ThrottleInterval</key>\n  <integer>10</integer>"));
}

#[test]
fn server_app_061_the_launch_agent_is_written_once_and_the_executable_is_escaped() {
    let bed = Bed::new();
    let root = bed.default_root();
    let executable = Path::new("/Apps/R&D <tools>/board");
    login_item::sync(&root, Build::Release, true, &bed.agents, executable).unwrap();
    assert!(
        fs::read_to_string(plist_path(&bed.agents))
            .unwrap()
            .contains("R&amp;D &lt;tools&gt;")
    );
    assert_eq!(
        plist(executable),
        fs::read_to_string(plist_path(&bed.agents)).unwrap()
    );
    let again = login_item::sync(&root, Build::Release, true, &bed.agents, executable).unwrap();
    assert_eq!(again, Outcome::Unchanged);
}

#[test]
fn server_app_061_a_debug_build_never_touches_the_login_item() {
    let bed = Bed::new();
    let root = bed.default_root();
    let outcome = login_item::sync(
        &root,
        Build::Debug,
        true,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert_eq!(outcome, Outcome::Untouched);
    assert!(!exists(&bed.agents));

    fs::create_dir_all(&bed.agents).unwrap();
    fs::write(plist_path(&bed.agents), "kept").unwrap();
    login_item::sync(
        &root,
        Build::Debug,
        false,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(plist_path(&bed.agents)).unwrap(), "kept");
}

#[test]
fn server_app_061_a_non_default_root_never_touches_the_login_item() {
    let bed = Bed::new();
    let root = bed.custom_root("other-root");
    for start_at_login in [true, false] {
        let outcome = login_item::sync(
            &root,
            Build::Release,
            start_at_login,
            &bed.agents,
            Path::new(EXECUTABLE),
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Untouched);
    }
    assert!(!exists(&bed.agents));
}

#[test]
fn server_app_063_start_at_login_false_removes_the_launch_agent() {
    let bed = Bed::new();
    let root = bed.default_root();
    login_item::sync(
        &root,
        Build::Release,
        true,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert!(exists(&plist_path(&bed.agents)));

    let outcome = login_item::sync(
        &root,
        Build::Release,
        false,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert_eq!(outcome, Outcome::Removed);
    assert!(!exists(&plist_path(&bed.agents)));

    let outcome = login_item::sync(
        &root,
        Build::Release,
        false,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    assert_eq!(outcome, Outcome::Unchanged);
}

fn host(bed: &Bed, build: Build) -> Host {
    Host {
        home: bed.home.clone(),
        login_name: "Ines".to_string(),
        root_env: None,
        overrides: Overrides {
            credential_store_file: None,
            launch_agents_dir: Some(bed.agents.clone()),
            ..Overrides::default()
        },
        build,
        executable: Path::new(EXECUTABLE).to_path_buf(),
    }
}

#[test]
fn server_app_063_the_start_reads_the_setting_and_removes_the_launch_agent_of_an_earlier_run() {
    let bed = Bed::new();
    let host = host(&bed, Build::Release);

    let Start::Running(first) = app::start(&host).unwrap() else {
        panic!("must start")
    };
    assert!(exists(&plist_path(&bed.agents)));
    drop(first);

    fs::write(
        bed.default_root().paths().settings_file(),
        r#"{"startAtLogin": false}"#,
    )
    .unwrap();
    let Start::Running(_second) = app::start(&host).unwrap() else {
        panic!("must start")
    };
    assert!(!exists(&plist_path(&bed.agents)));
}

#[test]
fn server_app_061_a_refused_settings_file_leaves_the_launch_agent_as_it_is() {
    let bed = Bed::new();
    let host = host(&bed, Build::Release);
    let Start::Running(first) = app::start(&host).unwrap() else {
        panic!("must start")
    };
    drop(first);
    fs::write(
        bed.default_root().paths().settings_file(),
        r#"{"startAtLogin": false, "x": 1}"#,
    )
    .unwrap();
    let Start::Running(second) = app::start(&host).unwrap() else {
        panic!("must start")
    };
    assert!(second.settings.is_err());
    assert!(exists(&plist_path(&bed.agents)));
}

#[test]
fn server_app_061_a_debug_start_on_the_default_root_leaves_the_launch_agents_folder_alone() {
    let bed = Bed::new();
    let Start::Running(_running) = app::start(&host(&bed, Build::Debug)).unwrap() else {
        panic!("must start")
    };
    assert!(!exists(&bed.agents));
}

#[test]
fn server_app_064_removing_the_login_item_boots_the_label_out_first() {
    let bed = Bed::new();
    let root = bed.default_root();
    login_item::sync(
        &root,
        Build::Release,
        true,
        &bed.agents,
        Path::new(EXECUTABLE),
    )
    .unwrap();
    let launchctl = RecordingLaunchctl::default();
    let outcome = login_item::remove(&root, &bed.agents, &launchctl).unwrap();
    assert_eq!(outcome, Outcome::Removed);
    assert_eq!(launchctl.calls(), [LABEL]);
    assert!(!exists(&plist_path(&bed.agents)));
}
