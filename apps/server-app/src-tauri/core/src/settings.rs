use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::paths::{AppPaths, has_parent_component};

pub const DEFAULT_PORT: u16 = 4785;
pub const MIN_PORT: u64 = 1024;
pub const MAX_PORT: u64 = 65535;
pub const MAX_REMOTE_HOSTS: usize = 8;
pub const USER_NAME_MAX: usize = 64;
pub const MAX_WORKER_PATH_ENTRIES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError(String);

impl SettingsError {
    fn new(message: impl Into<String>) -> SettingsError {
        SettingsError(message.into())
    }
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SettingsError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub user_name: String,
    pub data_dir: PathBuf,
    pub backup_dir: PathBuf,
    pub port: u16,
    pub start_at_login: bool,
    pub worker_path: Vec<PathBuf>,
    pub remote_hosts: Vec<String>,
    pub request_signature: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawWorkerPath {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawSettings {
    user_name: Option<String>,
    data_dir: Option<String>,
    backup_dir: Option<String>,
    port: Option<u64>,
    start_at_login: Option<bool>,
    worker_path: Option<RawWorkerPath>,
    remote_hosts: Option<Vec<String>>,
    request_signature: Option<bool>,
}

pub fn is_valid_user_name(name: &str) -> bool {
    (1..=USER_NAME_MAX).contains(&name.len())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn is_valid_host(host: &str) -> bool {
    host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn absolute_dir(
    key: &str,
    value: Option<String>,
    fallback: PathBuf,
) -> Result<PathBuf, SettingsError> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let path = PathBuf::from(&value);
    if value.is_empty() || !path.is_absolute() || has_parent_component(&path) {
        return Err(SettingsError::new(format!(
            "settings.json: {key} must be an absolute path without `..`, got {value:?}"
        )));
    }
    Ok(path.components().collect())
}

fn worker_path_entries(raw: Option<RawWorkerPath>) -> Result<Vec<PathBuf>, SettingsError> {
    let entries = match raw {
        None => Vec::new(),
        Some(RawWorkerPath::One(entry)) => vec![entry],
        Some(RawWorkerPath::Many(entries)) => entries,
    };
    if entries.len() > MAX_WORKER_PATH_ENTRIES {
        return Err(SettingsError::new(format!(
            "settings.json: workerPath takes at most {MAX_WORKER_PATH_ENTRIES} entries, got {}",
            entries.len()
        )));
    }
    entries
        .into_iter()
        .map(|entry| {
            if entry.contains(':') {
                return Err(SettingsError::new(format!(
                    "settings.json: workerPath entry {entry:?} must not contain `:`"
                )));
            }
            absolute_dir("workerPath", Some(entry), PathBuf::new())
        })
        .collect()
}

impl Settings {
    pub fn load(paths: &AppPaths, login_name: &str) -> Result<Settings, SettingsError> {
        let file = paths.settings_file();
        match fs::read_to_string(&file) {
            Ok(text) => Settings::parse(&text, paths, login_name),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Settings::parse("{}", paths, login_name)
            }
            Err(error) => Err(SettingsError::new(format!(
                "settings.json cannot be read ({}): {error}",
                file.display()
            ))),
        }
    }

    pub fn load_or_create(paths: &AppPaths, login_name: &str) -> Result<Settings, SettingsError> {
        let file = paths.settings_file();
        if !file.exists() {
            let defaults = Settings::parse("{}", paths, login_name)?;
            defaults.create_file(&file)?;
        }
        Settings::load(paths, login_name)
    }

    fn create_file(&self, file: &Path) -> Result<(), SettingsError> {
        let unreadable = |error: io::Error| {
            SettingsError::new(format!(
                "settings.json cannot be created ({}): {error}",
                file.display()
            ))
        };
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(unreadable)?;
        }
        let text = serde_json::to_string_pretty(&serde_json::json!({
            "userName": self.user_name,
            "dataDir": self.data_dir,
            "backupDir": self.backup_dir,
            "port": self.port,
            "startAtLogin": self.start_at_login,
            "remoteHosts": self.remote_hosts,
            "requestSignature": self.request_signature,
        }))
        .map_err(|error| SettingsError::new(error.to_string()))?;
        match OpenOptions::new().write(true).create_new(true).open(file) {
            Ok(mut created) => created
                .write_all(format!("{text}\n").as_bytes())
                .map_err(unreadable),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(unreadable(error)),
        }
    }

    pub fn parse(
        text: &str,
        paths: &AppPaths,
        login_name: &str,
    ) -> Result<Settings, SettingsError> {
        let document: serde_json::Value = serde_json::from_str(text)
            .map_err(|error| SettingsError::new(format!("settings.json is not valid: {error}")))?;
        if let Some(key) = document
            .as_object()
            .and_then(|object| object.iter().find(|(_, value)| value.is_null()))
            .map(|(key, _)| key)
        {
            return Err(SettingsError::new(format!(
                "settings.json: {key} must not be null"
            )));
        }
        let raw: RawSettings = serde_json::from_value(document)
            .map_err(|error| SettingsError::new(format!("settings.json is not valid: {error}")))?;

        let user_name = match raw.user_name {
            Some(name) if is_valid_user_name(&name) => name,
            Some(name) => {
                return Err(SettingsError::new(format!(
                    "settings.json: userName must match [a-z0-9._-]{{1,64}}, got {name:?}"
                )));
            }
            None => {
                let derived = login_name.to_lowercase();
                if !is_valid_user_name(&derived) {
                    return Err(SettingsError::new(format!(
                        "the macOS login name {login_name:?} does not match [a-z0-9._-]{{1,64}}; set userName in settings.json"
                    )));
                }
                derived
            }
        };

        let port = match raw.port {
            None => DEFAULT_PORT,
            Some(port) if (MIN_PORT..=MAX_PORT).contains(&port) => port as u16,
            Some(port) => {
                return Err(SettingsError::new(format!(
                    "settings.json: port must be between {MIN_PORT} and {MAX_PORT}, got {port}"
                )));
            }
        };

        let remote_hosts = raw.remote_hosts.unwrap_or_default();
        if remote_hosts.len() > MAX_REMOTE_HOSTS {
            return Err(SettingsError::new(format!(
                "settings.json: remoteHosts takes at most {MAX_REMOTE_HOSTS} host names, got {}",
                remote_hosts.len()
            )));
        }
        if let Some(bad) = remote_hosts.iter().find(|host| !is_valid_host(host)) {
            return Err(SettingsError::new(format!(
                "settings.json: remoteHosts entry {bad:?} is not a bare host name"
            )));
        }
        let request_signature = raw.request_signature.unwrap_or(false);
        if !remote_hosts.is_empty() && !request_signature {
            return Err(SettingsError::new(
                "settings.json: remoteHosts needs requestSignature: true",
            ));
        }

        Ok(Settings {
            user_name,
            data_dir: absolute_dir("dataDir", raw.data_dir, paths.default_data_dir())?,
            backup_dir: absolute_dir("backupDir", raw.backup_dir, paths.default_backup_dir())?,
            port,
            start_at_login: raw.start_at_login.unwrap_or(true),
            worker_path: worker_path_entries(raw.worker_path)?,
            remote_hosts: remote_hosts
                .iter()
                .map(|host| host.to_ascii_lowercase())
                .collect(),
            request_signature,
        })
    }
}
