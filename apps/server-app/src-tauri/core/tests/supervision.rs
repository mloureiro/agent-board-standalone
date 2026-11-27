use std::fs;
use std::net::TcpListener;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rumo_server_core::durations::Durations;
use rumo_server_core::health;
use rumo_server_core::log_file::{AppLog, LogFile};
use rumo_server_core::orphans;
use rumo_server_core::paths::AppPaths;
use rumo_server_core::process_group::group_is_alive;
use rumo_server_core::settings::Settings;
use rumo_server_core::spec::{self, ChildSpec};
use rumo_server_core::status::{RowState, Status};
use rumo_server_core::supervisor::{Plan, Supervisor};
use tempfile::TempDir;

const STUB: &str = env!("CARGO_BIN_EXE_stub_child");

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn fast() -> Durations {
    Durations {
        restart_delays: vec![ms(100), ms(200), ms(400)],
        stable_reset: Duration::from_secs(60),
        probe_interval: ms(40),
        probe_timeout: ms(500),
        probe_misses: 3,
        startup_probe_interval: ms(10),
        startup_deadline: Duration::from_secs(5),
        stop_grace: ms(300),
        tick: ms(5),
    }
}

fn eventually(seconds: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(ms(10));
    }
    false
}

// Below the OS ephemeral range, so no parallel test's outgoing socket can take a handed-out port.
const PORT_RANGE: std::ops::Range<u16> = 20_000..30_000;

static NEXT_PORT: AtomicU32 = AtomicU32::new(0);

