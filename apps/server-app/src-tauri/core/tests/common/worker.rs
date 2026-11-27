#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rumo_server_core::cli_run::ProcessCli;
use rumo_server_core::credential_flow::{Pair, write_pair};
use rumo_server_core::credentials::{CredentialStore, FileStore};
use rumo_server_core::durations::Durations;
use rumo_server_core::log_file::{AppLog, LogFile};
use rumo_server_core::paths::AppPaths;
use rumo_server_core::worker::Worker;
use rumo_server_core::worker_paths::WorkerPaths;
use rumo_server_core::worker_setup::WorkerSetup;
use tempfile::TempDir;

pub const STUB_BOARD: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub-board.sh");
pub const SERVICE: &str = "dev.mloureiro.rumo-server.test";

pub fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

pub fn fast() -> Durations {
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

pub fn eventually(seconds: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(ms(10));
    }
    false
}

pub fn good_pair() -> Pair {
    Pair {
        token: "abm_good".to_string(),
        data_key: "abk1_good".to_string(),
    }
}

pub struct Rig {
    pub dir: TempDir,
    pub root: PathBuf,
    pub store: Arc<FileStore>,
    pub setup: Arc<WorkerSetup>,
}

impl Rig {
    pub fn new(conf: &str) -> Rig {
        Rig::with_entries(conf, Vec::new())
    }

    pub fn with_entries(conf: &str, entries: Vec<PathBuf>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let cli_dir = dir.path().join("resources/cli");
        fs::create_dir_all(&cli_dir).unwrap();
        fs::create_dir_all(&root).unwrap();
        let cli = cli_dir.join("rumo");
        fs::copy(STUB_BOARD, &cli).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(cli_dir.join("board.conf"), format!("{conf}\n")).unwrap();
        let app = dir.path().join("fake-app");
        fs::write(
            &app,
            "#!/bin/sh\nprintf 'RUMO_TOKEN=abm_good\\nRUMO_DATA_KEY=abk1_good\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&app, fs::Permissions::from_mode(0o755)).unwrap();
        let store = Arc::new(FileStore::new(dir.path().join("credentials.json")));
        let app_paths = AppPaths::new(&root);
        let setup = Arc::new(WorkerSetup {
            root: root.clone(),
            app_paths: app_paths.clone(),
            paths: WorkerPaths::new(&root),
            service: SERVICE.to_string(),
            store: store.clone() as Arc<dyn CredentialStore>,
            store_file: Some(dir.path().join("credentials.json")),
            cli_source: cli,
            executable: app,
            home: dir.path().join("home"),
            api_url: Ok("http://127.0.0.1:4799".to_string()),
            path_entries: entries,
            durations: fast(),
            log: AppLog::new(LogFile::new(app_paths.app_log())),
            run_dir: root.join("run"),
            inherited: Arc::new(|name| Some(format!("value-of-{name}"))),
        });
        Rig {
            dir,
            root,
            store,
            setup,
        }
    }

    pub fn enrol(&self) {
        write_pair(self.store.as_ref(), SERVICE, false, &good_pair()).unwrap();
    }

    pub fn worker(&self) -> Worker {
        self.worker_gated(Arc::new(|| true))
    }

    pub fn worker_gated(&self, gate: rumo_server_core::worker::Gate) -> Worker {
        Worker::start(
            Arc::clone(&self.setup),
            Arc::new(ProcessCli::new(Arc::clone(&self.setup))),
            gate,
            Arc::new(|| {}),
        )
    }

    pub fn worker_dir(&self) -> PathBuf {
        self.root.join("worker")
    }

    pub fn log(&self) -> Vec<String> {
        fs::read_to_string(self.worker_dir().join("stub.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    pub fn count(&self, prefix: &str) -> usize {
        self.log()
            .iter()
            .filter(|line| line.starts_with(prefix))
            .count()
    }

    pub fn position(&self, prefix: &str) -> Option<usize> {
        self.log().iter().position(|line| line.starts_with(prefix))
    }
}

pub fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}
