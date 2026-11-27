use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rumo_server_core::process_group::{group_is_alive, group_of, signal_group, spawn_in_own_group};

fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn server_app_029_a_child_is_its_own_process_group_and_the_group_is_killed_as_a_whole() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "sleep 300 & echo $!; wait"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn_in_own_group(&mut command).unwrap();

    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let grandchild: u32 = line.trim().parse().unwrap();

    let own = unsafe { libc::getpgrp() };
    let group = group_of(child.id()).unwrap();
    assert_eq!(group, child.id() as i32);
    assert_ne!(group, own);
    assert_eq!(group_of(grandchild).unwrap(), group);

    signal_group(group, libc::SIGTERM).unwrap();
    child.wait().unwrap();
    assert!(
        wait_until(|| !group_is_alive(group)),
        "the grandchild survived the group signal"
    );
}

#[test]
fn server_app_029_a_group_signal_does_not_reach_the_parent_group() {
    let mut command = Command::new("/bin/sleep");
    command.arg("300");
    let mut child = spawn_in_own_group(&mut command).unwrap();
    let group = group_of(child.id()).unwrap();

    signal_group(group, libc::SIGKILL).unwrap();
    child.wait().unwrap();
    assert!(group_is_alive(unsafe { libc::getpgrp() }));
}