fn free_port() -> u16 {
    let span = u32::from(PORT_RANGE.end - PORT_RANGE.start);
    loop {
        let index = NEXT_PORT.fetch_add(1, Ordering::SeqCst) + std::process::id() * 64;
        let port = PORT_RANGE.start + (index % span) as u16;
        if !health::port_in_use(port) {
            return port;
        }
    }
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

struct Rig {
    dir: TempDir,
    port: u16,
    statuses: Arc<Mutex<Vec<Status>>>,
}

impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("run")).unwrap();
        Rig {
            dir,
            port: free_port(),
            statuses: Arc::default(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn run_dir(&self) -> PathBuf {
        self.path("run")
    }

    fn config(&self, name: &str) -> PathBuf {
        self.path(&format!("{name}.conf"))
    }

    fn write(&self, name: &str, text: &str) {
        let order = self.path("order.log");
        let body = format!("order_log={}\nlabel={name}\n{text}\n", order.display());
        fs::write(self.config(name), body).unwrap();
    }

    fn order(&self) -> Vec<String> {
        fs::read_to_string(self.path("order.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn starts(&self, label: &str) -> Vec<u128> {
        self.order()
            .iter()
            .filter_map(|line| line.strip_prefix(&format!("start {label} ")))
            .filter_map(|millis| millis.parse().ok())
            .collect()
    }

    fn spec(&self, name: &str, health: bool) -> ChildSpec {
        ChildSpec {
            name: name.to_string(),
            program: PathBuf::from(STUB),
            args: Vec::new(),
            env: vec![
                (
                    "STUB_CONFIG".to_string(),
                    self.config(name).display().to_string(),
                ),
                ("HOST".to_string(), "127.0.0.1".to_string()),
                ("PORT".to_string(), self.port.to_string()),
            ],
            log: self.path(&format!("logs/{name}.log")),
            health_port: health.then_some(self.port),
        }
    }

    fn plan(&self, worker: bool, durations: Durations) -> Plan {
        Plan {
            api: Ok(self.spec("api", true)),
            worker: worker.then(|| self.spec("worker", false)),
            durations,
            run_dir: self.run_dir(),
        }
    }

    fn start(&self, plan: Plan) -> Supervisor {
        let log = AppLog::new(LogFile::new(self.path("logs/app.log")));
        let statuses = Arc::clone(&self.statuses);
        Supervisor::start(
            plan,
            log,
            Arc::new(move |status| statuses.lock().unwrap().push(status.clone())),
        )
    }

    fn pid(&self, name: &str) -> Option<u32> {
        fs::read_to_string(self.run_dir().join(format!("{name}.pid")))
            .ok()?
            .lines()
            .next()?
            .parse()
            .ok()
    }

    fn app_log(&self) -> String {
        fs::read_to_string(self.path("logs/app.log")).unwrap_or_default()
    }
}

fn running(supervisor: &Supervisor) -> bool {
    supervisor.status().api.state == RowState::Running
}

#[test]
fn server_app_024_the_worker_starts_after_the_api_is_first_healthy_and_stops_before_it() {
    let rig = Rig::new();
    rig.write("api", "startup_delay_ms=400");
    rig.write("worker", "health=none");
    let supervisor = rig.start(rig.plan(true, fast()));

    assert!(eventually(10, || rig.starts("worker").len() == 1));
    let api = rig.starts("api")[0];
    let worker = rig.starts("worker")[0];
    assert!(
        worker >= api + 400,
        "worker started {} ms after the api",
        worker - api
    );
    assert!(eventually(5, || running(&supervisor)));
    supervisor.stop();

    let order: Vec<String> = rig
        .order()
        .iter()
        .map(|line| line.split(' ').take(2).collect::<Vec<_>>().join(" "))
        .collect();
    assert_eq!(
        order,
        ["start api", "start worker", "stop worker", "stop api"]
    );
    let history = rig.statuses.lock().unwrap();
    assert!(history.iter().all(|status| {
        status.worker.state != RowState::Running || status.api.state != RowState::Starting
    }));
}

#[test]
fn server_app_025_a_crashing_process_restarts_after_the_set_delays_and_the_fourth_crash_gives_up() {
    let rig = Rig::new();
    rig.write("api", "health=none\ncrash_after_ms=20");
    let supervisor = rig.start(rig.plan(false, fast()));

    assert!(eventually(10, || supervisor.status().gave_up.api));
    let starts = rig.starts("api");
    assert_eq!(starts.len(), 4);
    for (index, delay) in [100u128, 200, 400].iter().enumerate() {
        let gap = starts[index + 1] - starts[index];
        assert!(gap >= *delay, "restart {} came after {gap} ms", index + 1);
    }
    std::thread::sleep(ms(800));
    assert_eq!(rig.starts("api").len(), 4);
    assert_eq!(supervisor.status().api.state, RowState::GaveUp);
    assert_eq!(supervisor.status().api.text, "Gave up after 4 crashes");
    assert!(rig.app_log().contains("gave up"));
}

#[test]
fn server_app_025_a_give_up_leaves_the_worker_running() {
    let rig = Rig::new();
    rig.write("api", "health=none\ncrash_after_ms=20");
    rig.write("worker", "health=none");
    let supervisor = rig.start(rig.plan(true, fast()));
    assert!(eventually(10, || supervisor.status().gave_up.api));
    assert!(rig.starts("worker").is_empty());
    supervisor.stop();
}

#[test]
fn server_app_026_a_stable_healthy_run_resets_the_restart_count() {
    let rig = Rig::new();
    rig.write("api", "crash_after_ms=300");
    let mut durations = fast();
    durations.stable_reset = ms(100);
    let supervisor = rig.start(rig.plan(false, durations));

    assert!(eventually(20, || rig.starts("api").len() >= 6));
    assert!(!supervisor.status().gave_up.api);
}

#[test]
fn server_app_026_the_api_stable_time_is_counted_from_a_healthy_probe_not_from_the_spawn() {
    let rig = Rig::new();
    rig.write("api", "startup_delay_ms=800\ncrash_after_ms=100");
    let mut durations = fast();
    durations.stable_reset = ms(500);
    let supervisor = rig.start(rig.plan(false, durations));

    assert!(eventually(20, || supervisor.status().gave_up.api));
    assert_eq!(rig.starts("api").len(), 4);
}

#[test]
fn server_app_027_two_missed_probes_in_a_row_do_not_count_as_a_crash() {
    let rig = Rig::new();
    rig.write("api", "fail_window=2:4");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));
    let pid = rig.pid("api");

    std::thread::sleep(ms(600));
    assert_eq!(rig.pid("api"), pid);
    assert_eq!(rig.starts("api").len(), 1);
    assert!(running(&supervisor));
}

#[test]
fn server_app_027_three_missed_probes_in_a_row_count_as_a_crash_and_restart_the_process() {
    let rig = Rig::new();
    rig.write("api", "fail_window=2:1000000");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));
    let first = rig.pid("api").unwrap();

    assert!(eventually(10, || rig.starts("api").len() >= 2));
    assert!(eventually(5, || !alive(first)));
    assert!(rig.app_log().contains("missed its health probes"));
}

#[test]
fn server_app_027_a_hanging_probe_times_out_and_counts_as_a_miss() {
    let rig = Rig::new();
    rig.write("api", "");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));
    rig.write("api", "health=hang");

    assert!(eventually(10, || rig.starts("api").len() >= 2));
}

