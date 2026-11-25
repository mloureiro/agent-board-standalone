use std::io;
use std::process::{Command, Stdio};

pub trait Launchctl: Send + Sync {
    fn bootout(&self, label: &str) -> io::Result<()>;
}

pub struct SystemLaunchctl;

impl Launchctl for SystemLaunchctl {
    fn bootout(&self, label: &str) -> io::Result<()> {
        let uid = unsafe { libc::getuid() };
        Command::new("/bin/launchctl")
            .args(["bootout", &format!("gui/{uid}/{label}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| ())
    }
}
