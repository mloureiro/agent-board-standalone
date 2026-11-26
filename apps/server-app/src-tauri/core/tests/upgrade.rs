use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_board_server_core::backup::{Backups, Kind, parse_entry};
use agent_board_server_core::durations::Durations;
use agent_board_server_core::log_file::{AppLog, LogFile};
use agent_board_server_core::spec::ChildSpec;
use agent_board_server_core::status::{RowState, Status};
use agent_board_server_core::supervisor::{Plan, StartGate, Supervisor};
use agent_board_server_core::upgrade::{
    BUNDLED_VERSION_RELATIVE, RECORD_FILE, Step, Upgrade, database_exists, decide,
};
use tempfile::TempDir;

const STUB: &str = env!("CARGO_BIN_EXE_stub_child");

struct Bed {
    dir: TempDir,
}

impl Bed {
    fn new(bundled: Option<&str>) -> Bed {
        let dir = tempfile::tempdir().unwrap();
        let bed = Bed { dir };
        fs::create_dir_all(bed.root().join("data")).unwrap();
        fs::create_dir_all(bed.resources().join("api")).unwrap();
        if let Some(version) = bundled {
            fs::write(
                bed.resources().join(BUNDLED_VERSION_RELATIVE),
                format!("{version}\n"),
            )
            .unwrap();
        }
        bed
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("root")
    }

    fn resources(&self) -> PathBuf {
        self.dir.path().join("resources")
    }

    fn data(&self) -> PathBuf {
        self.root().join("data")
    }

    fn record(&self) -> PathBuf {
        self.root().join(RECORD_FILE)
    }

    fn with_database(&self) -> &Bed {
        fs::write(self.data().join("PG_VERSION"), "17").unwrap();
        self
    }

    fn upgrade_to(&self, backup_dir: PathBuf) -> Upgrade {
        Upgrade {
            resources: self.resources(),
            record_file: self.record(),
            backups: Backups::new(backup_dir, self.data()),
            log: AppLog::new(LogFile::new(self.dir.path().join("app.log"))),
        }
    }

    fn upgrade(&self) -> Upgrade {
        self.upgrade_to(self.root().join("backups"))
    }

    fn pre_upgrade_backups(&self, backup_dir: &Path) -> Vec<String> {
        fs::read_dir(backup_dir)
            .map(|listing| {
                listing
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| {
                        parse_entry(name).is_some_and(|entry| entry.kind == Kind::PreUpgrade)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn never() -> AtomicBool {
    AtomicBool::new(false)
}

#[test]
fn server_app_041_the_decision_table_backs_up_only_when_a_database_meets_a_new_or_unknown_version()
{
    assert_eq!(decide(Some("a"), "a", true), Step::Nothing);
    assert_eq!(decide(Some("a"), "a", false), Step::Nothing);
    assert_eq!(decide(Some("a"), "b", true), Step::BackupThenRecord);
    assert_eq!(decide(None, "b", true), Step::BackupThenRecord);
    assert_eq!(decide(Some("a"), "b", false), Step::RecordOnly);
    assert_eq!(decide(None, "b", false), Step::RecordOnly);
}

#[test]
fn server_app_041_a_changed_version_copies_the_database_first_and_records_the_version_after() {
    let bed = Bed::new(Some("0004_relax"));
    bed.with_database();
    fs::write(bed.record(), "0003_signing\n").unwrap();
    let upgrade = bed.upgrade();

    upgrade.prepare(&never()).unwrap();

    let backups = bed.pre_upgrade_backups(&bed.root().join("backups"));
    assert_eq!(backups.len(), 1);
    assert!(backups[0].starts_with("pre-upgrade-0004_relax-"));
    assert_eq!(
        fs::read_to_string(
            bed.root()
                .join("backups")
                .join(&backups[0])
                .join("PG_VERSION")
        )
        .unwrap(),
        "17"
    );
    assert_eq!(
        fs::read_to_string(bed.record()).unwrap().trim(),
        "0004_relax"
    );

    upgrade.prepare(&never()).unwrap();
    assert_eq!(
        bed.pre_upgrade_backups(&bed.root().join("backups")).len(),
        1,
        "an unchanged version makes no second backup"
    );
}

#[test]
fn server_app_041_a_missing_record_with_a_database_is_backed_up_and_without_one_is_just_recorded() {
    let with = Bed::new(Some("v1"));
    with.with_database();
    with.upgrade().prepare(&never()).unwrap();
    assert_eq!(
        with.pre_upgrade_backups(&with.root().join("backups")).len(),
        1
    );
    assert_eq!(fs::read_to_string(with.record()).unwrap().trim(), "v1");

    let without = Bed::new(Some("v1"));
    assert!(!database_exists(&without.data()));
    without.upgrade().prepare(&never()).unwrap();
    assert!(
        without
            .pre_upgrade_backups(&without.root().join("backups"))
            .is_empty()
    );
    assert_eq!(fs::read_to_string(without.record()).unwrap().trim(), "v1");
}

#[test]
fn server_app_042_a_failed_copy_blocks_and_records_nothing() {
    let bed = Bed::new(Some("v2"));
    bed.with_database();
    fs::write(bed.record(), "v1\n").unwrap();
    let readonly = bed.dir.path().join("readonly");
    fs::create_dir_all(&readonly).unwrap();
    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o500)).unwrap();
    let upgrade = bed.upgrade_to(readonly.join("backups"));

    let error = upgrade.prepare(&never()).unwrap_err();

    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        error.starts_with("the pre-upgrade backup failed"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(bed.record()).unwrap().trim(), "v1");
}

#[test]
fn server_app_042_a_backup_dir_inside_the_data_dir_blocks_the_upgrade() {
    let bed = Bed::new(Some("v2"));
    bed.with_database();
    let upgrade = bed.upgrade_to(bed.data().join("backups"));

    let error = upgrade.prepare(&never()).unwrap_err();

    assert!(error.contains("must not be inside"), "{error}");
    assert!(!bed.record().exists());
}

#[test]
fn server_app_042_an_unreadable_or_invalid_bundled_version_blocks_even_without_a_database() {
    let missing = Bed::new(None);
    assert!(
        missing
            .upgrade()
            .prepare(&never())
            .unwrap_err()
            .contains("cannot be read")
    );

    let invalid = Bed::new(Some("not a version"));
    assert!(
        invalid
            .upgrade()
            .prepare(&never())
            .unwrap_err()
            .contains("is not valid")
    );
    assert!(!invalid.record().exists());
}

struct Rig {
    dir: TempDir,
    statuses: Arc<Mutex<Vec<Status>>>,
}

impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("run")).unwrap();
        Rig {
            dir,
            statuses: Arc::default(),
        }
    }

