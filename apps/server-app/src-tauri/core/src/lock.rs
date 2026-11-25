use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;

#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum Acquired {
    Held(InstanceLock),
    AlreadyRunning,
}

fn try_flock(file: &File) -> io::Result<bool> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::WouldBlock => return Ok(false),
            io::ErrorKind::Interrupted => continue,
            _ => return Err(error),
        }
    }
}

impl InstanceLock {
    pub fn acquire(lock_file: &Path) -> io::Result<Acquired> {
        if let Some(parent) = lock_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(lock_file)?;
        Ok(if try_flock(&file)? {
            Acquired::Held(InstanceLock { _file: file })
        } else {
            Acquired::AlreadyRunning
        })
    }
}

pub fn is_held(lock_file: &Path) -> io::Result<bool> {
    match File::open(lock_file) {
        Ok(file) => Ok(!try_flock(&file)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
