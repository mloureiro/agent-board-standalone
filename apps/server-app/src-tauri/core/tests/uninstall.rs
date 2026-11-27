mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use common::{Bed, RecordingLaunchctl, exists};
use rumo_server_core::cli::{Invocation, parse};
use rumo_server_core::credentials::{ACCOUNTS, CredentialStore, FileStore, WORKER_TOKEN};
use rumo_server_core::lock::{Acquired, InstanceLock};
use rumo_server_core::login_item::{self, Build, LABEL, plist_path};
use rumo_server_core::paths::Root;
use rumo_server_core::uninstall::{
    Environment, QUIT_FIRST, RootState, covers_home, inspect_root, run,
};

struct Outcome {
    code: i32,
    text: String,
}

fn uninstall(
    bed: &Bed,
    root: &Root,
    store: &FileStore,
    delete_data: bool,
) -> (Outcome, RecordingLaunchctl) {
    let launchctl = RecordingLaunchctl::default();
    let environment = Environment {
        root,
        home: Some(&bed.home),
        login_name: "Ines",
        launch_agents_dir: &bed.agents,
        launchctl: &launchctl,
        store,
    };
    let mut out = Vec::new();
    let code = run(&environment, delete_data, &mut out);
    (
        Outcome {
            code,
            text: String::from_utf8(out).unwrap(),
        },
        launchctl,
    )
}

fn fill_store(store: &FileStore, root: &Root) {
    for account in ACCOUNTS {
        store
            .set(&root.keychain_service(), account, "secret")
            .unwrap();
    }
}

fn store_is_empty_for(store: &FileStore, root: &Root) -> bool {
    ACCOUNTS.iter().all(|account| {
        store
            .get(&root.keychain_service(), account)
            .unwrap()
            .is_none()
    })
}

#[test]
fn server_app_064_uninstall_removes_the_login_item_and_every_keychain_item_and_keeps_the_data() {
    let bed = Bed::new();
    let root = bed.default_root();
    bed.app_folder(&root);
    let store = bed.store();
    fill_store(&store, &root);
    store
        .set(
            "dev.mloureiro.rumo-server.root:/elsewhere",
            WORKER_TOKEN,
            "keep",
        )
        .unwrap();
    login_item::sync(
        &root,
        Build::Release,
        true,
        &bed.agents,
        Path::new("/x/board"),
    )
    .unwrap();

    let (outcome, launchctl) = uninstall(&bed, &root, &store, false);

    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(store_is_empty_for(&store, &root));
    assert_eq!(
        store
            .get("dev.mloureiro.rumo-server.root:/elsewhere", WORKER_TOKEN)
            .unwrap()
            .as_deref(),
        Some("keep")
    );
    assert!(!exists(&plist_path(&bed.agents)));
    assert_eq!(launchctl.calls(), [LABEL]);
    assert!(root.path().join("data/pglite/file").is_file());
    assert!(root.path().join("settings.json").is_file());
}

#[test]
fn server_app_064_a_non_default_root_keeps_the_login_item_and_clears_only_its_own_keychain_items() {
    let bed = Bed::new();
    let default = bed.default_root();
    let custom = bed.custom_root("other-root");
    bed.app_folder(&custom);
    let store = bed.store();
    fill_store(&store, &default);
    fill_store(&store, &custom);
    login_item::sync(
        &default,
        Build::Release,
        true,
        &bed.agents,
        Path::new("/x/board"),
    )
    .unwrap();

    let (outcome, launchctl) = uninstall(&bed, &custom, &store, false);

    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(outcome.text.contains("login item left alone"));
    assert!(store_is_empty_for(&store, &custom));
    assert!(!store_is_empty_for(&store, &default));
    assert!(exists(&plist_path(&bed.agents)));
    assert!(launchctl.calls().is_empty());
}

#[test]
fn server_app_064_uninstall_succeeds_when_there_is_nothing_to_remove() {
    let bed = Bed::new();
    let root = bed.custom_root("never-started");
    let (outcome, _) = uninstall(&bed, &root, &bed.store(), false);
    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(!exists(root.path()));
}

#[test]
fn server_app_065_delete_data_removes_the_app_folder() {
    let bed = Bed::new();
    let root = bed.custom_root("board-root");
    bed.app_folder(&root);
    fs::create_dir_all(root.path().join("logs")).unwrap();
    fs::write(root.path().join("logs/app.log"), "line").unwrap();
    let store = bed.store();
    fill_store(&store, &root);

    let (outcome, _) = uninstall(&bed, &root, &store, true);

    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(!exists(root.path()));
    assert!(store_is_empty_for(&store, &root));
    assert!(bed.home.is_dir());
}

