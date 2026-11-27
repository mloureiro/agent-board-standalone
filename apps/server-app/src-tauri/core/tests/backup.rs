use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rumo_server_core::backup::{
    ApiHold, Backups, KEEP_MANUAL, Kind, check_backup_dir, copy_tree, parse_entry, stamp_to_iso,
};
use rumo_server_core::log_file::{AppLog, LogFile};
use tempfile::TempDir;

struct Bed {
    dir: TempDir,
    log: AppLog,
}

impl Bed {
    fn new() -> Bed {
        let dir = tempfile::tempdir().unwrap();
        let log = AppLog::new(LogFile::new(dir.path().join("app.log")));
        let bed = Bed { dir, log };
        fs::create_dir_all(bed.data().join("base")).unwrap();
        fs::write(bed.data().join("PG_VERSION"), "17").unwrap();
        fs::write(bed.data().join("base/1"), vec![7u8; 3 * 1024 * 1024]).unwrap();
        bed
    }

    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn backup_dir(&self) -> PathBuf {
        self.dir.path().join("backups")
    }

    fn backups(&self) -> Backups {
        Backups::new(self.backup_dir(), self.data())
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.backup_dir())
            .map(|listing| {
                listing
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn log_text(&self) -> String {
        fs::read_to_string(self.dir.path().join("app.log")).unwrap_or_default()
    }
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
    on_hold: Option<Box<dyn Fn() + Send + Sync>>,
    fail_hold: bool,
    fail_resume: bool,
}

impl Recorder {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ApiHold for Recorder {
    fn hold(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("hold".into());
        if self.fail_hold {
            return Err("the control channel refused".into());
        }
        if let Some(action) = &self.on_hold {
            action();
        }
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("resume".into());
        if self.fail_resume {
            return Err("the control channel is gone".into());
        }
        Ok(())
    }
}

fn never() -> AtomicBool {
    AtomicBool::new(false)
}

fn tree(path: &Path) -> Vec<(String, u64)> {
    fn walk(base: &Path, at: &Path, found: &mut Vec<(String, u64)>) {
        for entry in fs::read_dir(at).unwrap().flatten() {
            let meta = entry.metadata().unwrap();
            let relative = entry
                .path()
                .strip_prefix(base)
                .unwrap()
                .display()
                .to_string();
            if meta.is_dir() {
                walk(base, &entry.path(), found);
            } else {
                found.push((relative, meta.len()));
            }
        }
    }
    let mut found = Vec::new();
    walk(path, path, &mut found);
    found.sort();
    found
}

fn fake_backups(bed: &Bed, names: &[&str]) {
    for name in names {
        let dir = bed.backup_dir().join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("PG_VERSION"), "17").unwrap();
    }
}

#[test]
fn server_app_035_a_manual_backup_holds_copies_renames_and_resumes() {
    let bed = Bed::new();
    let seen = bed.backup_dir();
    let hold = Recorder {
        on_hold: Some(Box::new(move || {
            assert!(
                fs::read_dir(&seen).is_ok_and(|mut listing| listing.next().is_none()),
                "nothing is copied before the hold"
            );
        })),
        ..Recorder::default()
    };

    let outcome = bed.backups().manual(&hold, &never(), &bed.log);

    let name = outcome.result.unwrap();
    assert!(name.starts_with("manual-"));
    assert_eq!(hold.calls(), ["hold", "resume"]);
    assert!(!outcome.resume_failed);
    assert_eq!(bed.names(), std::slice::from_ref(&name));
    assert_eq!(tree(&bed.backup_dir().join(&name)), tree(&bed.data()));
    let shown = bed.backups().last_manual().unwrap();
    assert_eq!(
        Some(shown),
        stamp_to_iso(name.strip_prefix("manual-").unwrap())
    );
}

#[test]
fn server_app_035_a_failed_copy_still_resumes_the_api_and_leaves_no_partial() {
    let bed = Bed::new();
    let cancel = AtomicBool::new(true);
    let hold = Recorder::default();

    let outcome = bed.backups().manual(&hold, &cancel, &bed.log);

    assert!(outcome.result.is_err());
    assert_eq!(hold.calls(), ["hold", "resume"]);
    assert!(bed.names().is_empty());
    assert_eq!(bed.backups().last_manual(), None);
}

#[test]
fn server_app_035_a_refused_hold_fails_the_backup_and_leaves_partials_alone() {
    let bed = Bed::new();
    let in_flight = "pre-upgrade-schema-1-20990101T000000000Z.partial";
    fake_backups(&bed, &[in_flight]);
    let hold = Recorder {
        fail_hold: true,
        fail_resume: true,
        ..Recorder::default()
    };

    let outcome = bed.backups().manual(&hold, &never(), &bed.log);

    assert_eq!(outcome.result, Err("the control channel refused".into()));
    assert!(!outcome.resume_failed);
    assert_eq!(hold.calls(), ["hold", "resume"]);
    assert_eq!(bed.names(), [in_flight]);
}

#[test]
fn server_app_035_a_resume_that_fails_is_reported_so_the_server_can_be_restarted() {
    let bed = Bed::new();
    let hold = Recorder {
        fail_resume: true,
        ..Recorder::default()
    };

    let outcome = bed.backups().manual(&hold, &never(), &bed.log);

    assert!(outcome.result.is_ok());
    assert!(outcome.resume_failed);
    assert!(
        bed.log_text()
            .contains("the API could not be resumed after a backup")
    );
}

#[test]
fn server_app_035_a_missing_database_is_refused_before_the_api_is_held() {
    let bed = Bed::new();
    fs::remove_dir_all(bed.data()).unwrap();
    let hold = Recorder::default();

    let outcome = bed.backups().manual(&hold, &never(), &bed.log);

    assert!(outcome.result.unwrap_err().contains("no database"));
    assert!(hold.calls().is_empty());
}

#[test]
fn server_app_036_the_five_newest_manual_backups_are_kept_and_pre_upgrade_ones_never_pruned() {
    let bed = Bed::new();
    let manual: Vec<String> = (1..=7)
        .map(|day| format!("manual-2020010{day}T000000000Z"))
        .collect();
    let pre_upgrade = [
        "pre-upgrade-schema-1-20190101T000000000Z",
        "pre-upgrade-schema-2-20180101T000000000Z",
    ];
    fake_backups(&bed, &manual.iter().map(String::as_str).collect::<Vec<_>>());
    fake_backups(&bed, &pre_upgrade);

    let outcome = bed
        .backups()
        .manual(&Recorder::default(), &never(), &bed.log);
    let newest = outcome.result.unwrap();

    let names = bed.names();
    let kept_manual: Vec<&String> = names
        .iter()
        .filter(|name| name.starts_with("manual-"))
        .collect();
    assert_eq!(kept_manual.len(), KEEP_MANUAL);
    assert!(names.contains(&newest));
    for expected in &manual[3..] {
        assert!(names.contains(expected), "{expected} is among the newest");
    }
    for removed in &manual[..3] {
        assert!(!names.contains(removed), "{removed} is pruned");
    }
    for kept in pre_upgrade {
        assert!(names.contains(&kept.to_string()), "{kept} is never pruned");
    }
}

#[test]
fn server_app_036_a_failed_prune_is_logged_and_does_not_fail_the_backup() {
    use std::os::unix::fs::PermissionsExt;
    let bed = Bed::new();
    let old: Vec<String> = (1..=5)
        .map(|day| format!("manual-2020010{day}T000000000Z"))
        .collect();
    fake_backups(&bed, &old.iter().map(String::as_str).collect::<Vec<_>>());
    let locked = bed.backup_dir().join(&old[0]).join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::write(locked.join("file"), "x").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();

    let outcome = bed
        .backups()
        .manual(&Recorder::default(), &never(), &bed.log);

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(outcome.result.is_ok());
    assert!(bed.names().contains(&old[0]));
    assert!(
        bed.log_text()
            .contains(&format!("backup {} could not be pruned", old[0]))
    );
}

#[test]
fn server_app_037_a_partial_is_never_the_last_backup_and_the_next_manual_backup_removes_it() {
    let bed = Bed::new();
    fake_backups(
        &bed,
        &[
            "manual-20200101T000000000Z",
            "manual-20990101T000000000Z.partial",
            "pre-upgrade-schema-1-20990101T000000000Z.partial",
        ],
    );
    assert_eq!(
        bed.backups().last_manual().as_deref(),
        Some("2020-01-01T00:00:00.000Z")
    );

    let outcome = bed
        .backups()
        .manual(&Recorder::default(), &never(), &bed.log);
    outcome.result.unwrap();

    assert!(bed.names().iter().all(|name| !name.ends_with(".partial")));
    assert_ne!(
        bed.backups().last_manual().as_deref(),
        Some("2099-01-01T00:00:00.000Z")
    );
}

#[test]
fn server_app_037_backup_names_tell_manual_from_pre_upgrade_and_partials() {
    let kind = |name: &str| parse_entry(name).map(|entry| (entry.kind, entry.partial));
    assert_eq!(
        kind("manual-20200101T000000000Z"),
        Some((Kind::Manual, false))
    );
    assert_eq!(
        kind("manual-20200101T000000000Z.partial"),
        Some((Kind::Manual, true))
    );
    assert_eq!(
        kind("pre-upgrade-0004_relax-20200101T000000000Z"),
        Some((Kind::PreUpgrade, false))
    );
    assert_eq!(kind("manual-yesterday"), None);
    assert_eq!(kind("notes.txt"), None);
    assert_eq!(kind("pre-upgrade-20200101T000000000Z"), None);
}

#[test]
fn server_app_038_a_cancelled_copy_stops_at_once_and_removes_its_partial() {
    let bed = Bed::new();
    for index in 0..40 {
        fs::write(
            bed.data().join(format!("base/file-{index}")),
            vec![1u8; 2 * 1024 * 1024],
        )
        .unwrap();
    }
    let cancel = AtomicBool::new(false);
    let target = bed.dir.path().join("copy");

    let started = Instant::now();
    let result = std::thread::scope(|scope| {
        let worker = scope.spawn(|| copy_tree(&bed.data(), &target, &cancel));
        while !target.exists() {
            std::thread::sleep(Duration::from_millis(1));
        }
        cancel.store(true, Ordering::SeqCst);
        worker.join().unwrap()
    });

    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(tree(&target).len() < tree(&bed.data()).len());
}

#[test]
fn server_app_038_a_backup_cancelled_during_the_hold_resumes_and_leaves_nothing_behind() {
    let bed = Bed::new();
    let cancel = Arc::new(AtomicBool::new(false));
    let hold = Recorder {
        on_hold: Some(Box::new({
            let cancel = Arc::clone(&cancel);
            move || cancel.store(true, Ordering::SeqCst)
        })),
        ..Recorder::default()
    };

    let outcome = bed.backups().manual(&hold, &cancel, &bed.log);

    assert_eq!(outcome.result, Err("the backup was cancelled".into()));
    assert_eq!(hold.calls(), ["hold", "resume"]);
    assert!(bed.names().is_empty());
}

#[test]
fn server_app_039_a_backup_restores_to_the_same_files() {
    let bed = Bed::new();
    let name = bed
        .backups()
        .manual(&Recorder::default(), &never(), &bed.log)
        .result
        .unwrap();
    let before = tree(&bed.data());
    fs::write(bed.data().join("added-after"), "card").unwrap();
    fs::write(bed.data().join("base/1"), "changed").unwrap();

    let aside = bed.dir.path().join("data.aside");
    fs::rename(bed.data(), &aside).unwrap();
    copy_tree(&bed.backup_dir().join(name), &bed.data(), &never()).unwrap();

    assert_eq!(tree(&bed.data()), before);
    assert!(!bed.data().join("added-after").exists());
}

#[test]
fn server_app_040_the_backup_directory_must_be_absolute_without_dotdot_and_outside_the_data_dir() {
    let bed = Bed::new();
    let data = bed.data();
    let elsewhere = bed.dir.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();

    assert!(check_backup_dir(&elsewhere, &data).is_ok());
    assert!(check_backup_dir(&elsewhere.join("not/yet/there"), &data).is_ok());
    assert!(check_backup_dir(Path::new("relative/backups"), &data).is_err());
    assert!(check_backup_dir(Path::new(""), &data).is_err());
    assert!(check_backup_dir(&elsewhere.join("../elsewhere"), &data).is_err());
    assert!(check_backup_dir(&data, &data).is_err());
    assert!(check_backup_dir(&data.join("base"), &data).is_err());
    assert!(check_backup_dir(&data.join("backups/deeper"), &data).is_err());
}

#[test]
fn server_app_040_a_symlink_into_the_data_dir_is_caught_by_identity() {
    let bed = Bed::new();
    let data = bed.data();
    let link = bed.dir.path().join("link-to-data");
    symlink(&data, &link).unwrap();
    let nested = bed.dir.path().join("link-to-base");
    symlink(data.join("base"), &nested).unwrap();
    let moved_data = bed.dir.path().join("alias");
    symlink(&data, &moved_data).unwrap();

    assert!(check_backup_dir(&link, &data).is_err());
    assert!(check_backup_dir(&link.join("new"), &data).is_err());
    assert!(check_backup_dir(&nested, &data).is_err());
    assert!(check_backup_dir(&bed.dir.path().join("elsewhere"), &moved_data).is_ok());
    assert!(check_backup_dir(&data.join("base"), &moved_data).is_err());
}

#[test]
fn server_app_040_the_directory_is_checked_again_before_the_copy() {
    let bed = Bed::new();
    let backup_dir = bed.backup_dir();
    let data = bed.data();
    let hold = Recorder {
        on_hold: Some(Box::new(move || {
            fs::remove_dir_all(&backup_dir).unwrap();
            symlink(&data, &backup_dir).unwrap();
        })),
        ..Recorder::default()
    };

    let outcome = bed.backups().manual(&hold, &never(), &bed.log);

    assert!(outcome.result.unwrap_err().contains("must not be inside"));
    assert_eq!(hold.calls(), ["hold", "resume"]);
    assert!(
        fs::read_dir(bed.data())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains("manual-"))
    );
}

#[test]
fn server_app_040_a_backup_dir_inside_the_data_dir_refuses_the_backup() {
    let bed = Bed::new();
    let inside = Backups::new(bed.data().join("backups"), bed.data());
    let hold = Recorder::default();

    let outcome = inside.manual(&hold, &never(), &bed.log);

    assert!(outcome.result.is_err());
    assert!(hold.calls().is_empty());
    assert!(!bed.data().join("backups").exists());
}
