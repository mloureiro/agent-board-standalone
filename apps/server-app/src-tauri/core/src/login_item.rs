use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::launchctl::Launchctl;
use crate::paths::{IDENTIFIER, Root};

pub const LABEL: &str = IDENTIFIER;
pub const RELAUNCH_DELAY_SECONDS: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Build {
    Release,
    Debug,
}

impl Build {
    pub fn current() -> Build {
        if cfg!(debug_assertions) {
            Build::Debug
        } else {
            Build::Release
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Written,
    Unchanged,
    Removed,
    Untouched,
}

pub fn plist_path(launch_agents_dir: &Path) -> PathBuf {
    launch_agents_dir.join(format!("{LABEL}.plist"))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn plist(executable: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>{RELAUNCH_DELAY_SECONDS}</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#,
        escape(&executable.to_string_lossy())
    )
}

fn touches_login_item(root: &Root, build: Build) -> bool {
    build == Build::Release && root.is_default()
}

pub fn sync(
    root: &Root,
    build: Build,
    start_at_login: bool,
    launch_agents_dir: &Path,
    executable: &Path,
) -> io::Result<Outcome> {
    if !touches_login_item(root, build) {
        return Ok(Outcome::Untouched);
    }
    let file = plist_path(launch_agents_dir);
    if start_at_login {
        let wanted = plist(executable);
        if fs::read_to_string(&file).is_ok_and(|current| current == wanted) {
            return Ok(Outcome::Unchanged);
        }
        fs::create_dir_all(launch_agents_dir)?;
        let temporary = file.with_extension("plist.partial");
        fs::write(&temporary, wanted)?;
        fs::rename(&temporary, &file)?;
        return Ok(Outcome::Written);
    }
    match fs::remove_file(&file) {
        Ok(()) => Ok(Outcome::Removed),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Outcome::Unchanged),
        Err(error) => Err(error),
    }
}

pub fn remove(
    root: &Root,
    launch_agents_dir: &Path,
    launchctl: &dyn Launchctl,
) -> io::Result<Outcome> {
    if !root.is_default() {
        return Ok(Outcome::Untouched);
    }
    let _ = launchctl.bootout(LABEL);
    match fs::remove_file(plist_path(launch_agents_dir)) {
        Ok(()) => Ok(Outcome::Removed),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Outcome::Unchanged),
        Err(error) => Err(error),
    }
}