#[test]
fn server_app_065_a_data_or_backup_directory_outside_the_root_is_printed_and_left() {
    let bed = Bed::new();
    let root = bed.custom_root("board-root");
    let data = bed.dir.path().join("elsewhere/data");
    let backups = bed.dir.path().join("elsewhere/backups");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&backups).unwrap();
    fs::write(data.join("row"), "x").unwrap();
    fs::write(backups.join("copy"), "x").unwrap();
    fs::create_dir_all(root.path()).unwrap();
    fs::write(
        root.path().join("settings.json"),
        format!(r#"{{"dataDir":{:?},"backupDir":{:?}}}"#, data, backups),
    )
    .unwrap();

    let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);

    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(
        outcome
            .text
            .contains(&format!("dataDir {}", data.display())),
        "{}",
        outcome.text
    );
    assert!(
        outcome
            .text
            .contains(&format!("backupDir {}", backups.display())),
        "{}",
        outcome.text
    );
    assert!(!exists(root.path()));
    assert!(data.join("row").is_file());
    assert!(backups.join("copy").is_file());
}

#[test]
fn server_app_065_a_data_directory_that_links_out_of_the_root_is_unlinked_and_its_target_left() {
    let bed = Bed::new();
    let root = bed.custom_root("board-root");
    bed.app_folder(&root);
    let target = bed.dir.path().join("target");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("row"), "x").unwrap();
    fs::remove_dir_all(root.path().join("data")).unwrap();
    symlink(&target, root.path().join("data")).unwrap();

    let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);

    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(outcome.text.contains("dataDir"), "{}", outcome.text);
    assert!(!exists(root.path()));
    assert!(target.join("row").is_file());
}

#[test]
fn server_app_065_an_unreadable_settings_file_does_not_stop_the_removal_but_is_reported() {
    let bed = Bed::new();
    let root = bed.custom_root("board-root");
    bed.app_folder(&root);
    fs::write(root.path().join("settings.json"), "{ nope").unwrap();
    let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);
    assert_eq!(outcome.code, 0, "{}", outcome.text);
    assert!(
        outcome.text.contains("were not checked"),
        "{}",
        outcome.text
    );
    assert!(!exists(root.path()));
}

#[test]
fn server_app_065_a_symlinked_root_is_refused_and_both_link_and_target_survive() {
    let bed = Bed::new();
    let real = bed.custom_root("real-root");
    bed.app_folder(&real);
    let link_path = bed.dir.path().join("linked-root");
    symlink(real.path(), &link_path).unwrap();
    let linked = Root::resolve(Some(link_path.as_os_str()), &bed.home).unwrap();

    let (outcome, _) = uninstall(&bed, &linked, &bed.store(), true);

    assert!(outcome.text.contains("is a symlink"), "{}", outcome.text);
    assert!(exists(&link_path));
    assert!(real.path().join("data/pglite/file").is_file());
    assert!(!exists(&real.path().join("app.lock")));
}

#[test]
fn server_app_065_a_root_with_a_parent_component_is_refused() {
    let bed = Bed::new();
    let real = bed.custom_root("real-root");
    bed.app_folder(&real);
    let tricky = bed.dir.path().join("other/../real-root");
    fs::create_dir_all(bed.dir.path().join("other")).unwrap();
    let root = Root::resolve(Some(tricky.as_os_str()), &bed.home).unwrap();

    let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);

    assert!(outcome.text.contains(".. component"), "{}", outcome.text);
    assert!(real.path().join("data/pglite/file").is_file());
    assert!(!exists(&real.path().join("app.lock")));
}

#[test]
fn server_app_065_a_folder_without_a_regular_file_settings_json_is_refused() {
    let bed = Bed::new();
    let bare = bed.custom_root("bare");
    fs::create_dir_all(bare.path()).unwrap();
    fs::write(bare.path().join("precious"), "x").unwrap();
    let as_dir = bed.custom_root("settings-dir");
    fs::create_dir_all(as_dir.path().join("settings.json")).unwrap();
    let as_link = bed.custom_root("settings-link");
    fs::create_dir_all(as_link.path()).unwrap();
    fs::write(bed.dir.path().join("real-settings.json"), "{}").unwrap();
    symlink(
        bed.dir.path().join("real-settings.json"),
        as_link.path().join("settings.json"),
    )
    .unwrap();

    for root in [&bare, &as_dir, &as_link] {
        let (outcome, _) = uninstall(&bed, root, &bed.store(), true);
        assert!(
            outcome.text.contains("no regular-file settings.json"),
            "{}",
            outcome.text
        );
        assert!(exists(root.path()), "{}", root.path().display());
        assert!(!exists(&root.path().join("app.lock")));
    }
    assert!(bare.path().join("precious").is_file());
}

#[test]
fn server_app_065_the_home_folder_and_anything_above_it_are_refused() {
    let bed = Bed::new();
    fs::write(bed.home.join("settings.json"), "{}").unwrap();
    fs::write(bed.dir.path().join("settings.json"), "{}").unwrap();
    fs::write(bed.home.join("keep.txt"), "x").unwrap();

    for path in [bed.home.clone(), bed.dir.path().to_path_buf()] {
        let root = Root::resolve(Some(path.as_os_str()), &bed.home).unwrap();
        let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);
        assert!(outcome.text.contains("home folder"), "{}", outcome.text);
        assert!(bed.home.join("keep.txt").is_file());
        assert!(!exists(&path.join("app.lock")));
    }
}

