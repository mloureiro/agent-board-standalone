mod common;

use common::*;
use rumo_client_core::address::AddressProblem;
use rumo_client_core::bridge::{BridgeError, Scope};
use rumo_client_core::files::DirStore;
use rumo_client_core::handover::{
    EarlyLinks, HandoverPlan, UNKNOWN_VERSION_MESSAGE, plan as plan_handover,
};
use rumo_client_core::handshake::RETRY_DELAYS as HANDSHAKE_DELAYS;
use rumo_client_core::opening::{
    LaunchWindow, Opening, WindowAction, launch_plan, plan_open, window_error,
};
use rumo_client_core::orphans::{orphans, sweep, tab_file_name};
use rumo_client_core::ports::{FileStore, PortError};
use rumo_client_core::removal::{Effect, RETRY_DELAYS, Removal};
use rumo_client_core::servers::{ASIDE_FILE, SERVERS_FILE, ServerError, Servers};
use rumo_client_core::tokens::{key_service, token_service};
use std::time::Duration;

const ALPHA: (&str, &str, &str) = (FIRST_ID, "Alpha", "https://board.example.test/");

#[test]
fn client_app_002_page_add_and_remove_need_native_confirmation() {
    let declined = harness([], servers_file(&[ALPHA]), false);
    let scope = scope_of(FIRST_ID);
    assert_eq!(
        declined
            .bridge
            .page_add_server(&scope, "Gamma", "https://gamma.example.test")
            .unwrap(),
        None
    );
    assert!(
        declined
            .bridge
            .page_remove_server(&scope, FIRST_ID)
            .unwrap()
            .is_none()
    );
    assert_eq!(declined.confirm.asked().len(), 2);
    assert_eq!(declined.bridge.servers().list().len(), 1);

    let accepted = harness([], servers_file(&[ALPHA]), true);
    let added = accepted
        .bridge
        .page_add_server(&scope, "  Gamma  ", "https://gamma.example.test")
        .unwrap()
        .unwrap();
    assert_eq!(added.name, "Gamma");
    assert_eq!(added.id, id(SECOND_ID));
    assert_eq!(accepted.bridge.servers().list().len(), 2);
    let reread = Servers::open(accepted.files.clone());
    assert_eq!(reread.list(), accepted.bridge.servers().list());

    let (removal, effects) = accepted
        .bridge
        .page_remove_server(&scope, FIRST_ID)
        .unwrap()
        .unwrap();
    assert_eq!(removal.server(), id(FIRST_ID));
    assert_eq!(effects, vec![Effect::CloseWindow, Effect::DeleteStores]);
    assert_eq!(accepted.bridge.servers().get(id(FIRST_ID)), None);
    assert_eq!(accepted.confirm.asked().len(), 2);
}

#[test]
fn client_app_002_page_add_refuses_an_address_breaking_the_rule() {
    let harness = harness([], servers_file(&[ALPHA]), true);
    let scope = scope_of(FIRST_ID);
    let cases = [
        ("http://remote.example.test", AddressProblem::Insecure),
        (
            "https://user:pw@remote.example.test",
            AddressProblem::Credentials,
        ),
        ("ftp://remote.example.test", AddressProblem::Invalid),
        ("not a url", AddressProblem::Invalid),
    ];
    for (address, problem) in cases {
        assert_eq!(
            harness.bridge.page_add_server(&scope, "Name", address),
            Err(BridgeError::Address(problem)),
            "{address}"
        );
    }
    assert_eq!(
        harness
            .bridge
            .page_add_server(&scope, "   ", "https://ok.example.test"),
        Err(BridgeError::BlankName)
    );
    assert_eq!(
        harness
            .bridge
            .page_add_server(&Scope::None, "Name", "https://ok.example.test"),
        Err(BridgeError::UnknownServer)
    );
    assert!(harness.confirm.asked().is_empty());
    assert_eq!(harness.bridge.servers().list().len(), 1);
}