    fn plan(&self) -> Plan {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = self.dir.path().join("api.conf");
        fs::write(
            &config,
            format!(
                "order_log={}\nlabel=api\n",
                self.dir.path().join("order.log").display()
            ),
        )
        .unwrap();
        Plan {
            api: Ok(ChildSpec {
                name: "api".to_string(),
                program: PathBuf::from(STUB),
                args: Vec::new(),
                env: vec![
                    ("STUB_CONFIG".to_string(), config.display().to_string()),
                    ("HOST".to_string(), "127.0.0.1".to_string()),
                    ("PORT".to_string(), port.to_string()),
                ],
                log: self.dir.path().join("logs/api.log"),
                health_port: Some(port),
            }),
            worker: None,
            durations: Durations {
                restart_delays: vec![Duration::from_millis(100); 3],
                stable_reset: Duration::from_secs(60),
                probe_interval: Duration::from_millis(40),
                probe_timeout: Duration::from_millis(500),
                probe_misses: 3,
                startup_probe_interval: Duration::from_millis(10),
                startup_deadline: Duration::from_secs(5),
                stop_grace: Duration::from_millis(300),
                tick: Duration::from_millis(5),
            },
            run_dir: self.dir.path().join("run"),
        }
    }

    fn start(&self, gate: StartGate) -> Supervisor {
        let statuses = Arc::clone(&self.statuses);
        Supervisor::start_gated(
            self.plan(),
            Some(gate),
            AppLog::new(LogFile::new(self.dir.path().join("logs/app.log"))),
            Arc::new(move |status| statuses.lock().unwrap().push(status.clone())),
        )
    }

    fn started(&self) -> bool {
        self.dir.path().join("order.log").exists()
    }
}

fn eventually(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn server_app_042_a_blocked_api_is_not_started_shows_the_reason_and_restart_server_retries() {
    let rig = Rig::new();
    let allow = Arc::new(AtomicBool::new(false));
    let gate = {
        let allow = Arc::clone(&allow);
        StartGate::new(move |_| {
            if allow.load(std::sync::atomic::Ordering::SeqCst) {
                Ok(())
            } else {
                Err("the pre-upgrade backup failed: disk full".to_string())
            }
        })
    };
    let supervisor = rig.start(gate);

    assert!(eventually(|| supervisor.status().blocked.is_some()));
    let status = supervisor.status();
    assert_eq!(status.api.state, RowState::Failed);
    assert_eq!(
        status.api.text,
        "Blocked: the pre-upgrade backup failed: disk full"
    );
    assert_eq!(
        status.blocked.as_deref(),
        Some("the pre-upgrade backup failed: disk full")
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!rig.started(), "the API never starts while blocked");
    assert!(!status.gave_up.api);

    allow.store(true, std::sync::atomic::Ordering::SeqCst);
    supervisor.restart_server();

    assert!(eventually(|| {
        let status = supervisor.status();
        status.api.state == RowState::Running && status.blocked.is_none()
    }));
    assert!(rig.started());
    supervisor.stop();
}
