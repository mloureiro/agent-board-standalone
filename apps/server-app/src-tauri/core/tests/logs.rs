use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use agent_board_server_core::log_file::{AppLog, LogFile, ROTATE_AT_BYTES};
use agent_board_server_core::redact::{MASK, redact};
use agent_board_server_core::timestamp;

const HEX_64: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn server_app_070_the_app_log_lines_carry_a_timestamp_and_a_level() {
    let dir = tempfile::tempdir().unwrap();
    let log = AppLog::new(LogFile::new(dir.path().join("logs/app.log")));
    log.info("api started");
    log.error("port 4785 in use");

    let text = fs::read_to_string(dir.path().join("logs/app.log")).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2);
    for line in &lines {
        let (stamp, rest) = line.split_once(' ').unwrap();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(
            stamp.ends_with('Z') && stamp.as_bytes()[10] == b'T',
            "{stamp}"
        );
        assert!(
            rest.starts_with("INFO ") || rest.starts_with("ERROR "),
            "{rest}"
        );
    }
    assert!(lines[0].ends_with("INFO api started"));
    assert!(lines[1].ends_with("ERROR port 4785 in use"));
}

#[test]
fn server_app_070_a_message_stays_on_one_line() {
    let dir = tempfile::tempdir().unwrap();
    let log = AppLog::new(LogFile::new(dir.path().join("app.log")));
    log.error("first\nsecond\r\nthird");
    let text = fs::read_to_string(dir.path().join("app.log")).unwrap();
    assert_eq!(text.lines().count(), 1);
    assert!(text.contains("first\\nsecond\\nthird"));
}

#[test]
fn server_app_070_the_access_log_is_its_own_file_next_to_the_app_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = agent_board_server_core::paths::AppPaths::new(dir.path());
    assert_eq!(paths.access_log().parent(), paths.app_log().parent());
    assert_ne!(paths.access_log(), paths.app_log());
    let access = LogFile::new(paths.access_log());
    access.append("GET /healthz 200").unwrap();
    assert_eq!(
        fs::read_to_string(paths.access_log()).unwrap(),
        "GET /healthz 200\n"
    );
    assert!(!paths.app_log().exists());
}

