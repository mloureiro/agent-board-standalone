use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use crate::log_file::AppLog;
use crate::paths::has_parent_component;
use crate::timestamp;

pub const KEEP_MANUAL: usize = 5;
pub const MANUAL_PREFIX: &str = "manual-";
pub const PRE_UPGRADE_PREFIX: &str = "pre-upgrade-";
pub const PARTIAL_SUFFIX: &str = ".partial";

const STAMP_LEN: usize = 19;
const CHUNK: usize = 1024 * 1024;

pub trait ApiHold {
    fn hold(&self) -> Result<(), String>;
    fn resume(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub result: Result<String, String>,
    pub resume_failed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Manual,
    PreUpgrade,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    pub partial: bool,
}

#[derive(Debug, Clone)]
pub struct Backups {
    pub backup_dir: PathBuf,
    pub data_dir: PathBuf,
}

pub fn stamp(at: SystemTime) -> String {
    timestamp::format(at).replace(['-', ':', '.'], "")
}

fn is_stamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == STAMP_LEN
        && bytes[8] == b'T'
        && bytes[STAMP_LEN - 1] == b'Z'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 18) || byte.is_ascii_digit())
}

pub fn stamp_to_iso(text: &str) -> Option<String> {
    is_stamp(text).then(|| {
        format!(
            "{}-{}-{}T{}:{}:{}.{}Z",
            &text[0..4],
            &text[4..6],
            &text[6..8],
            &text[9..11],
            &text[11..13],
            &text[13..15],
            &text[15..18]
        )
    })
}

pub fn parse_entry(name: &str) -> Option<Entry> {
    let (base, partial) = match name.strip_suffix(PARTIAL_SUFFIX) {
        Some(base) => (base, true),
        None => (name, false),
    };
    let kind = if base.strip_prefix(MANUAL_PREFIX).is_some_and(is_stamp) {
        Kind::Manual
    } else if base
        .strip_prefix(PRE_UPGRADE_PREFIX)
        .and_then(|rest| rest.rsplit_once('-'))
        .is_some_and(|(version, at)| !version.is_empty() && is_stamp(at))
    {
        Kind::PreUpgrade
    } else {
        return None;
    };
    Some(Entry {
        name: name.to_string(),
        kind,
        partial,
    })
}

fn nearest_existing(path: &Path) -> (PathBuf, Vec<std::ffi::OsString>) {
    let mut rest = Vec::new();
    let mut probe = path.to_path_buf();
    loop {
        if fs::symlink_metadata(&probe).is_ok() {
            return (probe, rest);
        }
        match (probe.file_name().map(ToOwned::to_owned), probe.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                probe = parent.to_path_buf();
            }
            _ => return (probe, rest),
        }
    }
}

fn resolved(path: &Path) -> PathBuf {
    let (existing, rest) = nearest_existing(path);
    let mut real = fs::canonicalize(&existing).unwrap_or(existing);
    real.extend(rest.into_iter().rev());
    real
}

pub fn check_backup_dir(backup: &Path, data: &Path) -> Result<(), String> {
    if backup.as_os_str().is_empty() || !backup.is_absolute() || has_parent_component(backup) {
        return Err(format!(
            "the backup directory must be an absolute path without `..`, got {}",
            backup.display()
        ));
    }
    let inside = || {
        format!(
            "the backup directory {} must not be inside the data directory {}",
            backup.display(),
            data.display()
        )
    };
    let real_backup = resolved(backup);
    let real_data = resolved(data);
    if real_backup.starts_with(&real_data) {
        return Err(inside());
    }
    if let Ok(data_meta) = fs::metadata(&real_data) {
        let identity = (data_meta.dev(), data_meta.ino());
        let mut probe = Some(real_backup.as_path());
        while let Some(current) = probe {
            if fs::metadata(current).is_ok_and(|meta| (meta.dev(), meta.ino()) == identity) {
                return Err(inside());
            }
            probe = current.parent();
        }
    }
    Ok(())
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "the backup was cancelled")
}

fn copy_file(from: &Path, to: &Path, cancel: &AtomicBool) -> io::Result<()> {
    let mut source = File::open(from)?;
    let mut target = File::create_new(to)?;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        target.write_all(&buffer[..count])?;
    }
    target.sync_all()?;
    fs::set_permissions(to, source.metadata()?.permissions())
}

pub fn copy_tree(from: &Path, to: &Path, cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    let metadata = fs::symlink_metadata(from)?;
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return symlink(fs::read_link(from)?, to);
    }
    if kind.is_file() {
        return copy_file(from, to, cancel);
    }
    if !kind.is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a regular file, folder or link",
            from.display()
        )));
    }
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        copy_tree(&entry.path(), &to.join(entry.file_name()), cancel)?;
    }
    fs::set_permissions(to, metadata.permissions())
}

