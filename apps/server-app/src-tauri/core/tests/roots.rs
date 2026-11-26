use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agent_board_server_core::credentials::{
    ACCOUNTS, CredentialStore, FileStore, PENDING_WORKER_DATA_KEY, PENDING_WORKER_TOKEN,
    WORKER_DATA_KEY, WORKER_TOKEN,
};
use agent_board_server_core::lock::{Acquired, InstanceLock, is_held};
use agent_board_server_core::opener::{Opener, open_logs_folder, open_settings_file};
use agent_board_server_core::overrides::{
    CREDENTIAL_STORE_ENV, E2E_ENV, LAUNCH_AGENTS_ENV, Overrides,
};
use agent_board_server_core::paths::{AppPaths, IDENTIFIER, ROOT_ENV, Root};

fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.to_string())
    }
}

#[test]
fn server_app_069_without_the_variable_the_root_is_the_default_folder() {
    let root = Root::resolve(None, Path::new("/var/folders/ines")).unwrap();
    assert!(root.is_default());
    assert_eq!(
        root.path(),
        Path::new("/var/folders/ines/Library/Application Support/Agent Board Server")
    );
    assert_eq!(root.keychain_service(), IDENTIFIER);
    assert_eq!(IDENTIFIER, "dev.mloureiro.agent-board-server");
    let empty = Root::resolve(Some(OsStr::new("")), Path::new("/var/folders/ines")).unwrap();
    assert!(empty.is_default());
}

#[test]
fn server_app_069_the_variable_moves_the_whole_root_and_gives_it_its_own_keychain_service() {
    assert_eq!(ROOT_ENV, "AGENT_BOARD_SERVER_ROOT");
    let root = Root::resolve(
        Some(OsStr::new("/tmp/board-a/")),
        Path::new("/var/folders/ines"),
    )
    .unwrap();
    assert!(!root.is_default());
    assert_eq!(root.path(), Path::new("/tmp/board-a"));
    assert_eq!(
        root.paths().settings_file(),
        Path::new("/tmp/board-a/settings.json")
    );
    assert_eq!(
        root.paths().app_log(),
        Path::new("/tmp/board-a/logs/app.log")
    );
    assert_eq!(root.paths().lock_file(), Path::new("/tmp/board-a/app.lock"));
    assert_eq!(
        root.keychain_service(),
        format!("{IDENTIFIER}.root:/tmp/board-a")
    );

    let other = Root::resolve(
        Some(OsStr::new("/tmp/board-b")),
        Path::new("/var/folders/ines"),
    )
    .unwrap();
    assert_ne!(root.keychain_service(), other.keychain_service());
}

#[test]
fn server_app_069_a_relative_root_is_refused() {
    let error =
        Root::resolve(Some(OsStr::new("board")), Path::new("/var/folders/ines")).unwrap_err();
    assert!(error.to_string().contains(ROOT_ENV));
}

#[test]
fn server_app_054_the_default_root_uses_the_bare_service_name_and_any_other_a_suffixed_one() {
    let home = Path::new("/var/folders/ines");
    let default_path = "/var/folders/ines/Library/Application Support/Agent Board Server";
    let same = Root::resolve(Some(OsStr::new(default_path)), home).unwrap();
    assert_eq!(same.keychain_service(), IDENTIFIER);
    let other = Root::resolve(Some(OsStr::new("/Volumes/x/board")), home).unwrap();
    assert_eq!(
        other.keychain_service(),
        format!("{IDENTIFIER}.root:/Volumes/x/board")
    );
}

#[test]
fn server_app_054_the_accounts_are_the_worker_token_the_data_key_and_their_pending_pair() {
    assert_eq!(WORKER_TOKEN, "worker-token");
    assert_eq!(WORKER_DATA_KEY, "worker-data-key");
    assert_eq!(
        ACCOUNTS,
        [
            WORKER_TOKEN,
            WORKER_DATA_KEY,
            PENDING_WORKER_TOKEN,
            PENDING_WORKER_DATA_KEY
        ]
    );
}

#[test]
fn server_app_069_overrides_are_honoured_in_a_debug_build_and_in_a_release_build_only_for_e2e() {
    let pairs = [
        (CREDENTIAL_STORE_ENV, "file:/tmp/creds.json"),
        (LAUNCH_AGENTS_ENV, "/tmp/agents"),
    ];
    let debug = Overrides::from_env(false, &env_of(&pairs));
    assert_eq!(
        debug.credential_store_file.as_deref(),
        Some(Path::new("/tmp/creds.json"))
    );
    assert_eq!(
        debug.launch_agents_dir.as_deref(),
        Some(Path::new("/tmp/agents"))
    );

    assert_eq!(
        Overrides::from_env(true, &env_of(&pairs)),
        Overrides::default()
    );

    let e2e = [pairs[0], pairs[1], (E2E_ENV, "1")];
    assert_eq!(Overrides::from_env(true, &env_of(&e2e)), debug);

    let not_one = [pairs[0], (E2E_ENV, "true")];
    assert_eq!(
        Overrides::from_env(true, &env_of(&not_one)),
        Overrides::default()
    );

    let relative = [
        (CREDENTIAL_STORE_ENV, "file:creds.json"),
        (LAUNCH_AGENTS_ENV, "agents"),
    ];
    assert_eq!(
        Overrides::from_env(false, &env_of(&relative)),
        Overrides::default()
    );
}

