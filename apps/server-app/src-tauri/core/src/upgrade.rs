use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::backup::Backups;
use crate::log_file::AppLog;
use crate::supervisor::StartGate;

pub const BUNDLED_VERSION_RELATIVE: &str = "api/schema-version";
pub const RECORD_FILE: &str = "data-schema-version";
pub const MAX_VERSION_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Nothing,
    RecordOnly,
    BackupThenRecord,
}

pub fn is_valid_version(text: &str) -> bool {
    (1..=MAX_VERSION_LEN).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub fn decide(recorded: Option<&str>, bundled: &str, database_exists: bool) -> Step {
    if recorded == Some(bundled) {
        Step::Nothing
    } else if database_exists {
        Step::BackupThenRecord
    } else {
        Step::RecordOnly
    }
}

pub fn database_exists(data_dir: &Path) -> bool {
    fs::read_dir(data_dir).is_ok_and(|mut entries| entries.next().is_some())
}

pub fn bundled_version(resources: &Path) -> Result<String, String> {
    let file = resources.join(BUNDLED_VERSION_RELATIVE);
    let text = fs::read_to_string(&file).map_err(|error| {
        format!(
            "the bundled API schema version cannot be read ({}): {error}",
            file.display()
        )
    })?;
    let version = text.trim();
    if is_valid_version(version) {
        Ok(version.to_string())
    } else {
        Err(format!(
            "the bundled API schema version in {} is not valid",
            file.display()
        ))
    }
}

pub fn recorded_version(record: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(record) {
        Ok(text) => Ok(Some(text.trim().to_string())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "the recorded data schema version cannot be read ({}): {error}",
            record.display()
        )),
    }
}

fn record(file: &Path, version: &str) -> Result<(), String> {
    let mut staging = file.as_os_str().to_owned();
    staging.push(".tmp");
    let staging = PathBuf::from(staging);
    fs::write(&staging, format!("{version}\n"))
        .and_then(|()| fs::rename(&staging, file))
        .map_err(|error| {
            format!(
                "the data schema version cannot be recorded ({}): {error}",
                file.display()
            )
        })
}

#[derive(Debug, Clone)]
pub struct Upgrade {
    pub resources: PathBuf,
    pub record_file: PathBuf,
    pub backups: Backups,
    pub log: AppLog,
}

impl Upgrade {
    pub fn prepare(&self, cancel: &AtomicBool) -> Result<(), String> {
        let bundled = bundled_version(&self.resources)?;
        let recorded = recorded_version(&self.record_file)?;
        match decide(
            recorded.as_deref(),
            &bundled,
            database_exists(&self.backups.data_dir),
        ) {
            Step::Nothing => Ok(()),
            Step::RecordOnly => record(&self.record_file, &bundled),
            Step::BackupThenRecord => {
                let name = self
                    .backups
                    .pre_upgrade(&bundled, cancel, &self.log)
                    .map_err(|reason| format!("the pre-upgrade backup failed: {reason}"))?;
                self.log.info(&format!(
                    "pre-upgrade backup {name} made before schema {bundled}"
                ));
                record(&self.record_file, &bundled)
            }
        }
    }

    pub fn into_gate(self) -> StartGate {
        StartGate::new(move |cancel| self.prepare(cancel))
    }
}