#[test]
fn client_app_002_the_store_reads_tolerantly_and_writes_atomically() {
    let files = MemoryFiles::default();
    files
        .write(
            SERVERS_FILE,
            serde_json::json!({
                "servers": [
                    {"id": FIRST_ID, "name": "Alpha", "url": "https://a.example.test/", "extra": 1},
                    {"id": "not-an-id", "name": "Bad", "url": "https://b.example.test/"},
                    {"id": SECOND_ID, "name": 5, "url": "https://c.example.test/"},
                    "junk"
                ],
                "other": true
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    assert_eq!(
        Servers::open(files).list(),
        vec![entry(FIRST_ID, "Alpha", "https://a.example.test/")]
    );

    let corrupt = MemoryFiles::default();
    corrupt.write(SERVERS_FILE, b"{nope").unwrap();
    assert!(Servers::open(corrupt).list().is_empty());

    let directory = tempfile::tempdir().unwrap();
    let store = Servers::open(DirStore::new(directory.path()));
    store
        .add(id(FIRST_ID), "Alpha", "https://a.example.test")
        .unwrap();
    store.rename(id(FIRST_ID), " Renamed ").unwrap();
    assert_eq!(store.rename(id(SECOND_ID), "x"), Err(ServerError::Unknown));
    assert_eq!(store.rename(id(FIRST_ID), " "), Err(ServerError::BlankName));
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.path().join(SERVERS_FILE)).unwrap())
            .unwrap();
    assert_eq!(
        on_disk,
        serde_json::json!({"servers": [{"id": FIRST_ID, "name": "Renamed", "url": "https://a.example.test/"}]})
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    store.remove(id(FIRST_ID)).unwrap();
    assert!(
        Servers::open(DirStore::new(directory.path()))
            .list()
            .is_empty()
    );
}

#[test]
fn client_app_002_the_directory_store_refuses_names_that_escape_it() {
    let directory = tempfile::tempdir().unwrap();
    let store = DirStore::new(directory.path());
    for name in ["../x", "a/b", "a\\b", ".hidden", "", "x.tmp"] {
        assert!(store.write(name, b"x").is_err(), "{name}");
        assert!(store.read(name).is_err(), "{name}");
    }
}

#[tokio::test(start_paused = true)]
async fn client_app_003_failed_handshake_opens_no_window_and_names_the_server() {
    let http = FakeHttp::answering([Ok(Canned::json(404, "{}"))]);
    let server = entry(FIRST_ID, "Alpha", "https://board.example.test/");
    let outcome = plan_open(&http, &client_info(), &server, &[]).await;
    match outcome {
        Opening::ListError { name, text } => {
            assert_eq!(name, "Alpha");
            assert!(text.starts_with("Alpha could not be opened: "), "{text}");
        }
        other => panic!("{other:?}"),
    }
    let sent = http.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].url, "https://board.example.test/api/version");
    let limits = sent[0].limits.unwrap();
    assert_eq!(limits.connect, Duration::from_secs(5));
    assert_eq!(limits.total, Duration::from_secs(10));
    assert_eq!(sent[0].header("x-board-contract"), Some("1"));
}

#[tokio::test(start_paused = true)]
async fn client_app_003_transient_failures_retry_before_reporting() {
    assert_eq!(
        HANDSHAKE_DELAYS,
        [Duration::from_secs(1), Duration::from_secs(3)]
    );
    let server = entry(FIRST_ID, "Alpha", "https://board.example.test/");

    let recovering = FakeHttp::answering([
        Err("connection failed".to_owned()),
        Ok(Canned::json(503, "{}")),
        Ok(Canned::version(true)),
    ]);
    let started = tokio::time::Instant::now();
    let outcome = plan_open(&recovering, &client_info(), &server, &[]).await;
    assert_eq!(
        outcome,
        Opening::CreateWindow {
            server: id(FIRST_ID),
            request_signature: true
        }
    );
    assert_eq!(recovering.sent().len(), 3);
    assert_eq!(started.elapsed(), Duration::from_secs(4));

    let down = FakeHttp::answering([
        Err("timed out".to_owned()),
        Err("timed out".to_owned()),
        Err("timed out".to_owned()),
    ]);
    let outcome = plan_open(&down, &client_info(), &server, &[]).await;
    assert!(matches!(outcome, Opening::ListError { .. }));
    assert_eq!(down.sent().len(), 3);

    let not_a_board = FakeHttp::answering([Ok(Canned::json(200, "<html>"))]);
    let outcome = plan_open(&not_a_board, &client_info(), &server, &[]).await;
    assert!(matches!(outcome, Opening::ListError { .. }));
    assert_eq!(not_a_board.sent().len(), 1);
}

#[tokio::test]
async fn client_app_004_open_of_an_open_server_focuses_without_a_check() {
    let http = FakeHttp::default();
    let server = entry(FIRST_ID, "Alpha", "https://board.example.test/");
    let outcome = plan_open(&http, &client_info(), &server, &[id(FIRST_ID)]).await;
    assert_eq!(outcome, Opening::Focus(id(FIRST_ID)));
    assert!(http.sent().is_empty());
}