#[test]
fn server_app_070_timestamps_are_utc_with_milliseconds() {
    assert_eq!(timestamp::format(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    let leap_day = UNIX_EPOCH + Duration::new(1_709_210_096, 42_000_000);
    assert_eq!(timestamp::format(leap_day), "2024-02-29T12:34:56.042Z");
    let later = UNIX_EPOCH + Duration::from_secs(4_102_444_799);
    assert_eq!(timestamp::format(later), "2099-12-31T23:59:59.000Z");
}

#[test]
fn server_app_071_a_log_rotates_when_the_next_line_would_pass_the_limit_and_keeps_one_generation() {
    let dir = tempfile::tempdir().unwrap();
    let log = LogFile::with_limit(dir.path().join("app.log"), 100);
    for index in 0..30 {
        log.append(&format!("line {index:02} {}", "x".repeat(20)))
            .unwrap();
    }
    let current = fs::metadata(log.path()).unwrap().len();
    let previous = fs::metadata(log.previous_generation()).unwrap().len();
    assert!(current <= 100 && previous <= 100);
    assert!(
        previous > 60,
        "a generation holds whole lines up to the limit: {previous}"
    );
    assert!(!dir.path().join("app.log.2").exists());
    let last = fs::read_to_string(log.path()).unwrap();
    assert!(last.contains("line 29"));
}

#[test]
fn server_app_071_the_default_limit_is_10_mib() {
    assert_eq!(ROTATE_AT_BYTES, 10 * 1024 * 1024);
}

#[test]
fn server_app_071_a_log_that_is_already_full_is_rotated_before_a_child_appends_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let log = LogFile::with_limit(dir.path().join("access.log"), 50);
    fs::write(log.path(), "y".repeat(50)).unwrap();
    log.rotate_if_full().unwrap();
    assert!(!log.path().exists());
    assert_eq!(
        fs::read_to_string(log.previous_generation()).unwrap(),
        "y".repeat(50)
    );

    fs::write(log.path(), "short").unwrap();
    log.rotate_if_full().unwrap();
    assert_eq!(fs::read_to_string(log.path()).unwrap(), "short");
}

#[test]
fn server_app_071_concurrent_writers_lose_no_generation_and_no_line() {
    let dir = tempfile::tempdir().unwrap();
    let path = Arc::new(dir.path().join("app.log"));
    let limit = 1_000;
    let done = Arc::new(AtomicBool::new(false));

    let observer = {
        let path = Arc::clone(&path);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            let log = LogFile::with_limit((*path).clone(), limit);
            let mut smallest = u64::MAX;
            while !done.load(Ordering::SeqCst) {
                if let Ok(meta) = fs::metadata(log.previous_generation()) {
                    smallest = smallest.min(meta.len());
                }
            }
            smallest
        })
    };
    let writers: Vec<_> = (0..16)
        .map(|writer| {
            let path = Arc::clone(&path);
            thread::spawn(move || {
                let log = LogFile::with_limit((*path).clone(), limit);
                for index in 0..300 {
                    log.append(&format!(
                        "writer {writer:02} line {index:03} {}",
                        "z".repeat(30)
                    ))
                    .unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    done.store(true, Ordering::SeqCst);
    let smallest_generation = observer.join().unwrap();

    assert!(
        smallest_generation > limit - 100,
        "a generation shrank to {smallest_generation} bytes: a second rotation replaced a full one"
    );
    let log = LogFile::with_limit((*path).clone(), limit);
    let current = fs::read_to_string(log.path()).unwrap();
    let previous = fs::read_to_string(log.previous_generation()).unwrap();
    assert!(current.len() as u64 <= limit);
    for line in current.lines().chain(previous.lines()) {
        assert!(
            line.starts_with("writer ") && line.ends_with(&"z".repeat(30)),
            "{line}"
        );
    }
}

#[test]
fn server_app_072_issued_tokens_data_keys_and_hex_secrets_are_masked() {
    let secrets = [
        "abc_AbC123-xyz_9",
        "abm_AbC123-xyz_9",
        "abs_AbC123-xyz_9",
        "abk1_AbC123-xyz_9",
        HEX_64,
        &format!("{HEX_64}{HEX_64}"),
    ];
    for secret in secrets {
        let line = format!("enrolled with {secret} for ines");
        let masked = redact(&line);
        assert_eq!(masked, format!("enrolled with {MASK} for ines"), "{secret}");
    }
}

#[test]
fn server_app_072_authorization_headers_are_masked_in_any_spelling() {
    for line in [
        "Authorization: Bearer abc_secret",
        "authorization=Basic Zm9vOmJhcg==",
        r#"{"authorization":"Bearer whatever"}"#,
        "headers { AUTHORIZATION : token }",
    ] {
        let masked = redact(line);
        assert!(masked.contains(MASK), "{masked}");
        assert!(!masked.contains("Bearer"), "{masked}");
        assert!(!masked.contains("Zm9v"), "{masked}");
        assert!(!masked.contains("whatever"), "{masked}");
    }
}

#[test]
fn server_app_072_ordinary_text_is_left_alone() {
    assert_eq!(redact("GET /api/boards 200"), "GET /api/boards 200");
    assert_eq!(
        redact("grabs_value and tabs_open stay"),
        "grabs_value and tabs_open stay"
    );
    assert_eq!(
        redact("sha1 0123456789abcdef is short"),
        "sha1 0123456789abcdef is short"
    );
    assert_eq!(redact("abc_ alone"), "abc_ alone");
}

#[test]
fn server_app_072_no_written_line_keeps_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    let app = AppLog::new(LogFile::new(dir.path().join("app.log")));
    let access = LogFile::new(dir.path().join("access.log"));
    app.info("worker token abm_Secret123 stored");
    app.error(&format!("data key abk1_Secret456 and {HEX_64}"));
    access
        .append("POST /api/x 200 Authorization: Bearer abc_Secret789")
        .unwrap();

    for name in ["app.log", "access.log"] {
        let text = fs::read_to_string(dir.path().join(name)).unwrap();
        for secret in ["Secret123", "Secret456", "Secret789", HEX_64, "Bearer"] {
            assert!(!text.contains(secret), "{name}: {text}");
        }
    }
}