#[test]
fn server_app_027_no_probe_runs_during_a_hold() {
    let rig = Rig::new();
    rig.write("api", "");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));
    let pid = rig.pid("api");

    supervisor.set_hold(true);
    rig.write("api", "health=fail");
    std::thread::sleep(ms(600));
    assert_eq!(rig.pid("api"), pid);

    supervisor.set_hold(false);
    assert!(eventually(10, || rig.starts("api").len() >= 2));
}

#[test]
fn server_app_028_a_killed_api_is_restarted_and_healthz_answers_again() {
    let rig = Rig::new();
    rig.write("api", "");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));
    let killed = rig.pid("api").unwrap();

    unsafe {
        libc::kill(killed as i32, libc::SIGKILL);
    }
    assert!(eventually(10, || {
        rig.pid("api").is_some_and(|pid| pid != killed) && running(&supervisor)
    }));
    assert!(health::probe(rig.port, Duration::from_secs(2)));
}

#[test]
fn server_app_029_a_child_that_ignores_sigterm_is_killed_after_the_grace_with_its_group() {
    let rig = Rig::new();
    let grandchild = rig.path("grandchild.pid");
    rig.write(
        "api",
        &format!(
            "ignore_term=1\ngrandchild_pid_file={}",
            grandchild.display()
        ),
    );
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor) && grandchild.exists()));
    let child = rig.pid("api").unwrap();
    let grandchild: u32 = fs::read_to_string(&grandchild).unwrap().parse().unwrap();

    let started = Instant::now();
    supervisor.stop();
    let took = started.elapsed();

    assert!(took >= ms(300), "stopped after {took:?}, before the grace");
    assert!(took < ms(2500), "stopped after {took:?}");
    assert!(eventually(5, || !alive(child) && !alive(grandchild)));
    assert!(rig.app_log().contains("killed after the grace period"));
}

#[test]
fn server_app_029_a_child_that_obeys_sigterm_stops_well_inside_the_grace() {
    let rig = Rig::new();
    rig.write("api", "");
    let mut durations = fast();
    durations.stop_grace = Duration::from_secs(5);
    let supervisor = rig.start(rig.plan(false, durations));
    assert!(eventually(10, || running(&supervisor)));

    let started = Instant::now();
    supervisor.stop();

    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(rig.order().contains(&"stop api".to_string()));
}

#[test]
fn server_app_029_each_child_appends_its_output_to_its_own_log() {
    let rig = Rig::new();
    rig.write("api", "crash_after_ms=20\nhealth=none");
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || rig.starts("api").len() >= 2));
    supervisor.stop();

    let log = fs::read_to_string(rig.path("logs/api.log")).unwrap();
    assert!(log.matches("stub started").count() >= 2, "{log}");
    assert!(log.contains("stub crashing"));
}

fn spawn_reaped(command: &mut Command) -> u32 {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    std::thread::spawn(move || child.wait());
    pid
}

fn leave_orphan(rig: &Rig, config: &str) -> u32 {
    let order = rig.path("orphan-order.log");
    fs::write(
        rig.path("orphan.conf"),
        format!("{config}\norder_log={}\nlabel=orphan\n", order.display()),
    )
    .unwrap();
    let pid = spawn_reaped(Command::new(STUB).env("STUB_CONFIG", rig.path("orphan.conf")));
    fs::write(rig.run_dir().join("api.pid"), format!("{pid}\n{STUB}\n")).unwrap();
    pid
}

#[test]
fn server_app_030_an_orphan_named_by_a_pid_file_is_terminated_before_the_api_starts() {
    let rig = Rig::new();
    rig.write("api", "");
    let orphan = leave_orphan(&rig, "health=none");
    assert!(alive(orphan));

    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(!alive(orphan));
    assert_ne!(rig.pid("api"), Some(orphan));
    assert!(rig.app_log().contains("orphan sweep"));
}

#[test]
fn server_app_030_an_orphan_that_ignores_sigterm_is_killed_after_the_grace() {
    let rig = Rig::new();
    rig.write("api", "");
    let orphan = leave_orphan(&rig, "health=none\nignore_term=1");

    let started = Instant::now();
    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(!alive(orphan));
    assert!(started.elapsed() >= ms(300));
    assert!(rig.app_log().contains("killed after the grace period"));
}