#[test]
fn server_app_031_a_second_lock_on_the_same_root_reports_the_app_is_running() {
    let dir = tempfile::tempdir().unwrap();
    let file = AppPaths::new(dir.path()).lock_file();

    let first = InstanceLock::acquire(&file).unwrap();
    let Acquired::Held(held) = first else {
        panic!("the first lock must be held")
    };
    assert!(matches!(
        InstanceLock::acquire(&file).unwrap(),
        Acquired::AlreadyRunning
    ));
    assert!(is_held(&file).unwrap());

    drop(held);
    assert!(!is_held(&file).unwrap());
    assert!(matches!(
        InstanceLock::acquire(&file).unwrap(),
        Acquired::Held(_)
    ));
}

#[test]
fn server_app_031_two_roots_do_not_share_a_lock() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let a = InstanceLock::acquire(&AppPaths::new(first.path()).lock_file()).unwrap();
    let b = InstanceLock::acquire(&AppPaths::new(second.path()).lock_file()).unwrap();
    assert!(matches!(a, Acquired::Held(_)));
    assert!(matches!(b, Acquired::Held(_)));
}

#[test]
fn server_app_031_probing_a_lock_never_creates_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("missing/app.lock");
    assert!(!is_held(&file).unwrap());
    assert!(!file.exists());
    assert!(!dir.path().join("missing").exists());
}

#[derive(Default)]
struct Recorder(Mutex<Vec<PathBuf>>);

impl Opener for Recorder {
    fn open(&self, path: &Path) -> io::Result<()> {
        self.0.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

#[test]
fn server_app_021_open_logs_folder_and_open_settings_file_open_their_own_paths() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(dir.path());
    let recorder = Recorder::default();

    open_logs_folder(&paths, &recorder).unwrap();
    open_settings_file(&paths, &recorder).unwrap();

    assert_eq!(
        *recorder.0.lock().unwrap(),
        [paths.logs_dir(), paths.settings_file()]
    );
    assert!(paths.logs_dir().is_dir());
}

#[test]
fn server_app_054_the_file_store_keeps_each_service_apart_and_deletes_idempotently() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileStore::new(dir.path().join("creds.json"));

    assert_eq!(store.get("svc-a", WORKER_TOKEN).unwrap(), None);
    store.set("svc-a", WORKER_TOKEN, "abm_one").unwrap();
    store.set("svc-b", WORKER_TOKEN, "abm_two").unwrap();
    assert_eq!(
        store.get("svc-a", WORKER_TOKEN).unwrap().as_deref(),
        Some("abm_one")
    );
    assert_eq!(
        store.get("svc-b", WORKER_TOKEN).unwrap().as_deref(),
        Some("abm_two")
    );

    store.delete("svc-a", WORKER_TOKEN).unwrap();
    store.delete("svc-a", WORKER_TOKEN).unwrap();
    assert_eq!(store.get("svc-a", WORKER_TOKEN).unwrap(), None);
    assert_eq!(
        store.get("svc-b", WORKER_TOKEN).unwrap().as_deref(),
        Some("abm_two")
    );
    assert!(fs::read_to_string(store.path()).unwrap().contains("svc-b"));
}

#[test]
fn server_app_088_resources_are_found_beside_the_binary_and_inside_the_bundle() {
    use agent_board_server_core::app::resources_for;

    let scratch = tempfile::tempdir().unwrap();
    let dev = scratch.path().join("target/debug");
    fs::create_dir_all(dev.join("resources")).unwrap();
    assert_eq!(
        resources_for(&dev.join("agent-board-server")),
        dev.join("resources")
    );

    let app = scratch.path().join("Agent Board Server.app/Contents");
    fs::create_dir_all(app.join("MacOS")).unwrap();
    fs::create_dir_all(app.join("Resources/resources")).unwrap();
    let found = resources_for(&app.join("MacOS/agent-board-server"));
    assert_eq!(
        found.canonicalize().unwrap(),
        app.join("Resources/resources").canonicalize().unwrap()
    );

    let bare = scratch.path().join("bare");
    fs::create_dir_all(&bare).unwrap();
    assert_eq!(
        resources_for(&bare.join("agent-board-server")),
        bare.join("resources")
    );
}