#[test]
fn server_app_065_a_symlink_to_the_home_folder_is_refused() {
    let bed = Bed::new();
    fs::write(bed.home.join("settings.json"), "{}").unwrap();
    let link = bed.dir.path().join("looks-harmless");
    symlink(&bed.home, &link).unwrap();
    let root = Root::resolve(Some(link.as_os_str()), &bed.home).unwrap();
    let (outcome, _) = uninstall(&bed, &root, &bed.store(), true);
    assert!(outcome.text.contains("symlink"), "{}", outcome.text);
    assert!(bed.home.join("settings.json").is_file());
}

#[test]
fn server_app_065_a_folder_inside_home_is_accepted_and_the_default_root_sits_there() {
    let bed = Bed::new();
    let root = bed.default_root();
    bed.app_folder(&root);
    assert_eq!(
        inspect_root(root.path(), Some(&bed.home)),
        RootState::Accepted
    );
    assert!(!covers_home(root.path(), &bed.home));
}

#[cfg(target_os = "macos")]
#[test]
fn server_app_065_the_firmlinked_alias_of_a_folder_that_holds_home_is_refused() {
    let Some(home) =
        rumo_server_core::account::home_dir().filter(|home| home.starts_with("/Users"))
    else {
        return;
    };
    let data_volume = Path::new("/System/Volumes/Data");
    assert!(covers_home(data_volume, &home));
    assert!(covers_home(Path::new("/System/Volumes/Data/Users"), &home));
    assert!(covers_home(Path::new("/Users"), &home));
    assert!(covers_home(&home, &home));
    assert!(covers_home(Path::new("/"), &home));
    assert!(!covers_home(&home.join("Library"), &home));
    assert!(matches!(
        inspect_root(data_volume, Some(&home)),
        RootState::Refused(_)
    ));
}

#[test]
fn server_app_066_uninstall_while_the_app_runs_says_to_quit_first_and_changes_nothing() {
    let bed = Bed::new();
    let root = bed.custom_root("board-root");
    bed.app_folder(&root);
    let store = bed.store();
    fill_store(&store, &root);
    let Acquired::Held(running) = InstanceLock::acquire(&root.paths().lock_file()).unwrap() else {
        panic!("the lock must be free")
    };

    for delete_data in [false, true] {
        let (outcome, launchctl) = uninstall(&bed, &root, &store, delete_data);
        assert_eq!(outcome.code, 1);
        assert!(outcome.text.contains(QUIT_FIRST), "{}", outcome.text);
        assert!(!store_is_empty_for(&store, &root));
        assert!(root.path().join("data/pglite/file").is_file());
        assert!(launchctl.calls().is_empty());
    }
    drop(running);

    let (outcome, _) = uninstall(&bed, &root, &store, true);
    assert_eq!(outcome.code, 0, "{}", outcome.text);
}

#[test]
fn server_app_066_the_lock_is_taken_only_in_a_root_that_uninstall_accepts() {
    let bed = Bed::new();
    let missing = bed.custom_root("missing");
    uninstall(&bed, &missing, &bed.store(), false);
    assert!(!exists(missing.path()));

    let bare = bed.custom_root("bare");
    fs::create_dir_all(bare.path()).unwrap();
    uninstall(&bed, &bare, &bed.store(), false);
    assert!(!exists(&bare.paths().lock_file()));

    let accepted = bed.custom_root("accepted");
    bed.app_folder(&accepted);
    uninstall(&bed, &accepted, &bed.store(), false);
    assert!(exists(&accepted.paths().lock_file()));
}

#[test]
fn server_app_066_any_argument_other_than_the_known_ones_is_a_usage_error() {
    let parse_args = |args: &[&str]| parse(args.iter().map(std::ffi::OsString::from));
    assert_eq!(parse_args(&[]), Invocation::Tray);
    assert_eq!(parse_args(&["--headless"]), Invocation::Headless);
    assert_eq!(
        parse_args(&["--uninstall"]),
        Invocation::Uninstall { delete_data: false }
    );
    assert_eq!(
        parse_args(&["--uninstall", "--delete-data"]),
        Invocation::Uninstall { delete_data: true }
    );
    for bad in [
        &["--delete-data"][..],
        &["--delete-data", "--uninstall"],
        &["--uninstall", "--delete-data", "--force"],
        &["--uninstall", "extra"],
        &["--headless", "--uninstall"],
        &["--headless", "now"],
        &["--version"],
        &["board"],
    ] {
        assert_eq!(parse_args(bad), Invocation::Usage, "{bad:?}");
    }
}
