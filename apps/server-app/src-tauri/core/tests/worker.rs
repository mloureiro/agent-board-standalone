mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use common::worker::{Rig, eventually, read};
use rumo_server_core::cli_wrapper::{REFUSED_COMMANDS, REFUSED_EXIT_CODE, prepare_base};
use rumo_server_core::status::RowState;
use rumo_server_core::worker::NOT_CONNECTED;
use rumo_server_core::worker_paths::{
    INHERITED, WorkerPaths, fallback_tail, path_value, worker_env,
};

fn pid_of(rig: &Rig, unit: &str) -> Option<i32> {
    rig.log()
        .iter()
        .find_map(|line| line.strip_prefix(&format!("{unit} start ")))
        .and_then(|pid| pid.parse().ok())
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn server_app_043_the_app_runs_the_listener_the_watcher_and_the_dispatch_tick_from_the_recipe() {
    let rig = Rig::new("");
    rig.enrol();
    let worker = rig.worker();

    assert!(eventually(10, || {
        rig.count("listen start") == 1
            && rig.count("watch start") == 1
            && rig.count("dispatch") >= 2
    }));
    assert!(eventually(10, || worker.row().text == "ok"));
    assert!(
        !rig.dir.path().join("home/Library/LaunchAgents").exists(),
        "nothing is installed with launchd"
    );
    drop(worker);
}

#[test]
fn server_app_044_the_worker_directories_are_under_the_root_with_the_cli_linked_in_its_bin() {
    let rig = Rig::new("");
    prepare_base(&rig.setup).unwrap();

    let worker = rig.root.join("worker");
    for name in ["config", "state", "run", "bin"] {
        assert!(worker.join(name).is_dir(), "{name}");
    }
    assert_eq!(
        fs::read_link(worker.join("bin/rumo-cli")).unwrap(),
        rig.setup.cli_source
    );
    assert_eq!(rig.setup.paths, WorkerPaths::new(&rig.root));
}

#[test]
fn server_app_045_the_path_is_the_worker_bin_then_the_configured_entries_then_the_recipe_tail() {
    let paths = WorkerPaths::new(std::path::Path::new("/r"));
    let entries = vec![PathBuf::from("/opt/a"), PathBuf::from("/opt/b")];
    assert_eq!(
        path_value(&paths, &entries, "/usr/bin:/bin"),
        "/r/worker/bin:/opt/a:/opt/b:/usr/bin:/bin"
    );
    assert_eq!(
        fallback_tail(std::path::Path::new("/h")),
        "/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
}

#[test]
fn server_app_045_only_the_listed_variables_are_inherited_besides_the_profile_ones() {
    let paths = WorkerPaths::new(std::path::Path::new("/r"));
    let env = worker_env(&paths, &[], "/bin", &|name| Some(format!("v-{name}")));
    let mut names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    let mut expected: Vec<&str> = INHERITED.to_vec();
    expected.extend([
        "RUMO_CONFIG_DIR",
        "RUMO_CREDENTIALS_COMMAND",
        "RUMO_PROFILE",
        "RUMO_RUN_DIR",
        "RUMO_STATE_DIR",
        "PATH",
    ]);
    expected.sort_unstable();
    assert_eq!(names, expected);
}

#[test]
fn server_app_045_the_running_processes_get_exactly_that_environment() {
    let rig = Rig::with_entries("", vec![PathBuf::from("/opt/extra")]);
    rig.enrol();
    let worker = rig.worker();
    let env_file = rig.worker_dir().join("listen.env");
    assert!(eventually(10, || env_file.exists() && rig.count("listen start") == 1));
    std::thread::sleep(std::time::Duration::from_millis(100));

    let text = read(&env_file);
    let worker_dir = rig.worker_dir();
    assert!(text.contains("RUMO_PROFILE=server-app"));
    assert!(text.contains(&format!(
        "RUMO_CONFIG_DIR={}",
        worker_dir.join("config").display()
    )));
    assert!(text.contains(&format!(
        "RUMO_STATE_DIR={}",
        worker_dir.join("state").display()
    )));
    assert!(text.contains(&format!(
        "RUMO_RUN_DIR={}",
        worker_dir.join("run").display()
    )));
    assert!(text.contains(&format!(
        "PATH={}:/opt/extra:/usr/bin:/bin",
        worker_dir.join("bin").display()
    )));
    assert!(text.contains("HOME=value-of-HOME"));
    assert!(text.contains("SSH_AUTH_SOCK=value-of-SSH_AUTH_SOCK"));
    assert!(!text.contains("value-of-AWS"));
    drop(worker);
}

#[test]
fn server_app_046_before_enrolment_the_row_says_not_connected_and_nothing_runs() {
    let rig = Rig::new("");
    let worker = rig.worker();

    std::thread::sleep(std::time::Duration::from_millis(800));
    let row = worker.row();
    assert_eq!(row.text, NOT_CONNECTED);
    assert_eq!(row.state, RowState::Off);
    assert!(rig.log().is_empty());
    drop(worker);
}

#[test]
fn server_app_046_a_worker_waits_for_the_api_before_it_starts() {
    let rig = Rig::new("");
    rig.enrol();
    let gate = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen = std::sync::Arc::clone(&gate);
    let worker = rig.worker_gated(std::sync::Arc::new(move || {
        seen.load(std::sync::atomic::Ordering::SeqCst)
    }));

    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(rig.log().is_empty());
    assert_eq!(worker.row().text, "Starting");
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(eventually(10, || rig.count("listen start") == 1));
    drop(worker);
}

#[test]
fn server_app_007_the_worker_names_and_folders_never_collide_with_another_install() {
    let first = Rig::new("");
    let second = Rig::new("");
    assert_ne!(first.setup.paths.config(), second.setup.paths.config());
    assert!(first.setup.paths.config().starts_with(&first.root));
    assert!(first.setup.paths.state().starts_with(&first.root));
    assert!(first.setup.paths.run().starts_with(&first.root));
    let env = first.setup.env("/bin");
    let profile = env
        .iter()
        .find(|(name, _)| name == "RUMO_PROFILE")
        .map(|(_, value)| value.as_str());
    assert_eq!(profile, Some("server-app"));
    assert_ne!(profile, Some("default"));
}

#[test]
fn server_app_056_the_row_shows_the_last_tick_and_withholds_secrets() {
    let rig = Rig::new("TICK_STATUS=refused\nTICK_MESSAGE='token abm_Secret99 is wrong machine'");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || worker.row().text.starts_with("refused")));
    let row = worker.row();
    assert_eq!(row.state, RowState::Failed);
    assert_eq!(
        row.text,
        "refused \u{2014} token [redacted] is wrong machine"
    );
    drop(worker);

    let rig = Rig::new("TICK_STATUS=error\nTICK_MESSAGE='the board is unreachable'");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || worker.row().text.starts_with("error")));
    assert_eq!(worker.row().text, "error \u{2014} the board is unreachable");
    drop(worker);

    let rig = Rig::new("");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || worker.row().text == "ok"));
    assert_eq!(worker.row().state, RowState::Running);
    drop(worker);
}

