use std::fs;
use std::path::Path;

use rumo_server_core::account;
use rumo_server_core::paths::AppPaths;
use rumo_server_core::settings::{DEFAULT_PORT, Settings};

fn parse(text: &str) -> Result<Settings, String> {
    let paths = AppPaths::new(Path::new("/tmp/board-root"));
    Settings::parse(text, &paths, "Ines").map_err(|error| error.to_string())
}

fn refused(text: &str) -> String {
    parse(text).expect_err(text)
}

#[test]
fn server_app_067_an_empty_file_gives_every_default() {
    let settings = parse("{}").unwrap();
    assert_eq!(settings.port, DEFAULT_PORT);
    assert_eq!(settings.port, 4785);
    assert!(settings.start_at_login);
    assert_eq!(settings.data_dir, Path::new("/tmp/board-root/data"));
    assert_eq!(settings.backup_dir, Path::new("/tmp/board-root/backups"));
    assert!(settings.worker_path.is_empty());
    assert!(settings.remote_hosts.is_empty());
    assert!(!settings.request_signature);
}

#[test]
fn server_app_067_every_key_is_taken() {
    let settings = parse(
        r#"{"userName":"ines","dataDir":"/srv/data","backupDir":"/srv/backups","port":5000,
            "startAtLogin":false,"workerPath":"/opt/board"}"#,
    )
    .unwrap();
    assert_eq!(settings.user_name, "ines");
    assert_eq!(settings.data_dir, Path::new("/srv/data"));
    assert_eq!(settings.backup_dir, Path::new("/srv/backups"));
    assert_eq!(settings.port, 5000);
    assert!(!settings.start_at_login);
    assert_eq!(settings.worker_path, [Path::new("/opt/board")]);
}

