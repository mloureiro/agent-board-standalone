#![allow(dead_code)]
pub mod worker;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rumo_server_core::credentials::FileStore;
use rumo_server_core::launchctl::Launchctl;
use rumo_server_core::paths::Root;
use tempfile::TempDir;

#[derive(Default)]
pub struct RecordingLaunchctl(pub Mutex<Vec<String>>);

impl Launchctl for RecordingLaunchctl {
    fn bootout(&self, label: &str) -> io::Result<()> {
        self.0.lock().unwrap().push(label.to_string());
        Ok(())
    }
}

impl RecordingLaunchctl {
    pub fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

pub struct Bed {
    pub dir: TempDir,
    pub home: PathBuf,
    pub agents: PathBuf,
}

impl Bed {
    pub fn new() -> Bed {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let agents = home.join("Library/LaunchAgents");
        fs::create_dir_all(&home).unwrap();
        Bed { dir, home, agents }
    }

    pub fn default_root(&self) -> Root {
        Root::resolve(None, &self.home).unwrap()
    }

    pub fn custom_root(&self, name: &str) -> Root {
        Root::resolve(Some(self.dir.path().join(name).as_os_str()), &self.home).unwrap()
    }

    pub fn store(&self) -> FileStore {
        FileStore::new(self.dir.path().join("credentials.json"))
    }

    pub fn app_folder(&self, root: &Root) {
        fs::create_dir_all(root.path().join("data/pglite")).unwrap();
        fs::write(root.path().join("settings.json"), "{}\n").unwrap();
        fs::write(root.path().join("data/pglite/file"), "row").unwrap();
    }
}

pub fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn repo_json(relative: &str) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let text = fs::read_to_string(root.join(relative)).unwrap_or_else(|_| {
        panic!("{relative} is missing: run `pnpm --filter @rumo/contract run build`")
    });
    serde_json::from_str(&text).unwrap()
}