fn partial_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.as_os_str().to_owned();
    name.push(PARTIAL_SUFFIX);
    PathBuf::from(name)
}

fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

impl Backups {
    pub fn new(backup_dir: PathBuf, data_dir: PathBuf) -> Backups {
        Backups {
            backup_dir,
            data_dir,
        }
    }

    pub fn check(&self) -> Result<(), String> {
        check_backup_dir(&self.backup_dir, &self.data_dir)
    }

    pub fn entries(&self) -> Vec<Entry> {
        let Ok(listing) = fs::read_dir(&self.backup_dir) else {
            return Vec::new();
        };
        let mut entries: Vec<Entry> = listing
            .flatten()
            .filter_map(|entry| parse_entry(entry.file_name().to_str()?))
            .collect();
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        entries
    }

    pub fn last_manual(&self) -> Option<String> {
        self.entries()
            .iter()
            .rev()
            .find(|entry| entry.kind == Kind::Manual && !entry.partial)
            .and_then(|entry| stamp_to_iso(entry.name.strip_prefix(MANUAL_PREFIX)?))
    }

    fn prepare_dir(&self) -> Result<(), String> {
        self.check()?;
        fs::create_dir_all(&self.backup_dir).map_err(|error| {
            format!(
                "the backup directory {} cannot be created: {error}",
                self.backup_dir.display()
            )
        })?;
        self.check()
    }

    fn remove_partials(&self, log: &AppLog) {
        for entry in self.entries().into_iter().filter(|entry| entry.partial) {
            if let Err(error) = remove_tree(&self.backup_dir.join(&entry.name)) {
                log.error(&format!(
                    "stale partial backup {} could not be removed: {error}",
                    entry.name
                ));
            }
        }
    }

    fn copy_into(&self, final_name: &str, cancel: &AtomicBool) -> Result<(), String> {
        self.check()?;
        if !self.data_dir.is_dir() {
            return Err(format!(
                "there is no database to back up at {}",
                self.data_dir.display()
            ));
        }
        let target = self.backup_dir.join(final_name);
        let partial = partial_path(&target);
        if partial.exists() || target.exists() {
            return Err(format!("the backup {final_name} already exists"));
        }
        let copied = copy_tree(&self.data_dir, &partial, cancel)
            .and_then(|()| fs::rename(&partial, &target));
        if let Err(error) = copied {
            let _ = remove_tree(&partial);
            return Err(if error.kind() == io::ErrorKind::Interrupted {
                error.to_string()
            } else {
                format!("the backup copy failed: {error}")
            });
        }
        Ok(())
    }

    pub fn manual(&self, hold: &dyn ApiHold, cancel: &AtomicBool, log: &AppLog) -> Outcome {
        let name = format!("{MANUAL_PREFIX}{}", stamp(SystemTime::now()));
        if let Err(message) = self.prepare_dir() {
            return Outcome {
                result: Err(message),
                resume_failed: false,
            };
        }
        if !self.data_dir.is_dir() {
            return Outcome {
                result: Err(format!(
                    "there is no database to back up at {}",
                    self.data_dir.display()
                )),
                resume_failed: false,
            };
        }
        let held = hold.hold();
        let held_ok = held.is_ok();
        let copied = held.and_then(|()| {
            self.remove_partials(log);
            self.copy_into(&name, cancel)
        });
        let resumed = hold.resume();
        if held_ok && let Err(error) = &resumed {
            log.error(&format!(
                "the API could not be resumed after a backup: {error}"
            ));
        }
        let result = copied.map(|()| {
            self.prune(log);
            name
        });
        Outcome {
            result,
            resume_failed: held_ok && resumed.is_err(),
        }
    }

    pub fn pre_upgrade(
        &self,
        version: &str,
        cancel: &AtomicBool,
        log: &AppLog,
    ) -> Result<String, String> {
        self.prepare_dir()?;
        self.remove_partials(log);
        let name = format!("{PRE_UPGRADE_PREFIX}{version}-{}", stamp(SystemTime::now()));
        self.copy_into(&name, cancel)?;
        Ok(name)
    }

    fn prune(&self, log: &AppLog) {
        let mut manual: Vec<Entry> = self
            .entries()
            .into_iter()
            .filter(|entry| entry.kind == Kind::Manual && !entry.partial)
            .collect();
        manual.reverse();
        for stale in manual.into_iter().skip(KEEP_MANUAL) {
            match remove_tree(&self.backup_dir.join(&stale.name)) {
                Ok(()) => log.info(&format!("pruned backup {}", stale.name)),
                Err(error) => log.error(&format!(
                    "backup {} could not be pruned: {error}",
                    stale.name
                )),
            }
        }
    }
}
