mod common;

use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_board_server_core::app::{self, Host, Running, Start};
use agent_board_server_core::durations::Durations;
use agent_board_server_core::handover::CommandRunner;
use agent_board_server_core::headless::serve_with;
use agent_board_server_core::login_item::Build;
use agent_board_server_core::opener::Opener;
use agent_board_server_core::overrides::Overrides;
use common::Bed;
use serde_json::Value;

#[derive(Default)]
struct Recorder(Mutex<Vec<PathBuf>>);

impl Opener for Recorder {
    fn open(&self, path: &Path) -> io::Result<()> {
        self.0.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

#[derive(Default)]
struct RunnerRecorder(Mutex<Vec<Vec<String>>>);

impl CommandRunner for RunnerRecorder {
    fn run(&self, args: &[String]) -> io::Result<i32> {
        self.0.lock().unwrap().push(args.to_vec());
        Ok(0)
    }
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

fn start(host: &Host) -> Box<Running> {
    match app::start(host).unwrap() {
        Start::Running(running) => running,
        Start::AlreadyRunning => panic!("the root is already locked"),
    }
}

fn drive(running: &Running, input: &str, opener: Arc<dyn Opener>) -> Vec<Value> {
    let mut out = Vec::new();
    serve_with(
        running,
        Cursor::new(input.to_string()),
        &mut out,
        opener,
        Arc::new(RunnerRecorder::default()),
        &|| None,
    );
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn server_app_022_stdin_actions_print_json_state_lines_and_quit_ends_the_run() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let recorder = Arc::new(Recorder::default());

    let events = drive(
        &running,
        "state\nnonsense\n\nopen-logs\nopen-settings\nquit\nstate\n",
        recorder.clone(),
    );

    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["state", "error", "action", "action", "quit"]);
    assert_eq!(events[0]["settings"]["status"], "loaded");
    assert_eq!(events[0]["settings"]["port"], 4785);
    assert_eq!(events[0]["settings"]["userName"], "ines");
    assert_eq!(events[0]["root"], running.root.path().to_str().unwrap());
    assert_eq!(events[0]["defaultRoot"], false);
    assert!(events[1]["message"].as_str().unwrap().contains("nonsense"));
    assert_eq!(events[2]["action"], "open-logs");
    assert_eq!(events[3]["ok"], true);
}

#[test]
fn server_app_022_the_end_of_input_quits_like_the_quit_action() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let events = drive(&running, "state\n", Arc::new(Recorder::default()));
    assert_eq!(events.last().unwrap()["type"], "quit");
}

#[test]
fn server_app_021_the_open_actions_open_the_logs_folder_and_the_settings_file() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let recorder = Arc::new(Recorder::default());
    drive(&running, "open-logs\nopen-settings\n", recorder.clone());
    assert_eq!(
        *recorder.0.lock().unwrap(),
        [running.paths.logs_dir(), running.paths.settings_file()]
    );
}

