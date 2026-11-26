use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use agent_board_server_core::control::{ApiState, ControlClient, Timeouts};

type Handler = Box<dyn Fn(&str) -> Option<(u16, String)> + Send + 'static>;

struct Fake {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    requests: Arc<Mutex<Vec<String>>>,
}

fn serve(handler: Handler) -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("api.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buffer = [0u8; 4096];
            let count = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..count]).into_owned();
            let first = request.lines().next().unwrap_or("").to_string();
            seen.lock().unwrap().push(first.clone());
            match handler(&first) {
                Some((status, body)) => {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
                None => thread::sleep(Duration::from_secs(5)),
            }
        }
    });
    Fake {
        _dir: dir,
        socket,
        requests,
    }
}

fn fast(socket: PathBuf) -> ControlClient {
    ControlClient::with_timeouts(
        socket,
        Timeouts {
            command: Duration::from_millis(300),
            hold: Duration::from_millis(300),
        },
    )
}

#[test]
fn server_app_035_the_control_client_speaks_the_apis_hold_resume_status_and_pair_code() {
    let fake = serve(Box::new(|line| match line {
        "POST /hold HTTP/1.1" | "POST /resume HTTP/1.1" => Some((200, r#"{"ok":true}"#.into())),
        "POST /status HTTP/1.1" => Some((200, r#"{"ok":true,"state":"held"}"#.into())),
        "POST /pair-code HTTP/1.1" => Some((200, r#"{"code":"ABCD-1234"}"#.into())),
        _ => Some((404, r#"{"error":"unknown command"}"#.into())),
    }));
    let client = fast(fake.socket.clone());

    client.hold().unwrap();
    assert_eq!(client.status().unwrap(), ApiState::Held);
    client.resume().unwrap();
    assert_eq!(client.pair_code().unwrap(), "ABCD-1234");

    assert_eq!(
        *fake.requests.lock().unwrap(),
        [
            "POST /hold HTTP/1.1",
            "POST /status HTTP/1.1",
            "POST /resume HTTP/1.1",
            "POST /pair-code HTTP/1.1"
        ]
    );
}

#[test]
fn server_app_035_an_error_answer_carries_the_apis_reason() {
    let fake = serve(Box::new(|line| match line {
        "POST /pair-code HTTP/1.1" => Some((409, r#"{"error":"REQUEST_SIGNATURE is off"}"#.into())),
        _ => Some((500, "not json".into())),
    }));
    let client = fast(fake.socket.clone());

    assert_eq!(
        client.pair_code().unwrap_err().to_string(),
        "REQUEST_SIGNATURE is off"
    );
    assert_eq!(
        client.hold().unwrap_err().to_string(),
        "the API answered 500"
    );
}

#[test]
fn server_app_035_a_silent_or_missing_control_channel_times_out_instead_of_hanging() {
    let fake = serve(Box::new(|_| None));
    let client = fast(fake.socket.clone());

    let started = Instant::now();
    let error = client.hold().unwrap_err().to_string();

    assert!(started.elapsed() < Duration::from_secs(3), "{error}");
    assert!(error.contains("did not answer hold"), "{error}");

    let missing = fast(fake.socket.with_file_name("none.sock"));
    assert!(
        missing
            .resume()
            .unwrap_err()
            .to_string()
            .contains("did not answer resume")
    );
}
