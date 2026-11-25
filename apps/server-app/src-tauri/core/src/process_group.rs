use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

pub fn spawn_in_own_group(command: &mut Command) -> io::Result<Child> {
    command.process_group(0).spawn()
}

pub fn group_of(pid: u32) -> io::Result<i32> {
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(group)
    }
}

pub fn signal_group(group: i32, signal: i32) -> io::Result<()> {
    if unsafe { libc::killpg(group, signal) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn group_is_alive(group: i32) -> bool {
    unsafe { libc::killpg(group, 0) == 0 }
}