#[test]
fn server_app_056_a_tick_that_found_the_lock_held_keeps_the_previous_row() {
    let rig = Rig::new("TICK_EXIT=75");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || rig.count("dispatch") >= 2));
    assert_eq!(worker.row().text, "Starting");
    drop(worker);
}

#[test]
fn server_app_057_a_different_server_url_reruns_the_cli_init_at_start() {
    let rig = Rig::new("");
    rig.enrol();
    fs::create_dir_all(rig.worker_dir().join("config")).unwrap();
    fs::write(
        rig.worker_dir().join("config/server.json"),
        r#"{"url":"http://127.0.0.1:1111"}"#,
    )
    .unwrap();
    let worker = rig.worker();

    assert!(eventually(10, || rig.count("init ") == 1));
    assert_eq!(
        rig.log()
            .iter()
            .find(|line| line.starts_with("init "))
            .unwrap(),
        "init http://127.0.0.1:4799"
    );
    assert!(eventually(10, || rig.count("listen start") == 1));
    drop(worker);
}

#[test]
fn server_app_057_the_same_server_url_does_not_rerun_init() {
    let rig = Rig::new("");
    rig.enrol();
    fs::create_dir_all(rig.worker_dir().join("config")).unwrap();
    fs::write(
        rig.worker_dir().join("config/server.json"),
        r#"{"url":"http://127.0.0.1:4799"}"#,
    )
    .unwrap();
    let worker = rig.worker();

    assert!(eventually(10, || rig.count("listen start") == 1));
    assert_eq!(rig.count("init "), 0);
    drop(worker);
}

#[test]
fn server_app_057_a_failed_init_leaves_the_worker_stopped_with_the_reason() {
    let rig = Rig::new("ACCEPT_TOKEN=abm_other");
    rig.enrol();
    let worker = rig.worker();

    assert!(eventually(10, || worker.row().text.starts_with("error")));
    assert_eq!(rig.count("listen start"), 0);
    assert!(worker.row().text.contains("401"));
    drop(worker);
}

#[test]
fn server_app_058_quit_terminates_the_processes_then_pauses_the_cards_then_kills_stragglers() {
    let rig = Rig::new("IGNORE_TERM_WATCH=1");
    rig.enrol();
    let mut worker = rig.worker();
    assert!(eventually(10, || {
        rig.count("listen start") == 1 && rig.count("watch start") == 1
    }));
    let watch = pid_of(&rig, "watch").unwrap();

    worker.shutdown();

    let log = rig.log();
    let term = log.iter().position(|line| line == "listen term").unwrap();
    let ignored = log
        .iter()
        .position(|line| line == "watch ignored term")
        .unwrap();
    let pause = log
        .iter()
        .position(|line| line.starts_with("shutdown --grace"))
        .unwrap();
    assert!(term < pause && ignored < pause, "{log:?}");
    assert!(!alive(watch), "the straggler was killed");
    assert!(!alive(pid_of(&rig, "listen").unwrap()));
}