#[test]
fn client_app_005_rename_retitles_and_reports_a_retitle_failure() {
    let harness = harness([], servers_file(&[ALPHA]), true);
    let scope = scope_of(FIRST_ID);
    let mut retitled_to = None;
    let report = harness
        .bridge
        .rename_server(&scope, FIRST_ID, "  Prime ", |entry| {
            retitled_to = Some(entry.name.clone());
            Ok(())
        })
        .unwrap();
    assert_eq!(retitled_to.as_deref(), Some("Prime"));
    assert_eq!(report.entry.id, id(FIRST_ID));
    assert_eq!(report.retitle_warning, None);

    let failed = harness
        .bridge
        .rename_server(&scope, FIRST_ID, "Final", |_| {
            Err(PortError("window is gone".to_owned()))
        })
        .unwrap();
    assert_eq!(
        failed.retitle_warning.as_deref(),
        Some("The name was saved, but the window title could not be updated: window is gone")
    );
    assert_eq!(
        harness.bridge.servers().get(id(FIRST_ID)).unwrap().name,
        "Final"
    );
    assert_eq!(
        harness
            .bridge
            .rename_server(&scope, SECOND_ID, "x", |_| Ok(()))
            .unwrap_err(),
        BridgeError::UnknownServer
    );
    assert_eq!(
        harness
            .bridge
            .rename_server(&scope, FIRST_ID, "  ", |_| Ok(()))
            .unwrap_err(),
        BridgeError::BlankName
    );
}

#[test]
fn client_app_006_window_errors_are_worded_per_action() {
    assert_eq!(
        window_error(WindowAction::Open, "Alpha", "no window"),
        "Alpha could not be opened: no window"
    );
    assert_eq!(
        window_error(WindowAction::Remove, "Alpha", "busy"),
        "Alpha: the window could not be closed: busy"
    );
    assert_eq!(
        window_error(WindowAction::Rename, "Alpha", "busy"),
        "The name was saved, but the window title could not be updated: busy"
    );
}

#[test]
fn client_app_007_store_deletion_starts_once_even_when_closing_fails() {
    let (mut removal, effects) = Removal::start(id(FIRST_ID), "Alpha");
    assert_eq!(effects, vec![Effect::CloseWindow, Effect::DeleteStores]);
    assert_eq!(
        removal.window_closed(Err("busy".to_owned())),
        vec![Effect::ReportWindowError(
            "Alpha: the window could not be closed: busy".to_owned()
        )]
    );
    assert_eq!(removal.stores_deleted(Ok(())), vec![Effect::Finished]);
    assert!(removal.stores_deleted(Ok(())).is_empty());
    assert!(removal.stores_deleted(Err("late".to_owned())).is_empty());
    assert!(removal.retry().is_empty());
}