#[test]
fn server_app_030_a_pid_file_whose_command_no_longer_matches_leaves_the_process_alone() {
    let rig = Rig::new();
    rig.write("api", "");
    let mut bystander = Command::new("/bin/sleep").arg("300").spawn().unwrap();
    fs::write(
        rig.run_dir().join("api.pid"),
        format!("{}\n{STUB}\n", bystander.id()),
    )
    .unwrap();

    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(bystander.try_wait().unwrap().is_none());
    bystander.kill().unwrap();
    bystander.wait().unwrap();
}

#[test]
fn server_app_030_a_process_naming_the_program_only_as_an_argument_is_left_alone() {
    let rig = Rig::new();
    rig.write("api", "");
    let bystander = spawn_reaped(Command::new("/bin/sh").args(["-c", "sleep 300; :", STUB]));
    fs::write(
        rig.run_dir().join("api.pid"),
        format!("{bystander}\n{STUB}\n"),
    )
    .unwrap();

    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(alive(bystander));
    supervisor.stop();
    unsafe {
        libc::killpg(bystander as i32, libc::SIGKILL);
    }
}

#[test]
fn server_app_030_a_pid_reused_after_the_pid_file_was_written_is_left_alone() {
    let rig = Rig::new();
    rig.write("api", "");
    fs::write(rig.path("reused.conf"), "health=none\n").unwrap();
    let reused = spawn_reaped(Command::new(STUB).env("STUB_CONFIG", rig.path("reused.conf")));
    let file = rig.run_dir().join("api.pid");
    fs::write(&file, format!("{reused}\n{STUB}\n")).unwrap();
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();

    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(alive(reused));
    supervisor.stop();
    unsafe {
        libc::killpg(reused as i32, libc::SIGKILL);
    }
}

