use std::process::Child;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::process_group::{group_is_alive, signal_group};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Graceful,
    Killed,
}

fn deadline_passed(started: Instant, grace: Duration) -> bool {
    started.elapsed() >= grace
}

pub fn stop_child(child: &mut Child, group: i32, grace: Duration, tick: Duration) -> Outcome {
    let _ = signal_group(group, libc::SIGTERM);
    let started = Instant::now();
    loop {
        let exited = !matches!(child.try_wait(), Ok(None));
        if exited && !group_is_alive(group) {
            return Outcome::Graceful;
        }
        if deadline_passed(started, grace) {
            break;
        }
        sleep(tick.min(Duration::from_millis(20)));
    }
    let _ = signal_group(group, libc::SIGKILL);
    let _ = child.wait();
    let reaped = Instant::now();
    while group_is_alive(group) && !deadline_passed(reaped, Duration::from_secs(2)) {
        sleep(Duration::from_millis(10));
    }
    Outcome::Killed
}

pub fn stop_orphan(group: i32, grace: Duration, tick: Duration) -> Outcome {
    let _ = signal_group(group, libc::SIGTERM);
    let started = Instant::now();
    while group_is_alive(group) {
        if deadline_passed(started, grace) {
            let _ = signal_group(group, libc::SIGKILL);
            let killed = Instant::now();
            while group_is_alive(group) && !deadline_passed(killed, Duration::from_secs(2)) {
                sleep(Duration::from_millis(10));
            }
            return Outcome::Killed;
        }
        sleep(tick.min(Duration::from_millis(20)));
    }
    Outcome::Graceful
}