#[test]
fn server_app_021_settings_apply_only_after_quit_and_reopen() {
    let bed = Bed::new();
    let host = host(&bed);
    let running = start(&host);
    let settings_file = running.paths.settings_file();
    fs::write(&settings_file, r#"{"port": 5005}"#).unwrap();

    let events = drive(&running, "state\n", Arc::new(Recorder::default()));
    assert_eq!(events[0]["settings"]["port"], 4785);
    drop(running);

    let reopened = start(&host);
    let events = drive(&reopened, "state\n", Arc::new(Recorder::default()));
    assert_eq!(events[0]["settings"]["port"], 5005);
}

#[test]
fn server_app_031_a_second_start_on_the_same_root_is_told_the_app_is_running() {
    let bed = Bed::new();
    let host = host(&bed);
    let first = start(&host);

    assert!(matches!(app::start(&host).unwrap(), Start::AlreadyRunning));
    let mut out = Vec::new();
    let code = app::run_headless(&host, Cursor::new("quit\n"), &mut out);
    assert_eq!(code, 0);
    assert_eq!(
        String::from_utf8(out).unwrap().trim(),
        r#"{"type":"already-running"}"#
    );

    drop(first);
    assert!(matches!(app::start(&host).unwrap(), Start::Running(_)));
}

#[test]
fn server_app_067_refused_settings_keep_the_app_up_with_a_message_in_the_state_and_the_log() {
    let bed = Bed::new();
    let host = host(&bed);
    let root = host.root().unwrap();
    fs::create_dir_all(root.path()).unwrap();
    fs::write(root.paths().settings_file(), r#"{"port": 80}"#).unwrap();

    let running = start(&host);
    let events = drive(&running, "state\n", Arc::new(Recorder::default()));

    assert_eq!(events[0]["settings"]["status"], "refused");
    assert!(
        events[0]["settings"]["message"]
            .as_str()
            .unwrap()
            .contains("port")
    );
    let log = fs::read_to_string(root.paths().app_log()).unwrap();
    assert!(log.contains("ERROR settings refused"), "{log}");
    assert_eq!(
        fs::read_to_string(root.paths().settings_file()).unwrap(),
        r#"{"port": 80}"#
    );
}

#[test]
fn server_app_070_a_start_writes_timestamped_status_lines_to_the_app_log() {
    let bed = Bed::new();
    let host = host(&bed);
    let running = start(&host);
    drive(&running, "quit\n", Arc::new(Recorder::default()));

    let log = fs::read_to_string(running.paths.app_log()).unwrap();
    assert!(
        log.lines()
            .all(|line| line.len() > 25 && line.as_bytes()[10] == b'T'),
        "{log}"
    );
    assert!(log.contains("INFO starting"), "{log}");
    assert!(log.contains("INFO settings loaded, port 4785"), "{log}");
    assert!(log.contains("INFO quit"), "{log}");
}

#[test]
fn server_app_070_an_access_log_that_is_already_full_is_rotated_at_start() {
    let bed = Bed::new();
    let host = host(&bed);
    let root = host.root().unwrap();
    fs::create_dir_all(root.paths().logs_dir()).unwrap();
    fs::write(root.paths().access_log(), vec![b'a'; 10 * 1024 * 1024]).unwrap();

    let running = start(&host);

    assert!(!running.paths.access_log().exists());
    assert_eq!(
        fs::metadata(running.access_log.previous_generation())
            .unwrap()
            .len(),
        10 * 1024 * 1024
    );
}

#[test]
fn server_app_022_every_tray_action_is_parsed_and_the_unavailable_ones_are_refused() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let events = drive(
        &running,
        "open-board\npair-device\nbackup-now\nrestart-worker\nconnect-worker a b\nfrobnicate\n",
        Arc::new(Recorder::default()),
    );

    let refused: Vec<(&str, &str)> = events
        .iter()
        .filter(|event| event["type"] == "action")
        .map(|event| {
            assert_eq!(event["ok"], false);
            (
                event["action"].as_str().unwrap(),
                event["message"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        refused,
        [
            ("open-board", "the API is not running"),
            (
                "pair-device",
                "pairing needs the request signature: set requestSignature to true in settings.json and reopen the app"
            ),
            ("backup-now", "the API is not running"),
            ("restart-worker", "Worker not connected"),
            ("connect-worker", "the API is not running"),
        ]
    );
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "error"
                && event["message"] == "unknown action: frobnicate")
    );
}

#[test]
fn server_app_022_the_state_line_carries_the_supervision_rows() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let events = drive(&running, "state\n", Arc::new(Recorder::default()));

    let supervision = &events[0]["supervision"];
    assert!(
        supervision["api"]["text"]
            .as_str()
            .unwrap()
            .starts_with("API executable missing")
    );
    assert_eq!(supervision["api"]["state"], "failed");
    assert_eq!(supervision["worker"]["text"], "Worker not connected");
    assert_eq!(supervision["gaveUp"]["api"], false);
    assert!(supervision["blocked"].is_null());
}

fn stub_host(bed: &Bed) -> Host {
    let resources = bed.dir.path().join("resources");
    fs::create_dir_all(resources.join("api")).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_stub_child"),
        resources.join("api/agent-board-api"),
    )
    .unwrap();
    fs::write(resources.join("api/schema-version"), "stub-1\n").unwrap();
    let mut host = host(bed);
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let root = host.root().unwrap();
    fs::create_dir_all(root.path()).unwrap();
    fs::write(
        root.paths().settings_file(),
        format!(r#"{{"port": {port}}}"#),
    )
    .unwrap();
    host.overrides.resources_dir = Some(resources);
    host.overrides.durations = Durations::parse("grace=300,tick=5,startupProbe=10");
    host
}

fn api_pid(running: &Running) -> Option<u32> {
    fs::read_to_string(running.paths.root().join("run/api.pid"))
        .ok()?
        .lines()
        .next()?
        .parse()
        .ok()
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn server_app_032_a_signal_stops_the_children_and_quits_even_when_input_stays_open() {
    let bed = Bed::new();
    let host = stub_host(&bed);
    let running = start(&host);
    let (_keep_open, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pid = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let signal = {
        let flag = flag.clone();
        let pid = pid.clone();
        let run_dir = running.paths.root().join("run");
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                let text = fs::read_to_string(run_dir.join("api.pid")).unwrap_or_default();
                if let Some(Ok(value)) = text.lines().next().map(str::parse::<u32>) {
                    pid.store(value, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        })
    };

    let mut out = Vec::new();
    serve_with(
        &running,
        io::BufReader::new(reader),
        &mut out,
        Arc::new(Recorder::default()),
        Arc::new(RunnerRecorder::default()),
        &|| {
            flag.load(std::sync::atomic::Ordering::SeqCst)
                .then_some(libc::SIGTERM)
        },
    );
    signal.join().unwrap();

    let child = pid.load(std::sync::atomic::Ordering::SeqCst);
    assert_ne!(child, 0);
    assert!(!alive(child));
    assert!(api_pid(&running).is_none());
    let text = String::from_utf8(out).unwrap();
    assert!(text.trim_end().ends_with(r#"{"type":"quit"}"#), "{text}");
    let log = fs::read_to_string(running.paths.app_log()).unwrap();
    assert!(log.contains("SIGTERM received"), "{log}");
}

#[test]
fn server_app_028_restart_server_restarts_the_api_and_the_state_lines_follow() {
    let bed = Bed::new();
    let host = stub_host(&bed);
    let running = start(&host);
    let (mut keep_open, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    let writer = {
        let run_dir = running.paths.root().join("run");
        std::thread::spawn(move || {
            use std::io::Write;
            let first = wait_pid(&run_dir, None);
            keep_open.write_all(b"restart-server\n").unwrap();
            wait_pid(&run_dir, Some(first));
            std::thread::sleep(std::time::Duration::from_millis(400));
            keep_open.write_all(b"quit\n").unwrap();
            first
        })
    };

    let mut out = Vec::new();
    serve_with(
        &running,
        io::BufReader::new(reader),
        &mut out,
        Arc::new(Recorder::default()),
        Arc::new(RunnerRecorder::default()),
        &|| None,
    );
    let first = writer.join().unwrap();

    assert!(!alive(first));
    let events: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        events
            .iter()
            .any(|e| e["action"] == "restart-server" && e["ok"] == true)
    );
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "state" && e["supervision"]["api"]["state"] == "running")
    );
    assert_eq!(events.last().unwrap()["type"], "quit");
}

fn wait_pid(run_dir: &Path, different_from: Option<u32>) -> u32 {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let text = fs::read_to_string(run_dir.join("api.pid")).unwrap_or_default();
        if let Some(Ok(pid)) = text.lines().next().map(str::parse::<u32>)
            && Some(pid) != different_from
        {
            return pid;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("the api pid never appeared");
}

#[test]
fn server_app_089_restart_server_applies_remote_access_and_the_open_first_passkey_step() {
    let bed = Bed::new();
    let host = stub_host(&bed);
    let dump = bed.dir.path().join("api-env.txt");
    fs::write(
        bed.dir.path().join("resources/api/agent-board-api.conf"),
        format!("env_dump={}\n", dump.display()),
    )
    .unwrap();
    let running = start(&host);
    running
        .setup
        .remote_on("https://board.example.net")
        .unwrap();
    let opened = running.setup.first_passkey_open().unwrap();

    let (mut keep_open, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    let writer = {
        let run_dir = running.paths.root().join("run");
        let dump = dump.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            let dumped = |needle: &str| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                loop {
                    let text = fs::read_to_string(&dump).unwrap_or_default();
                    if text.contains(needle) || std::time::Instant::now() > deadline {
                        return text;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            };
            let first = wait_pid(&run_dir, None);
            let before = dumped("AUTH_MODE=");
            keep_open.write_all(b"state\nrestart-server\n").unwrap();
            wait_pid(&run_dir, Some(first));
            dumped("AUTH_MODE=login");
            keep_open.write_all(b"state\nquit\n").unwrap();
            before
        })
    };

    let mut out = Vec::new();
    serve_with(
        &running,
        io::BufReader::new(reader),
        &mut out,
        Arc::new(Recorder::default()),
        Arc::new(RunnerRecorder::default()),
        &|| None,
    );
    let before = writer.join().unwrap();
    let after = fs::read_to_string(&dump).unwrap();

    assert!(before.contains("AUTH_MODE=no-login"), "{before}");
    let lines: Vec<&str> = after.lines().collect();
    for expected in [
        "AUTH_MODE=login",
        "PUBLIC_URL=https://board.example.net",
        "PASSKEYS=on",
        "REQUEST_SIGNATURE=on",
        "CLAIM_USER=ines",
    ] {
        assert!(lines.contains(&expected), "{expected} in {after}");
    }
    assert!(lines.contains(&format!("SIGNUP_TOKEN={}", opened.token).as_str()));
    assert!(!after.contains("NO_LOGIN_USER"));

    let text = String::from_utf8(out).unwrap();
    assert!(!text.contains(&opened.token));
    let states: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["type"] == "state")
        .collect();
    assert_eq!(
        states.first().unwrap()["settings"]["publicUrl"],
        Value::Null
    );
    assert_eq!(
        states.last().unwrap()["settings"]["publicUrl"],
        "https://board.example.net"
    );
    assert_eq!(states.last().unwrap()["settings"]["requestSignature"], true);
    let log = fs::read_to_string(running.paths.app_log()).unwrap();
    assert!(log.contains("settings reloaded, remote access on"), "{log}");
    assert!(!log.contains(&opened.token));
}