#[test]
fn server_app_030_a_process_that_does_not_lead_its_own_group_is_left_alone() {
    let rig = Rig::new();
    rig.write("api", "");
    fs::write(rig.path("member.conf"), "health=none\n").unwrap();
    let mut member = Command::new(STUB)
        .env("STUB_CONFIG", rig.path("member.conf"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    fs::write(
        rig.run_dir().join("api.pid"),
        format!("{}\n{STUB}\n", member.id()),
    )
    .unwrap();

    let supervisor = rig.start(rig.plan(false, fast()));
    assert!(eventually(10, || running(&supervisor)));

    assert!(member.try_wait().unwrap().is_none());
    supervisor.stop();
    member.kill().unwrap();
    member.wait().unwrap();
}

#[test]
fn server_app_030_elapsed_times_from_ps_parse_in_every_shape() {
    assert_eq!(
        orphans::parse_elapsed("00:07"),
        Some(Duration::from_secs(7))
    );
    assert_eq!(
        orphans::parse_elapsed("  12:34"),
        Some(Duration::from_secs(754))
    );
    assert_eq!(
        orphans::parse_elapsed("02:00:01"),
        Some(Duration::from_secs(7201))
    );
    assert_eq!(
        orphans::parse_elapsed("3-00:00:00"),
        Some(Duration::from_secs(3 * 86_400))
    );
    assert_eq!(orphans::parse_elapsed("soon"), None);
}

#[test]
fn server_app_030_the_command_must_start_with_the_program_path() {
    assert!(orphans::runs_program("/a b/api", "/a b/api"));
    assert!(orphans::runs_program("/a b/api --flag", "/a b/api"));
    assert!(!orphans::runs_program("/a b/api-old", "/a b/api"));
    assert!(!orphans::runs_program("vim /a b/api", "/a b/api"));
}

#[test]
fn server_app_032_stopping_while_the_api_is_still_starting_leaves_no_child() {
    let rig = Rig::new();
    rig.write("api", "startup_delay_ms=3000");
    rig.write("worker", "health=none");
    let supervisor = rig.start(rig.plan(true, fast()));
    assert!(eventually(10, || rig.pid("api").is_some()));
    let child = rig.pid("api").unwrap();

    supervisor.stop();

    assert!(!alive(child));
    assert!(rig.starts("worker").is_empty());
}

#[test]
fn server_app_032_dropping_the_supervisor_on_any_exit_path_stops_everything() {
    let rig = Rig::new();
    rig.write("api", "");
    rig.write("worker", "health=none");
    let supervisor = rig.start(rig.plan(true, fast()));
    assert!(eventually(10, || rig.pid("worker").is_some()));
    let (api, worker) = (rig.pid("api").unwrap(), rig.pid("worker").unwrap());

    drop(supervisor);

    assert!(!alive(api) && !alive(worker));
    assert!(!group_is_alive(api as i32));
    assert!(rig.pid("api").is_none() && rig.pid("worker").is_none());
}

#[test]
fn server_app_033_quit_is_bounded_by_the_grace_of_each_process() {
    let rig = Rig::new();
    rig.write("api", "ignore_term=1");
    rig.write("worker", "ignore_term=1\nhealth=none");
    let supervisor = rig.start(rig.plan(true, fast()));
    assert!(eventually(10, || rig.starts("worker").len() == 1));

    let started = Instant::now();
    supervisor.stop();
    let took = started.elapsed();

    assert!(took >= ms(600) && took < ms(3000), "quit took {took:?}");
}

#[test]
fn server_app_033_the_production_stop_budget_stays_inside_a_minute() {
    let production = Durations::production();
    assert_eq!(production.stop_grace, Duration::from_secs(10));
    assert!(production.worst_case_stop(2) <= Duration::from_secs(60));
}

#[test]
fn server_app_034_a_port_in_use_is_shown_on_the_api_row_and_the_supervisor_stays_up() {
    let rig = Rig::new();
    rig.write("api", "");
    let holder = TcpListener::bind(("127.0.0.1", rig.port)).unwrap();
    let supervisor = rig.start(rig.plan(false, fast()));

    let expected = format!("Port {} in use; change port in settings.json", rig.port);
    assert!(eventually(10, || supervisor.status().api.text == expected));
    assert_eq!(supervisor.status().api.state, RowState::Failed);
    std::thread::sleep(ms(300));
    assert!(rig.starts("api").is_empty());

    drop(holder);
    supervisor.restart_server();
    assert!(eventually(10, || running(&supervisor)));
}

#[test]
fn server_app_034_a_port_held_on_the_wildcard_address_counts_as_in_use() {
    let port = free_port();
    let holder = TcpListener::bind(("0.0.0.0", port)).unwrap();
    assert!(health::port_in_use(port));
    drop(holder);
    assert!(eventually(5, || !health::port_in_use(port)));
}

#[test]
fn server_app_017_restart_server_clears_a_give_up_and_never_touches_the_worker() {
    let rig = Rig::new();
    rig.write("api", "health=none\ncrash_after_ms=20");
    rig.write("worker", "health=none");
    let mut durations = fast();
    durations.restart_delays = vec![ms(10), ms(10), ms(10)];
    let supervisor = rig.start(rig.plan(true, durations));
    assert!(eventually(10, || supervisor.status().gave_up.api));

    rig.write("api", "");
    rig.write("worker", "health=none");
    supervisor.restart_server();

    assert!(eventually(10, || running(&supervisor)));
    assert!(!supervisor.status().gave_up.api);
    assert!(eventually(10, || rig.pid("worker").is_some()));
    let worker = rig.pid("worker");
    supervisor.restart_server();
    std::thread::sleep(ms(300));
    assert_eq!(rig.pid("worker"), worker);
}

fn settings_in(paths: &AppPaths, text: &str) -> Settings {
    fs::create_dir_all(paths.root()).unwrap();
    fs::write(paths.settings_file(), text).unwrap();
    Settings::load(paths, "ines").unwrap()
}

fn resources(dir: &Path) -> PathBuf {
    let api = dir.join("resources/api");
    fs::create_dir_all(&api).unwrap();
    fs::copy(STUB, api.join("rumo-api")).unwrap();
    dir.join("resources")
}

#[test]
fn server_app_074_the_api_gets_exactly_its_local_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(&paths, r#"{"port": 4999, "userName": "ines"}"#);
    let spec = spec::api_spec(&settings, &paths, &resources(dir.path()), None).unwrap();

    let root = paths.root().display();
    let expected = [
        ("AUTH_MODE", "no-login".to_string()),
        ("NO_LOGIN_USER", "ines".to_string()),
        ("DATABASE_URL", format!("pglite://{root}/data")),
        ("HOST", "127.0.0.1".to_string()),
        ("PORT", "4999".to_string()),
        ("ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]".to_string()),
        (
            "WEB_ROOT",
            format!("{}/resources/web", dir.path().display()),
        ),
        ("CONTROL_SOCKET", format!("{root}/run/api.sock")),
        ("ACCESS_LOG", format!("{root}/logs/access.log")),
    ];
    let actual: Vec<(&str, String)> = spec
        .env
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(spec.health_port, Some(4999));
}

fn env_of(spec: &spec::ChildSpec) -> Vec<(&str, &str)> {
    spec.env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

#[test]
fn server_app_074_the_request_signature_is_added_when_set() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(&paths, r#"{"requestSignature": true}"#);
    let spec = spec::api_spec(
        &settings,
        &paths,
        &resources(dir.path()),
        Some("t".repeat(43).as_str()),
    )
    .unwrap();
    let env = env_of(&spec);

    assert!(env.contains(&("REQUEST_SIGNATURE", "on")));
    assert!(env.contains(&("AUTH_MODE", "no-login")));
    assert!(
        !env.iter()
            .any(|(key, _)| *key == "SIGNUP_TOKEN" || *key == "CLAIM_USER")
    );
}

#[test]
fn server_app_089_remote_access_runs_the_api_in_login_mode_with_passkeys() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(
        &paths,
        r#"{"userName": "ines", "publicUrl": "https://board.example.net", "remoteHosts": ["mac.tail1234.ts.net"]}"#,
    );
    let spec = spec::api_spec(&settings, &paths, &resources(dir.path()), None).unwrap();
    let env = env_of(&spec);

    for expected in [
        ("AUTH_MODE", "login"),
        ("PUBLIC_URL", "https://board.example.net"),
        ("PASSKEYS", "on"),
        ("REQUEST_SIGNATURE", "on"),
        (
            "ALLOWED_HOSTS",
            "localhost,127.0.0.1,[::1],board.example.net,mac.tail1234.ts.net",
        ),
    ] {
        assert!(env.contains(&expected), "{expected:?} in {env:?}");
    }
    for absent in ["NO_LOGIN_USER", "SIGNUP_TOKEN", "CLAIM_USER", "TRUST_PROXY"] {
        assert!(!env.iter().any(|(key, _)| *key == absent), "{absent}");
    }
}

#[test]
fn server_app_089_the_sign_up_token_and_the_claimed_name_go_only_with_remote_access_and_an_open_step()
 {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(
        &paths,
        r#"{"userName": "ines", "publicUrl": "https://board.example.net"}"#,
    );
    let token = "a".repeat(43);
    let spec = spec::api_spec(&settings, &paths, &resources(dir.path()), Some(&token)).unwrap();
    let env = env_of(&spec);
    assert!(env.contains(&("SIGNUP_TOKEN", token.as_str())));
    assert!(env.contains(&("CLAIM_USER", "ines")));
    assert!(!format!("{spec:?}").contains(&token));
}

#[test]
fn server_app_074_the_child_runs_from_a_cleared_environment() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(&paths, &format!(r#"{{"port": {}}}"#, free_port()));
    let resources = resources(dir.path());
    let mut spec = spec::api_spec(&settings, &paths, &resources, None).unwrap();
    let dump = dir.path().join("env.txt");
    let config = dir.path().join("api.conf");
    fs::write(&config, format!("env_dump={}\n", dump.display())).unwrap();
    spec.env
        .push(("STUB_CONFIG".to_string(), config.display().to_string()));
    let plan = Plan {
        api: Ok(spec.clone()),
        worker: None,
        durations: fast(),
        run_dir: spec::run_dir(&paths),
    };

    let rig = Rig::new();
    let supervisor = rig.start(plan);
    assert!(eventually(10, || dump.exists() && running(&supervisor)));
    supervisor.stop();

    let mut names: Vec<String> = fs::read_to_string(&dump)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once('=').map(|(key, _)| key.to_string()))
        .collect();
    names.sort();
    let mut expected: Vec<String> = spec.env.iter().map(|(key, _)| key.clone()).collect();
    expected.sort();
    assert_eq!(names, expected);
}

#[test]
fn server_app_034_a_missing_api_executable_is_reported_on_the_row_without_a_crash_loop() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(&dir.path().join("root"));
    let settings = settings_in(&paths, "{}");
    let error = spec::api_spec(&settings, &paths, &dir.path().join("none"), None).unwrap_err();
    assert!(error.starts_with("API executable missing"));

    let rig = Rig::new();
    let plan = Plan {
        api: Err(error.clone()),
        worker: None,
        durations: fast(),
        run_dir: rig.run_dir(),
    };
    let supervisor = rig.start(plan);
    assert_eq!(supervisor.status().api.text, error);
    assert_eq!(supervisor.status().api.state, RowState::Failed);
}
