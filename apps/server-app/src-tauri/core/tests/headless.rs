mod common;

use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agent_board_server_core::app::{self, Host, Running, Start};
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

fn host(bed: &Bed) -> Host {
    Host {
        home: bed.home.clone(),
        login_name: "Ines".to_string(),
        root_env: Some(bed.dir.path().join("board-root").into_os_string()),
        overrides: Overrides::default(),
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

fn drive(running: &Running, input: &str, opener: &dyn Opener) -> Vec<Value> {
    let mut out = Vec::new();
    serve_with(running, Cursor::new(input.to_string()), &mut out, opener);
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
    let recorder = Recorder::default();

    let events = drive(
        &running,
        "state\nnonsense\n\nopen-logs\nopen-settings\nquit\nstate\n",
        &recorder,
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
    let events = drive(&running, "state\n", &Recorder::default());
    assert_eq!(events.last().unwrap()["type"], "quit");
}

#[test]
fn server_app_021_the_open_actions_open_the_logs_folder_and_the_settings_file() {
    let bed = Bed::new();
    let running = start(&host(&bed));
    let recorder = Recorder::default();
    drive(&running, "open-logs\nopen-settings\n", &recorder);
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

    let events = drive(&running, "state\n", &Recorder::default());
    assert_eq!(events[0]["settings"]["port"], 4785);
    drop(running);

    let reopened = start(&host);
    let events = drive(&reopened, "state\n", &Recorder::default());
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
    let events = drive(&running, "state\n", &Recorder::default());

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
    drive(&running, "quit\n", &Recorder::default());

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
