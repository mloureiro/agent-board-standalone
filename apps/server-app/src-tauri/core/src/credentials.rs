use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::overrides::Overrides;

pub const WORKER_TOKEN: &str = "worker-token";
pub const WORKER_DATA_KEY: &str = "worker-data-key";
pub const PENDING_WORKER_TOKEN: &str = "worker-token.pending";
pub const PENDING_WORKER_DATA_KEY: &str = "worker-data-key.pending";
pub const ACCOUNTS: [&str; 4] = [
    WORKER_TOKEN,
    WORKER_DATA_KEY,
    PENDING_WORKER_TOKEN,
    PENDING_WORKER_DATA_KEY,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialError(String);

impl CredentialError {
    pub fn new(message: impl Into<String>) -> CredentialError {
        CredentialError(message.into())
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CredentialError {}

impl From<io::Error> for CredentialError {
    fn from(error: io::Error) -> CredentialError {
        CredentialError(error.to_string())
    }
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, CredentialError>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError>;
}

pub struct FileStore {
    path: PathBuf,
}

type Entries = BTreeMap<String, BTreeMap<String, String>>;

impl FileStore {
    pub fn new(path: PathBuf) -> FileStore {
        FileStore { path }
    }

    fn lock(&self) -> Result<File, CredentialError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut name = self.path.clone().into_os_string();
        name.push(".lock");
        let guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(PathBuf::from(name))?;
        if unsafe { libc::flock(guard.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(guard)
    }

    fn read(&self) -> Result<Entries, CredentialError> {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|error| {
                CredentialError::new(format!("credential file is not valid: {error}"))
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Entries::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn write(&self, entries: &Entries) -> Result<(), CredentialError> {
        let mut temporary = self.path.clone().into_os_string();
        temporary.push(".partial");
        let temporary = PathBuf::from(temporary);
        let text = serde_json::to_string_pretty(entries)
            .map_err(|error| CredentialError::new(error.to_string()))?;
        {
            use std::io::Write;
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(text.as_bytes())?;
        }
        fs::rename(&temporary, &self.path)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl CredentialStore for FileStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, CredentialError> {
        let _guard = self.lock()?;
        Ok(self
            .read()?
            .get(service)
            .and_then(|accounts| accounts.get(account))
            .cloned())
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialError> {
        let _guard = self.lock()?;
        let mut entries = self.read()?;
        entries
            .entry(service.to_string())
            .or_default()
            .insert(account.into(), value.into());
        self.write(&entries)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
        let _guard = self.lock()?;
        let mut entries = self.read()?;
        if let Some(accounts) = entries.get_mut(service) {
            accounts.remove(account);
            if accounts.is_empty() {
                entries.remove(service);
            }
        }
        self.write(&entries)
    }
}

pub struct KeychainStore;

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    use super::{CredentialError, CredentialStore, KeychainStore};

    const ITEM_NOT_FOUND: i32 = -25300;

    fn failure(error: security_framework::base::Error) -> CredentialError {
        CredentialError::new(format!("Keychain: {error}"))
    }

    impl CredentialStore for KeychainStore {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, CredentialError> {
            match get_generic_password(service, account) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| CredentialError::new("Keychain item is not text")),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(failure(error)),
            }
        }

        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialError> {
            set_generic_password(service, account, value.as_bytes()).map_err(failure)
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
            match delete_generic_password(service, account) {
                Err(error) if error.code() != ITEM_NOT_FOUND => Err(failure(error)),
                _ => Ok(()),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for KeychainStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, CredentialError> {
        Err(CredentialError::new("the Keychain exists only on macOS"))
    }

    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), CredentialError> {
        Err(CredentialError::new("the Keychain exists only on macOS"))
    }

    fn delete(&self, _: &str, _: &str) -> Result<(), CredentialError> {
        Err(CredentialError::new("the Keychain exists only on macOS"))
    }
}

pub fn open_store(overrides: &Overrides) -> Box<dyn CredentialStore> {
    match &overrides.credential_store_file {
        Some(path) => Box::new(FileStore::new(path.clone())),
        None => Box::new(KeychainStore),
    }
}