#[test]
fn client_app_007_retries_on_the_schedule_and_reports_the_final_failure() {
    let (mut removal, _) = Removal::start(id(FIRST_ID), "Alpha");
    let mut waited = Vec::new();
    let failure = loop {
        let effects = removal.stores_deleted(Err("locked".to_owned()));
        match effects.as_slice() {
            [Effect::DeleteStoresAfter(delay)] => waited.push(*delay),
            [Effect::ReportStoreFailure(message)] => break message.clone(),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(waited, RETRY_DELAYS);
    assert_eq!(
        waited,
        [200, 500, 1000, 2000, 4000].map(Duration::from_millis)
    );
    assert_eq!(failure, "Couldn't delete the stored data of Alpha.");
    assert!(removal.stores_deleted(Err("again".to_owned())).is_empty());

    assert_eq!(removal.retry(), vec![Effect::DeleteStores]);
    assert_eq!(
        removal.stores_deleted(Err("locked".to_owned())),
        vec![Effect::DeleteStoresAfter(Duration::from_millis(200))]
    );
    assert_eq!(removal.stores_deleted(Ok(())), vec![Effect::Finished]);
}

#[test]
fn client_app_008_launch_deletes_stores_of_unlisted_servers() {
    let secrets = MemorySecrets::default();
    let tab_files = MemoryFiles::default();
    for service in [token_service(), key_service()] {
        secrets.put(&service, FIRST_ID, b"kept");
        secrets.put(&service, SECOND_ID, b"orphan");
        secrets.put(&service, "legacy-account", b"foreign");
    }
    tab_files
        .write(&tab_file_name(id(FIRST_ID)), b"{}")
        .unwrap();
    tab_files
        .write(&tab_file_name(id(SECOND_ID)), b"{}")
        .unwrap();
    tab_files.write("notes.txt", b"mine").unwrap();

    let swept = sweep(&[id(FIRST_ID)], &secrets, &tab_files);

    assert_eq!(swept, vec![id(SECOND_ID)]);
    for service in [token_service(), key_service()] {
        assert!(secrets.peek(&service, FIRST_ID).is_some());
        assert!(secrets.peek(&service, SECOND_ID).is_none());
        assert!(secrets.peek(&service, "legacy-account").is_some());
    }
    assert_eq!(
        tab_files.list().unwrap(),
        vec![tab_file_name(id(FIRST_ID)), "notes.txt".to_owned()]
    );
    assert_eq!(orphans(&[], ["x", FIRST_ID, FIRST_ID]), vec![id(FIRST_ID)]);
}

#[test]
fn client_app_009_launch_opens_only_the_server_list() {
    let listed = [entry(FIRST_ID, "Alpha", "https://board.example.test/")];
    assert_eq!(launch_plan(&listed).windows, vec![LaunchWindow::ServerList]);
    assert_eq!(launch_plan(&[]).windows, vec![LaunchWindow::ServerList]);
}

#[tokio::test]
async fn client_app_012_a_loopback_entry_opens_through_the_handshake_like_any_other() {
    let http = FakeHttp::answering([Ok(Canned::version(false))]);
    let local = entry(SECOND_ID, "Local", "http://localhost:4000/");
    let outcome = plan_open(&http, &client_info(), &local, &[]).await;
    assert_eq!(
        outcome,
        Opening::CreateWindow {
            server: id(SECOND_ID),
            request_signature: false
        }
    );
    assert_eq!(http.sent()[0].url, "http://localhost:4000/api/version");
}

#[test]
fn client_app_051_all_servers_scope_is_the_open_windows() {
    let harness = harness(
        [],
        servers_file(&[ALPHA, (SECOND_ID, "Beta", "https://beta.example.test/")]),
        true,
    );
    let open = [id(SECOND_ID)];
    let all = Scope::from_label("all-servers", &open);
    assert_eq!(all, Scope::AllServers(vec![id(SECOND_ID)]));
    assert_eq!(
        harness.bridge.list_servers(&all),
        vec![entry(SECOND_ID, "Beta", "https://beta.example.test/")]
    );
    assert_eq!(all.resolve(SECOND_ID), Ok(id(SECOND_ID)));
    assert_eq!(all.resolve(FIRST_ID), Err(BridgeError::UnknownServer));

    let tab = Scope::from_label(&format!("tab-{FIRST_ID}-3"), &open);
    assert_eq!(tab, Scope::Server(id(FIRST_ID)));
    assert_eq!(harness.bridge.list_servers(&tab).len(), 1);
    assert_eq!(harness.bridge.list_servers(&tab)[0].id, id(FIRST_ID));

    for label in [
        "list",
        "tabbar-6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        &format!("tab-{FIRST_ID}"),
        &format!("tab-{FIRST_ID}-x"),
        "tab-nope-1",
        "all-servers2",
    ] {
        let scope = Scope::from_label(label, &open);
        assert_eq!(scope, Scope::None, "{label}");
        assert!(harness.bridge.list_servers(&scope).is_empty());
    }
}

#[test]
fn client_app_002_page_names_are_capped_and_refuse_control_characters() {
    let harness = harness([], servers_file(&[ALPHA]), true);
    let scope = scope_of(FIRST_ID);
    for name in ["line\nbreak", "tab\there", "nul\0byte", &"x".repeat(101)] {
        assert_eq!(
            harness
                .bridge
                .page_add_server(&scope, name, "https://ok.example.test"),
            Err(BridgeError::InvalidName),
            "{name:?}"
        );
        assert_eq!(
            harness
                .bridge
                .rename_server(&scope, FIRST_ID, name, |_| Ok(()))
                .map(|_| ()),
            Err(BridgeError::InvalidName),
            "{name:?}"
        );
    }
    assert!(harness.confirm.asked().is_empty());
    assert_eq!(harness.bridge.servers().list().len(), 1);
    let longest = "x".repeat(100);
    assert!(
        harness
            .bridge
            .page_add_server(&scope, &longest, "https://ok.example.test")
            .unwrap()
            .is_some()
    );
}

const LINK_A: &str = "rumo://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F";
const LINK_B: &str = "rumo://open?v=1&url=http%3A%2F%2Flocalhost%3A4001%2F";

#[test]
fn client_app_015_links_before_setup_are_held_then_handled() {
    let links = EarlyLinks::holding();
    assert_eq!(links.deliver(vec![LINK_A.to_owned()]), None);
    assert_eq!(links.deliver(vec![LINK_B.to_owned()]), None);
    assert_eq!(links.release(), vec![LINK_A.to_owned(), LINK_B.to_owned()]);
    assert_eq!(
        plan_handover([LINK_A, LINK_B], &[]),
        HandoverPlan::Add {
            name: "localhost:4000".to_owned(),
            url: "http://localhost:4000/".to_owned()
        }
    );
    assert_eq!(
        links.deliver(vec![LINK_B.to_owned()]),
        Some(vec![LINK_B.to_owned()])
    );
    assert!(links.release().is_empty());
}

#[test]
fn client_app_014_an_unacceptable_link_only_brings_the_list_forward() {
    let listed = [entry(FIRST_ID, "Alpha", "http://localhost:4000/")];
    let nothing = HandoverPlan::ShowList { message: None };
    for link in [
        "https://example.test/",
        "rumo://open?v=1&url=http%3A%2F%2F192.168.1.10%3A4000%2F",
        "rumo://open?v=1&url=http%3A%2F%2Fuser%3Asecret%40localhost%3A2%2F",
        "rumo://open?v=1",
    ] {
        assert_eq!(plan_handover([link], &listed), nothing, "{link}");
    }
    assert_eq!(plan_handover([], &listed), nothing);
    assert_eq!(
        plan_handover(
            ["rumo://open?v=2&url=http%3A%2F%2Flocalhost%3A1%2F"],
            &listed
        ),
        HandoverPlan::ShowList {
            message: Some(UNKNOWN_VERSION_MESSAGE.to_owned())
        }
    );
    assert_eq!(
        plan_handover(
            ["rumo://open?v=2&url=http%3A%2F%2Flocalhost%3A1%2F", LINK_A],
            &listed
        ),
        HandoverPlan::Open(id(FIRST_ID))
    );
}

#[test]
fn client_app_013_a_known_address_opens_and_an_unknown_one_is_added() {
    let listed = [
        entry(FIRST_ID, "Alpha", "http://localhost:4000/"),
        entry(SECOND_ID, "localhost:4001", "https://board.example.test/"),
    ];
    assert_eq!(
        plan_handover([LINK_A], &listed),
        HandoverPlan::Open(id(FIRST_ID))
    );
    assert_eq!(
        plan_handover(
            ["rumo://open?v=1&url=HTTP%3A%2F%2FLOCALHOST%3A4000"],
            &listed
        ),
        HandoverPlan::Open(id(FIRST_ID))
    );
    assert_eq!(
        plan_handover([LINK_B], &listed),
        HandoverPlan::Add {
            name: "localhost:4001 (2)".to_owned(),
            url: "http://localhost:4001/".to_owned()
        }
    );
}

#[test]
fn client_app_002_an_unreadable_servers_file_is_kept_aside_before_the_next_write() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join(SERVERS_FILE), b"{nope").unwrap();
    let store = Servers::open(DirStore::new(directory.path()));
    assert!(store.list().is_empty());
    assert!(!store.complete());
    assert_eq!(
        std::fs::read(directory.path().join(ASIDE_FILE)).unwrap(),
        b"{nope"
    );
    store
        .add(id(FIRST_ID), "Alpha", "https://a.example.test")
        .unwrap();
    assert_eq!(
        std::fs::read(directory.path().join(ASIDE_FILE)).unwrap(),
        b"{nope"
    );
    let reopened = Servers::open(DirStore::new(directory.path()));
    assert_eq!(reopened.list().len(), 1);
    assert!(!reopened.complete());

    std::fs::remove_file(directory.path().join(ASIDE_FILE)).unwrap();
    assert!(Servers::open(DirStore::new(directory.path())).complete());
    let empty = tempfile::tempdir().unwrap();
    assert!(Servers::open(DirStore::new(empty.path())).complete());
}

#[test]
fn client_app_008_a_partly_readable_servers_file_keeps_every_store() {
    let directory = tempfile::tempdir().unwrap();
    let document = format!(
        r#"{{"servers":[{{"id":"{FIRST_ID}","name":"Alpha","url":"https://a.example.test/"}},{{"id":"not-an-id","name":"Lost","url":"https://b.example.test/"}}]}}"#
    );
    std::fs::write(directory.path().join(SERVERS_FILE), &document).unwrap();
    let store = Servers::open(DirStore::new(directory.path()));
    assert_eq!(store.list().len(), 1);
    assert!(!store.complete());
    assert_eq!(
        std::fs::read(directory.path().join(ASIDE_FILE)).unwrap(),
        document.as_bytes()
    );
}
