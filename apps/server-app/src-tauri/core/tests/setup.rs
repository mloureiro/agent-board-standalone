mod common;

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use common::Bed;
use rumo_server_core::app::{self, Host, Start};
use rumo_server_core::cli::{Invocation, SetupCommand, parse};
use rumo_server_core::credentials::{CredentialStore, FileStore, SIGNUP_TOKEN};
use rumo_server_core::login_item::Build;
use rumo_server_core::overrides::Overrides;
use rumo_server_core::paths::AppPaths;
use rumo_server_core::setup::{
    APPLY, REFUSED_EXIT_CODE, REMOTE_OFF, SetupPlace, SignIn, base64url, run_command,
};
use serde_json::Value;

const SERVICE: &str = "test.service";

struct Place {
    _dir: tempfile::TempDir,
    place: SetupPlace,
    store: Arc<FileStore>,
}

fn place() -> Place {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FileStore::new(dir.path().join("credentials.json")));
    let place = SetupPlace {
        paths: AppPaths::new(&dir.path().join("root")),
        login_name: "Ines".to_string(),
        service: SERVICE.to_string(),
        store: store.clone(),
    };
    Place {
        _dir: dir,
        place,
        store,
    }
}

fn write_settings(place: &SetupPlace, text: &str) {
    fs::create_dir_all(place.paths.root()).unwrap();
    fs::write(place.paths.settings_file(), text).unwrap();
}

fn read_settings(place: &SetupPlace) -> String {
    fs::read_to_string(place.paths.settings_file()).unwrap()
}

fn token(store: &FileStore) -> Option<String> {
    store.get(SERVICE, SIGNUP_TOKEN).unwrap()
}

fn command(place: &SetupPlace, command: SetupCommand) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = run_command(place, &command, &mut out, &mut err);
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[test]
fn server_app_089_turning_remote_on_keeps_every_other_key_and_its_order() {
    let bed = place();
    write_settings(
        &bed.place,
        r#"{"port": 5001, "workerPath": ["/opt/b", "/opt/a"], "userName": "ines", "startAtLogin": false}"#,
    );

    let settings = bed.place.remote_on(" https://Board.Example.NET/ ").unwrap();
    assert_eq!(
        settings.public_url.as_deref(),
        Some("https://board.example.net")
    );

    let document: Value = serde_json::from_str(&read_settings(&bed.place)).unwrap();
    let keys: Vec<&str> = document
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "port",
            "workerPath",
            "userName",
            "startAtLogin",
            "publicUrl"
        ]
    );
    assert_eq!(document["workerPath"][0], "/opt/b");
    assert_eq!(document["publicUrl"], "https://board.example.net");
    assert!(read_settings(&bed.place).ends_with("}\n"));
}