#[test]
fn server_app_058_a_failing_pause_does_not_stop_the_quit() {
    let rig = Rig::new("SHUTDOWN_FAIL=1");
    rig.enrol();
    let mut worker = rig.worker();
    assert!(eventually(10, || rig.count("listen start") == 1));
    worker.shutdown();
    assert!(!alive(pid_of(&rig, "listen").unwrap()));
}

#[test]
fn server_app_018_restart_restarts_the_processes_without_pausing_cards() {
    let rig = Rig::new("");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || rig.count("listen start") == 1
        && rig.count("watch start") == 1));

    worker.restart();

    assert!(eventually(10, || rig.count("listen start") == 2
        && rig.count("watch start") == 2));
    assert_eq!(rig.count("shutdown"), 0);
    drop(worker);
}

fn run_wrapper(rig: &Rig, args: &[&str]) -> std::process::Output {
    Command::new("/bin/sh")
        .arg(rig.worker_dir().join("bin/rumo"))
        .args(args)
        .env_clear()
        .output()
        .unwrap()
}

fn with_wrapper(rig: &Rig) {
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || rig
        .worker_dir()
        .join("bin/rumo")
        .exists()
        && rig.count("listen start") == 1));
    drop(worker);
}

#[test]
fn server_app_059_the_wrapper_refuses_the_managed_commands_with_exit_two() {
    let rig = Rig::new("");
    with_wrapper(&rig);

    for command in REFUSED_COMMANDS {
        let output = run_wrapper(&rig, &[command]);
        assert_eq!(output.status.code(), Some(REFUSED_EXIT_CODE), "{command}");
        assert!(String::from_utf8_lossy(&output.stderr).contains(command));
    }
    for args in [
        &["--profile", "other", "init"][..],
        &["--profile=other", "setup", "--enable"][..],
        &["--dry-run", "self-update"][..],
    ] {
        assert_eq!(run_wrapper(&rig, args).status.code(), Some(2), "{args:?}");
    }
}

#[test]
fn server_app_059_the_wrapper_gives_the_cli_the_worker_environment() {
    let rig = Rig::new("");
    with_wrapper(&rig);

    let output = run_wrapper(&rig, &["echo-env"]);
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(text.contains("profile=server-app"), "{text}");
    assert!(text.contains(&format!(
        "config={}",
        rig.worker_dir().join("config").display()
    )));
    assert!(text.contains(&rig.worker_dir().join("bin").display().to_string()));
}

#[test]
fn server_app_059_a_root_with_quotes_and_spaces_still_refuses_and_runs() {
    let rig = Rig::new("");
    let hostile = rig.dir.path().join("it's a \"root\" $(touch pwned)");
    let mut setup = (*rig.setup).clone();
    setup.root = hostile.clone();
    setup.paths = WorkerPaths::new(&hostile);
    setup.run_dir = hostile.join("run");
    prepare_base(&setup).unwrap();
    let env = setup.env("/usr/bin:/bin");
    rumo_server_core::cli_wrapper::install_wrapper(&setup, &env).unwrap();

    let wrapper = setup.paths.wrapper();
    let refused = Command::new("/bin/sh")
        .arg(&wrapper)
        .arg("init")
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(2));
    let allowed = Command::new("/bin/sh")
        .arg(&wrapper)
        .arg("echo-env")
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(allowed.status.code(), Some(0));
    assert!(!rig.dir.path().join("pwned").exists());
    assert!(!PathBuf::from("pwned").exists());
}

#[test]
fn server_app_053_no_file_or_argument_of_the_worker_holds_the_secrets() {
    let rig = Rig::new("");
    rig.enrol();
    let worker = rig.worker();
    assert!(eventually(10, || rig.count("listen start") == 1));
    drop(worker);

    fn walk(dir: &std::path::Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else if !path.is_symlink() {
                found.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&rig.root, &mut files);
    assert!(!files.is_empty());
    for file in files {
        let text = read(&file);
        assert!(!text.contains("abm_good"), "{}", file.display());
        assert!(!text.contains("abk1_good"), "{}", file.display());
    }
    assert!(
        rig.log().iter().all(|line| !line.contains("abm_")),
        "the CLI was given no secret on its command line"
    );
    let script = read(&rig.setup.paths.credentials_script(false));
    assert!(script.contains("--worker-credentials"));
    assert!(!script.contains("--pending"));
    assert!(read(&rig.setup.paths.credentials_script(true)).contains("--pending"));
    let mode = fs::metadata(rig.setup.paths.credentials_script(false))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o755);
}
