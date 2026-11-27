use std::path::PathBuf;
use std::sync::Arc;

use crate::credentials::CredentialStore;
use crate::durations::Durations;
use crate::log_file::AppLog;
use crate::paths::AppPaths;
use crate::worker_paths::{WorkerPaths, worker_env};

pub type EnvGetter = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub const CLI_RELATIVE: &str = "cli/rumo";

#[derive(Clone)]
pub struct WorkerSetup {
    pub root: PathBuf,
    pub app_paths: AppPaths,
    pub paths: WorkerPaths,
    pub service: String,
    pub store: Arc<dyn CredentialStore>,
    pub store_file: Option<PathBuf>,
    pub cli_source: PathBuf,
    pub executable: PathBuf,
    pub home: PathBuf,
    pub api_url: Result<String, String>,
    pub path_entries: Vec<PathBuf>,
    pub durations: Durations,
    pub log: AppLog,
    pub run_dir: PathBuf,
    pub inherited: EnvGetter,
}

impl WorkerSetup {
    pub fn env(&self, path_tail: &str) -> Vec<(String, String)> {
        worker_env(
            &self.paths,
            &self.path_entries,
            path_tail,
            self.inherited.as_ref(),
        )
    }
}