#[test]
fn server_app_089_an_edit_that_would_be_refused_leaves_the_file_untouched() {
    let bed = place();
    let original = r#"{"port": 5001}"#;
    write_settings(&bed.place, original);

    for bad in ["http://board.example.net", "https://board.example.net/x"] {
        let message = bed.place.remote_on(bad).unwrap_err();
        assert!(message.contains("publicUrl"), "{message}");
        assert_eq!(read_settings(&bed.place), original);
    }

    let message = bed
        .place
        .edit(|document| {
            document.insert(
                "remoteHosts".to_string(),
                serde_json::json!(["a.example.net"]),
            );
        })
        .unwrap_err();
    assert_eq!(message, "settings.json: remoteHosts needs publicUrl");
    assert_eq!(read_settings(&bed.place), original);

    write_settings(&bed.place, r#"{"port": 99}"#);
    assert!(bed.place.remote_on("https://board.example.net").is_err());
    assert_eq!(read_settings(&bed.place), r#"{"port": 99}"#);
    let leftovers: Vec<_> = fs::read_dir(bed.place.paths.root())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, [OsString::from("settings.json")]);
}

#[test]
fn server_app_089_an_edit_creates_the_default_file_first_when_it_is_missing() {
    let bed = place();
    bed.place.remote_on("https://board.example.net").unwrap();
    let document: Value = serde_json::from_str(&read_settings(&bed.place)).unwrap();
    assert_eq!(document["port"], 4785);
    assert_eq!(document["userName"], "ines");
    assert_eq!(document["publicUrl"], "https://board.example.net");
}

#[test]
fn server_app_089_turning_remote_off_removes_the_address_the_tunnel_hosts_and_the_open_step() {
    let bed = place();
    write_settings(
        &bed.place,
        r#"{"port": 5001, "publicUrl": "https://board.example.net", "remoteHosts": ["mac.tail1234.ts.net"]}"#,
    );
    bed.place.first_passkey_open().unwrap();
    assert!(token(&bed.store).is_some());

    let settings = bed.place.remote_off().unwrap();
    assert!(!settings.remote());
    let document: Value = serde_json::from_str(&read_settings(&bed.place)).unwrap();
    assert_eq!(document, serde_json::json!({ "port": 5001 }));
    assert_eq!(token(&bed.store), None);
}

#[test]
fn server_app_089_the_first_passkey_step_stores_a_random_token_and_closing_it_deletes_it() {
    let bed = place();
    write_settings(
        &bed.place,
        r#"{"userName": "ines", "publicUrl": "https://board.example.net"}"#,
    );

    let first = bed.place.first_passkey_open().unwrap();
    assert_eq!(first.sign_up_url, "https://board.example.net/");
    assert_eq!(first.user_name, "ines");
    assert!(first.token.len() >= 43, "{}", first.token);
    assert!(
        first
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    );
    assert_eq!(token(&bed.store).as_deref(), Some(first.token.as_str()));
    assert!(!format!("{first:?}").contains(&first.token));

    let second = bed.place.first_passkey_open().unwrap();
    assert_ne!(second.token, first.token);
    assert!(bed.place.status(false).unwrap().first_passkey_open);

    bed.place.first_passkey_close().unwrap();
    assert_eq!(token(&bed.store), None);
    assert!(!bed.place.status(false).unwrap().first_passkey_open);
}

#[test]
fn server_app_089_the_first_passkey_step_is_refused_without_remote_access() {
    let bed = place();
    write_settings(&bed.place, "{}");
    assert_eq!(bed.place.first_passkey_open().unwrap_err(), REMOTE_OFF);
    assert_eq!(token(&bed.store), None);
}

#[test]
fn server_app_089_base64url_matches_the_rfc_4648_vectors_without_padding() {
    for (bytes, encoded) in [
        (&b""[..], ""),
        (b"f", "Zg"),
        (b"fo", "Zm8"),
        (b"foo", "Zm9v"),
        (b"foob", "Zm9vYg"),
        (b"fooba", "Zm9vYmE"),
        (b"foobar", "Zm9vYmFy"),
        (&[0xfb, 0xff, 0xbf], "-_-_"),
    ] {
        assert_eq!(base64url(bytes), encoded);
    }
}

#[test]
fn server_app_089_the_status_reports_the_mode_the_step_the_worker_and_the_file() {
    let bed = place();
    write_settings(&bed.place, r#"{"port": 5001}"#);
    let off = bed.place.status(true).unwrap();
    assert!(!off.remote);
    assert_eq!(off.sign_in, SignIn::NoLogin);
    assert!(off.worker_connected);

    bed.place.remote_on("https://board.example.net").unwrap();
    let on = serde_json::to_value(bed.place.status(false).unwrap()).unwrap();
    assert_eq!(
        on,
        serde_json::json!({
            "remote": true,
            "publicUrl": "https://board.example.net",
            "signIn": "passkeys",
            "firstPasskeyOpen": false,
            "workerConnected": false,
            "userName": "ines",
            "port": 5001,
            "settingsFile": bed.place.paths.settings_file(),
        })
    );
}

#[test]
fn server_app_089_the_setup_command_parses_its_five_forms() {
    let parse_args = |args: &[&str]| parse(args.iter().map(OsString::from));
    assert_eq!(
        parse_args(&["setup", "status"]),
        Invocation::Setup(SetupCommand::Status)
    );
    assert_eq!(
        parse_args(&["setup", "remote", "--public-url", "https://a.example.net"]),
        Invocation::Setup(SetupCommand::RemoteOn {
            public_url: "https://a.example.net".to_string()
        })
    );
    assert_eq!(
        parse_args(&["setup", "remote", "--off"]),
        Invocation::Setup(SetupCommand::RemoteOff)
    );
    assert_eq!(
        parse_args(&["setup", "first-passkey"]),
        Invocation::Setup(SetupCommand::FirstPasskeyOpen)
    );
    assert_eq!(
        parse_args(&["setup", "first-passkey", "--done"]),
        Invocation::Setup(SetupCommand::FirstPasskeyDone)
    );
    for bad in [
        &["setup"][..],
        &["setup", "remote"],
        &["setup", "remote", "--public-url"],
        &["setup", "first-passkey", "--open"],
    ] {
        assert_eq!(parse_args(bad), Invocation::Usage, "{bad:?}");
    }
}

#[test]
fn server_app_089_the_setup_commands_print_their_result_and_how_to_apply_it() {
    let bed = place();
    write_settings(&bed.place, r#"{"userName": "ines"}"#);

    let (code, out, err) = command(&bed.place, SetupCommand::FirstPasskeyOpen);
    assert_eq!((code, out.as_str()), (REFUSED_EXIT_CODE, ""));
    assert_eq!(err.trim(), REMOTE_OFF);

    let (code, _, err) = command(
        &bed.place,
        SetupCommand::RemoteOn {
            public_url: "http://board.example.net".to_string(),
        },
    );
    assert_eq!(code, REFUSED_EXIT_CODE);
    assert!(err.contains("publicUrl"), "{err}");

    let (code, out, _) = command(
        &bed.place,
        SetupCommand::RemoteOn {
            public_url: "https://board.example.net".to_string(),
        },
    );
    assert_eq!(code, 0);
    assert_eq!(out.lines().last(), Some(APPLY));

    let (code, out, _) = command(&bed.place, SetupCommand::FirstPasskeyOpen);
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.lines().collect();
    let stored = token(&bed.store).unwrap();
    assert_eq!(
        lines,
        ["https://board.example.net/", "ines", stored.as_str(), APPLY]
    );

    let (code, out, _) = command(&bed.place, SetupCommand::Status);
    assert_eq!(code, 0);
    let status: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(status["firstPasskeyOpen"], true);
    assert!(!out.contains(&stored));

    let (code, out, _) = command(&bed.place, SetupCommand::FirstPasskeyDone);
    assert_eq!((code, out.lines().last()), (0, Some(APPLY)));
    assert_eq!(token(&bed.store), None);

    let (code, out, _) = command(&bed.place, SetupCommand::RemoteOff);
    assert_eq!((code, out.lines().last()), (0, Some(APPLY)));
    assert!(!read_settings(&bed.place).contains("publicUrl"));
}

fn host(bed: &Bed) -> Host {
    Host {
        home: bed.home.clone(),
        login_name: "Ines".to_string(),
        root_env: Some(bed.dir.path().join("board-root").into_os_string()),
        overrides: Overrides {
            credential_store_file: Some(bed.dir.path().join("credentials.json")),
            ..Overrides::default()
        },
        build: Build::Debug,
        executable: PathBuf::from("/x/board"),
    }
}

#[test]
fn server_app_089_only_the_launch_that_creates_the_settings_file_is_a_first_run() {
    let bed = Bed::new();
    let host = host(&bed);
    let Start::Running(first) = app::start(&host).unwrap() else {
        panic!("the root is already locked");
    };
    assert!(first.first_run);
    drop(first);
    let Start::Running(second) = app::start(&host).unwrap() else {
        panic!("the root is already locked");
    };
    assert!(!second.first_run);
}

#[test]
fn server_app_089_the_command_line_setup_works_on_the_host_root_and_store() {
    let bed = Bed::new();
    let host = host(&bed);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = app::run_setup(
        &host,
        &SetupCommand::RemoteOn {
            public_url: "https://board.example.net".to_string(),
        },
        &mut out,
        &mut err,
    );
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&err));
    let root = host.root().unwrap();
    let text = fs::read_to_string(root.paths().settings_file()).unwrap();
    assert!(text.contains("\"publicUrl\": \"https://board.example.net\""));

    let code = app::run_setup(&host, &SetupCommand::FirstPasskeyOpen, &mut out, &mut err);
    assert_eq!(code, 0);
    let store = FileStore::new(bed.dir.path().join("credentials.json"));
    assert!(
        store
            .get(&root.keychain_service(), SIGNUP_TOKEN)
            .unwrap()
            .is_some()
    );
}
