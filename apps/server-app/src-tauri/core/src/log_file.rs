use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use crate::redact::redact;
use crate::timestamp;

pub const ROTATE_AT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LogFile {
    path: PathBuf,
    limit: u64,
}

struct Exclusive {
    _file: File,
}

impl Exclusive {
    fn acquire(path: &Path) -> io::Result<Exclusive> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(Exclusive { _file: file });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

impl LogFile {
    pub fn new(path: PathBuf) -> LogFile {
        LogFile {
            path,
            limit: ROTATE_AT_BYTES,
        }
    }

    pub fn with_limit(path: PathBuf, limit: u64) -> LogFile {
        LogFile { path, limit }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn previous_generation(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(".1");
        PathBuf::from(name)
    }

    fn guard_path(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(".lock");
        PathBuf::from(name)
    }

    fn size(&self) -> u64 {
        fs::metadata(&self.path).map_or(0, |meta| meta.len())
    }

    fn rotate(&self) -> io::Result<()> {
        match fs::rename(&self.path, self.previous_generation()) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    fn locked(&self) -> io::Result<Exclusive> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        Exclusive::acquire(&self.guard_path())
    }

    pub fn rotate_if_full(&self) -> io::Result<()> {
        let _guard = self.locked()?;
        if self.size() >= self.limit {
            self.rotate()?;
        }
        Ok(())
    }

    pub fn append(&self, line: &str) -> io::Result<()> {
        let mut text = redact(line.trim_end_matches(['\r', '\n']));
        text.push('\n');
        let _guard = self.locked()?;
        let size = self.size();
        if size > 0 && size + text.len() as u64 > self.limit {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(text.as_bytes())
    }
}

#[derive(Debug, Clone)]
pub struct AppLog {
    file: LogFile,
}

impl AppLog {
    pub fn new(file: LogFile) -> AppLog {
        AppLog { file }
    }

    pub fn file(&self) -> &LogFile {
        &self.file
    }

    pub fn write(&self, level: Level, message: &str) {
        let single_line = message.replace('\r', "").replace('\n', "\\n");
        let line = format!("{} {} {single_line}", timestamp::now(), level.label());
        let _ = self.file.append(&line);
    }

    pub fn info(&self, message: &str) {
        self.write(Level::Info, message);
    }

    pub fn error(&self, message: &str) {
        self.write(Level::Error, message);
    }
}
