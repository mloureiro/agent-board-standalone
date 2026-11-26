use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths::AppPaths;

pub trait Opener: Send + Sync {
    fn open(&self, path: &Path) -> io::Result<()>;
}

pub const OPEN_PROGRAM: &str = "/usr/bin/open";

pub struct SystemOpener {
    program: PathBuf,
}

impl SystemOpener {
    pub fn new(program: Option<PathBuf>) -> SystemOpener {
        SystemOpener {
            program: program.unwrap_or_else(|| PathBuf::from(OPEN_PROGRAM)),
        }
    }
}

impl Opener for SystemOpener {
    fn open(&self, path: &Path) -> io::Result<()> {
        let status = Command::new(&self.program)
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| io::Error::other("open failed"))
    }
}

pub fn open_logs_folder(paths: &AppPaths, opener: &dyn Opener) -> io::Result<()> {
    fs::create_dir_all(paths.logs_dir())?;
    opener.open(&paths.logs_dir())
}

pub fn open_settings_file(paths: &AppPaths, opener: &dyn Opener) -> io::Result<()> {
    opener.open(&paths.settings_file())
}
