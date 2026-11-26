use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_board_server_core::activity::{Activity, Busy};
use agent_board_server_core::log_file::{AppLog, LogFile};

fn activity() -> (tempfile::TempDir, Activity, Arc<AtomicUsize>) {
    let dir = tempfile::tempdir().unwrap();
    let log = AppLog::new(LogFile::new(dir.path().join("app.log")));
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&changes);
    let activity = Activity::new(
        log,
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
    );
    (dir, activity, changes)
}

#[test]
fn server_app_013_a_recovery_or_a_backup_is_refused_while_anything_else_runs() {
    let (_dir, activity, _) = activity();
    let _enrolment = activity.begin(Busy::Enrolment).unwrap();

    assert_eq!(activity.begin(Busy::Recovery).err(), Some(Busy::Enrolment));
    assert_eq!(activity.begin(Busy::Backup).err(), Some(Busy::Enrolment));
    assert_eq!(activity.active(), [Busy::Enrolment]);
}

#[test]
fn server_app_013_an_enrolment_may_start_during_a_backup_but_not_during_a_recovery_or_quit() {
    let (_dir, activity, _) = activity();
    let backup = activity.begin(Busy::Backup).unwrap();
    let enrolment = activity.begin(Busy::Enrolment).unwrap();
    assert_eq!(activity.begin(Busy::Enrolment).err(), Some(Busy::Enrolment));
    drop(enrolment);
    drop(backup);

    let recovery = activity.begin(Busy::Recovery).unwrap();
    assert_eq!(activity.begin(Busy::Enrolment).err(), Some(Busy::Recovery));
    drop(recovery);

    activity.begin(Busy::Quit).unwrap().keep();
    assert_eq!(activity.begin(Busy::Enrolment).err(), Some(Busy::Quit));
}

#[test]
fn server_app_013_quit_is_never_refused_and_a_kept_ticket_holds_the_lock() {
    let (_dir, activity, _) = activity();
    let _backup = activity.begin(Busy::Backup).unwrap();
    activity.begin(Busy::Quit).unwrap().keep();

    assert_eq!(activity.active(), [Busy::Backup, Busy::Quit]);
}

#[test]
fn server_app_013_dropping_a_ticket_lifts_the_lock_and_reports_each_change() {
    let (_dir, activity, changes) = activity();
    let ticket = activity.begin(Busy::Recovery).unwrap();
    assert!(activity.is_busy());
    drop(ticket);

    assert!(!activity.is_busy());
    assert_eq!(changes.load(Ordering::SeqCst), 2);
}
