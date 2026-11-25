use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use crate::process_group::group_of;
use crate::stop::{Outcome, stop_orphan};

const CLOCK_SLACK: Duration = Duration::from_secs(2);

pub fn pid_file(run_dir: &Path, name: &str) -> PathBuf {
    run_dir.join(format!("{name}.pid"))
}

pub fn write_pid_file(run_dir: &Path, name: &str, pid: u32, program: &Path) {
    let _ = fs::create_dir_all(run_dir);
    let _ = fs::write(
        pid_file(run_dir, name),
        format!("{pid}\n{}\n", program.display()),
    );
}

pub fn remove_pid_file(run_dir: &Path, name: &str) {
    let _ = fs::remove_file(pid_file(run_dir, name));
}

fn ps(pid: u32, field: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", field])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
}

pub fn parse_elapsed(text: &str) -> Option<Duration> {
    let (days, clock) = match text.trim().split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
        None => (0, text.trim()),
    };
    let parts: Vec<u64> = clock
        .split(':')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    let seconds = match parts.as_slice() {
        [minutes, seconds] => minutes * 60 + seconds,
        [hours, minutes, seconds] => hours * 3600 + minutes * 60 + seconds,
        _ => return None,
    };
    Some(Duration::from_secs(days * 86_400 + seconds))
}

pub fn runs_program(command: &str, program: &str) -> bool {
    command
        .strip_prefix(program)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
}

fn started_before_pid_file(pid: u32, written: Option<SystemTime>) -> bool {
    let Some(age) = written.and_then(|time| time.elapsed().ok()) else {
        return false;
    };
    ps(pid, "etime=")
        .and_then(|text| parse_elapsed(&text))
        .is_some_and(|running| running + CLOCK_SLACK >= age)
}

fn is_our_orphan(pid: u32, program: &str, written: Option<SystemTime>) -> bool {
    pid > 1
        && pid != std::process::id()
        && ps(pid, "command=").is_some_and(|command| runs_program(&command, program))
        && group_of(pid).is_ok_and(|group| group == pid as i32)
        && started_before_pid_file(pid, written)
}

pub fn sweep(run_dir: &Path, grace: Duration, tick: Duration, log: &dyn Fn(&str)) {
    let Ok(entries) = fs::read_dir(run_dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "pid"))
        .collect();
    files.sort();
    for file in files {
        let written = fs::metadata(&file)
            .and_then(|metadata| metadata.modified())
            .ok();
        let text = fs::read_to_string(&file).unwrap_or_default();
        let _ = fs::remove_file(&file);
        let mut lines = text.lines();
        let (Some(pid), Some(program)) = (
            lines
                .next()
                .and_then(|line| line.trim().parse::<u32>().ok()),
            lines.next().map(str::trim).filter(|line| !line.is_empty()),
        ) else {
            continue;
        };
        if !is_our_orphan(pid, program, written) {
            log(&format!(
                "orphan sweep: pid {pid} is gone or is another process, left alone"
            ));
            continue;
        }
        let outcome = stop_orphan(pid as i32, grace, tick);
        let how = match outcome {
            Outcome::Graceful => "terminated",
            Outcome::Killed => "killed after the grace period",
        };
        log(&format!("orphan sweep: pid {pid} {how}"));
    }
}