#[test]
fn server_app_045_worker_path_takes_a_list_of_absolute_entries_in_order() {
    let settings = parse(r#"{"workerPath":["/opt/a","/opt/homebrew/bin"]}"#).unwrap();
    assert_eq!(
        settings.worker_path,
        [Path::new("/opt/a"), Path::new("/opt/homebrew/bin")]
    );
    assert!(
        parse(r#"{"workerPath":[]}"#)
            .unwrap()
            .worker_path
            .is_empty()
    );

    let entries = |count: usize| {
        let names: Vec<String> = (0..count).map(|index| format!("\"/p/{index}\"")).collect();
        format!(r#"{{"workerPath":[{}]}}"#, names.join(","))
    };
    assert_eq!(parse(&entries(32)).unwrap().worker_path.len(), 32);
    assert!(refused(&entries(33)).contains("at most 32"));
}

#[test]
fn server_app_045_a_bad_worker_path_entry_stops_the_load_with_a_message() {
    for bad in [
        r#""relative/bin""#,
        r#"["/fine","relative"]"#,
        r#"["/a:/b"]"#,
        r#""/a:/b""#,
        r#"[""]"#,
        r#"["/a/../b"]"#,
        r#"[7]"#,
        r#"["/a",null]"#,
        "true",
    ] {
        let message = refused(&format!(r#"{{"workerPath":{bad}}}"#));
        assert!(message.starts_with("settings.json"), "{bad}: {message}");
    }
    assert!(refused(r#"{"workerPath":["/a:/b"]}"#).contains("`:`"));
}

#[test]
fn server_app_067_the_port_accepts_1024_to_65535_only() {
    assert_eq!(parse(r#"{"port":1024}"#).unwrap().port, 1024);
    assert_eq!(parse(r#"{"port":65535}"#).unwrap().port, 65535);
    for bad in ["1023", "0", "65536", "-1", "4785.5", r#""4785""#, "null"] {
        let message = refused(&format!(r#"{{"port":{bad}}}"#));
        assert!(message.starts_with("settings.json"), "{bad}: {message}");
    }
}

#[test]
fn server_app_067_unknown_keys_and_malformed_values_are_refused_with_a_message() {
    for text in [
        r#"{"oops":1}"#,
        r#"{"port":4785,"colour":"red"}"#,
        r#"{"startAtLogin":"yes"}"#,
        r#"{"userName":7}"#,
        r#"{"userName":""}"#,
        r#"{"dataDir":""}"#,
        r#"{"dataDir":"relative/path"}"#,
        r#"{"backupDir":"/a/../b"}"#,
        r#"{"workerPath":"board"}"#,
        r#"{"remoteHosts":"example.com"}"#,
        "[]",
        "",
        "{",
    ] {
        let message = refused(text);
        assert!(message.starts_with("settings.json"), "{text}: {message}");
    }
}

#[test]
fn server_app_067_a_missing_file_is_created_with_defaults_and_an_existing_one_is_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(dir.path());

    let created = Settings::load_or_create(&paths, "Ines").unwrap();
    assert_eq!(created.port, 4785);
    let on_disk = fs::read_to_string(paths.settings_file()).unwrap();
    assert!(on_disk.contains("\"port\": 4785"));
    assert_eq!(Settings::load(&paths, "Ines").unwrap(), created);

    let edited = "{\n  \"port\": 5001,   \"userName\": \"ines\"\n}\n";
    fs::write(paths.settings_file(), edited).unwrap();
    let before = fs::metadata(paths.settings_file())
        .unwrap()
        .modified()
        .unwrap();
    let loaded = Settings::load_or_create(&paths, "Ines").unwrap();
    assert_eq!(loaded.port, 5001);
    assert_eq!(fs::read_to_string(paths.settings_file()).unwrap(), edited);
    assert_eq!(
        fs::metadata(paths.settings_file())
            .unwrap()
            .modified()
            .unwrap(),
        before
    );

    fs::write(paths.settings_file(), r#"{"port": 99}"#).unwrap();
    assert!(Settings::load_or_create(&paths, "Ines").is_err());
    assert_eq!(
        fs::read_to_string(paths.settings_file()).unwrap(),
        r#"{"port": 99}"#
    );
}

#[test]
fn server_app_067_a_settings_path_that_is_not_a_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(dir.path());
    fs::create_dir(paths.settings_file()).unwrap();
    let message = Settings::load(&paths, "Ines").unwrap_err().to_string();
    assert!(
        message.starts_with("settings.json cannot be read"),
        "{message}"
    );
}

#[test]
fn server_app_068_the_user_name_defaults_to_the_lower_cased_login_name() {
    let paths = AppPaths::new(Path::new("/tmp/board-root"));
    let settings = Settings::parse("{}", &paths, "Ada.Lovelace_1-x").unwrap();
    assert_eq!(settings.user_name, "ada.lovelace_1-x");
}

#[test]
fn server_app_068_a_login_name_outside_the_pattern_is_refused_until_the_setting_names_one() {
    let paths = AppPaths::new(Path::new("/tmp/board-root"));
    for login in ["Ünal", "two words", "", &"a".repeat(65)] {
        let message = Settings::parse("{}", &paths, login)
            .unwrap_err()
            .to_string();
        assert!(message.contains("set userName"), "{login}: {message}");
        let fixed = Settings::parse(r#"{"userName":"ines"}"#, &paths, login).unwrap();
        assert_eq!(fixed.user_name, "ines");
    }
    let longest = "a".repeat(64);
    assert_eq!(
        Settings::parse("{}", &paths, &longest).unwrap().user_name,
        longest
    );
}

#[test]
fn server_app_068_an_explicit_user_name_must_match_the_pattern() {
    for bad in ["Ines", "in es", "ines!", &"a".repeat(65)] {
        let message = refused(&format!(r#"{{"userName":"{bad}"}}"#));
        assert!(message.contains("userName"), "{bad}: {message}");
    }
}

#[test]
fn server_app_068_the_process_knows_its_login_name() {
    assert!(account::login_name().is_some_and(|name| !name.is_empty()));
}

#[test]
fn server_app_089_remote_hosts_need_the_public_url() {
    for text in [
        r#"{"remoteHosts":["board.example.net"]}"#,
        r#"{"remoteHosts":["board.example.net"],"requestSignature":true}"#,
    ] {
        assert_eq!(refused(text), "settings.json: remoteHosts needs publicUrl");
    }

    let settings = parse(
        r#"{"publicUrl":"https://board.example.net","remoteHosts":["Board.Example.NET","mac.tail1234.ts.net"]}"#,
    )
    .unwrap();
    assert_eq!(
        settings.remote_hosts,
        ["board.example.net", "mac.tail1234.ts.net"]
    );
}

#[test]
fn server_app_089_the_public_url_turns_remote_access_on_and_forces_the_request_signature() {
    let off = parse("{}").unwrap();
    assert!(!off.remote());
    assert_eq!(off.public_url, None);

    for text in [
        r#"{"publicUrl":"https://board.example.net"}"#,
        r#"{"publicUrl":"https://board.example.net","requestSignature":false}"#,
    ] {
        let on = parse(text).unwrap();
        assert!(on.remote());
        assert!(on.request_signature, "{text}");
    }
}

#[test]
fn server_app_089_the_public_url_is_a_bare_https_origin_stored_lower_cased_without_a_slash() {
    for (given, stored) in [
        ("https://board.example.net", "https://board.example.net"),
        ("https://board.example.net/", "https://board.example.net"),
        ("https://Mac.Tail1234.TS.net", "https://mac.tail1234.ts.net"),
        (
            "https://board.example.net:443/",
            "https://board.example.net",
        ),
    ] {
        assert_eq!(
            parse(&format!(r#"{{"publicUrl":"{given}"}}"#))
                .unwrap()
                .public_url
                .as_deref(),
            Some(stored),
            "{given}"
        );
    }

    for bad in [
        "http://board.example.net",
        "https://board.example.net/board",
        "https://board.example.net:8443",
        "https://board.example.net/?a=1",
        "https://board.example.net/#top",
        "https://user:secret@board.example.net",
        "https://192.168.1.10",
        "https://[::1]",
        "https://-bad.example.net",
        "board.example.net",
        "",
    ] {
        let message = refused(&format!(r#"{{"publicUrl":"{bad}"}}"#));
        assert!(message.contains("publicUrl"), "{bad}: {message}");
    }
}

#[test]
fn server_app_089_the_signature_alone_and_an_empty_host_list_are_fine() {
    assert!(
        parse(r#"{"requestSignature":true}"#)
            .unwrap()
            .request_signature
    );
    assert!(
        parse(r#"{"remoteHosts":[]}"#)
            .unwrap()
            .remote_hosts
            .is_empty()
    );
}

#[test]
fn server_app_089_at_most_eight_bare_host_names_are_accepted() {
    let hosts = |count: usize| {
        let names: Vec<String> = (0..count)
            .map(|index| format!("\"h{index}.example.net\""))
            .collect();
        format!(
            r#"{{"publicUrl":"https://board.example.net","remoteHosts":[{}]}}"#,
            names.join(",")
        )
    };
    assert_eq!(parse(&hosts(8)).unwrap().remote_hosts.len(), 8);
    assert!(refused(&hosts(9)).contains("at most 8"));

    for bad in [
        "https://a.example.net",
        "a.example.net:443",
        "a/b",
        "",
        "-a.example.net",
        "a..b",
        "*.example.net",
    ] {
        let message = refused(&format!(
            r#"{{"publicUrl":"https://board.example.net","remoteHosts":["{bad}"]}}"#
        ));
        assert!(message.contains("remoteHosts"), "{bad}: {message}");
    }
}

#[test]
fn server_app_089_creating_the_file_reports_a_first_run_once_and_never_writes_a_public_url() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(dir.path());

    assert!(Settings::create_if_missing(&paths, "Ines").unwrap());
    let on_disk = fs::read_to_string(paths.settings_file()).unwrap();
    assert!(!on_disk.contains("publicUrl"), "{on_disk}");
    assert!(!Settings::create_if_missing(&paths, "Ines").unwrap());
}
