use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumo_server_core::control::ControlClient;
use rumo_server_core::log_file::{AppLog, LogFile};
use rumo_server_core::pairing::{self, VALIDITY};
use rumo_server_core::redact::{MASK, redact};
use serde_json::json;

fn serve(status: u16, body: &'static str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("api.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (dir, socket)
}

#[test]
fn server_app_090_the_code_comes_from_the_control_channel_with_a_ten_minute_expiry() {
    let (_dir, socket) = serve(200, r#"{"code":"WXYZ-2345"}"#);
    let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);

    let issued = pairing::issue(&ControlClient::new(socket), now).unwrap();

    assert_eq!(issued.code, "WXYZ-2345");
    assert_eq!(issued.expires_at, "2023-11-14T22:23:20.000Z");
    assert_eq!(VALIDITY, Duration::from_secs(600));
    assert_eq!(
        issued.to_json(),
        json!({
            "type": "pair-code",
            "code": "WXYZ-2345",
            "expiresAt": "2023-11-14T22:23:20.000Z",
            "validForSeconds": 600,
        })
    );
}

#[test]
fn server_app_090_a_refusal_from_the_api_reaches_the_caller_verbatim() {
    let (_dir, socket) = serve(
        409,
        r#"{"error":"REQUEST_SIGNATURE is off: there is nothing to pair"}"#,
    );
    let error = pairing::issue(&ControlClient::new(socket), SystemTime::now()).unwrap_err();
    assert_eq!(error, "REQUEST_SIGNATURE is off: there is nothing to pair");
}

#[test]
fn server_app_090_an_unreachable_channel_is_an_error_not_a_code() {
    let dir = tempfile::tempdir().unwrap();
    let error = pairing::issue(
        &ControlClient::new(dir.path().join("none.sock")),
        SystemTime::now(),
    )
    .unwrap_err();
    assert!(error.contains("did not answer"), "{error}");
}

#[test]
fn server_app_090_a_pairing_code_is_masked_in_every_log_line() {
    assert_eq!(
        redact("pair code WXYZ-2345 shown"),
        format!("pair code {MASK} shown")
    );
    assert_eq!(redact("GET /api/pair 200"), "GET /api/pair 200");
    assert_eq!(
        redact("started 2026-11-26 at ABCD"),
        "started 2026-11-26 at ABCD"
    );

    let dir = tempfile::tempdir().unwrap();
    let log = AppLog::new(LogFile::new(dir.path().join("app.log")));
    log.info("the code is WXYZ-2345");
    let written = fs::read_to_string(dir.path().join("app.log")).unwrap();
    assert!(!written.contains("WXYZ-2345"), "{written}");
    assert!(written.contains(MASK));
}
