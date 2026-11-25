mod common;

use agent_board_client_core::files::DirStore;
use agent_board_client_core::log::{LogEvent, line};
use agent_board_client_core::orphans::tab_file_name;
use agent_board_client_core::ports::{FileStore, PortError};
use agent_board_client_core::tab_file::{self, VERSION};
use agent_board_client_core::tabs::{Effect, HOME, MAX_TABS, Tabs};
use common::*;
use serde_json::{Value, json};

struct Unreadable;

impl FileStore for Unreadable {
    fn read(&self, _: &str) -> Result<Option<Vec<u8>>, PortError> {
        Err(PortError("denied".to_owned()))
    }

    fn write(&self, _: &str, _: &[u8]) -> Result<(), PortError> {
        Err(PortError("denied".to_owned()))
    }

    fn delete(&self, _: &str) -> Result<(), PortError> {
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, PortError> {
        Ok(Vec::new())
    }
}

fn stored(files: &MemoryFiles, body: &Value) {
    files
        .write(&tab_file_name(id(FIRST_ID)), body.to_string().as_bytes())
        .unwrap();
}

fn restored_paths(tabs: &Tabs) -> Vec<&str> {
    tabs.tabs()
        .iter()
        .skip(1)
        .map(|tab| tab.path.as_str())
        .collect()
}

fn loaded(tabs: &Tabs) -> Vec<bool> {
    tabs.tabs().iter().map(|tab| tab.loaded).collect()
}

#[test]
fn client_app_024_restores_order_and_selection_loading_only_the_selected_tab() {
    let files = MemoryFiles::default();
    let mut tabs = Tabs::new();
    for path in [
        "/tasks/t-1?transcript=1",
        "/backlog",
        "/tasks/t-2",
        "/closed",
    ] {
        tabs.open(path);
    }
    tabs.select(2);
    tab_file::write(&files, id(FIRST_ID), &tabs).unwrap();

    let restored = tab_file::read(&files, id(FIRST_ID));
    assert_eq!(restored.log, None);
    let mut tabs = restored.tabs;
    assert_eq!(
        restored_paths(&tabs),
        vec![
            "/tasks/t-1?transcript=1",
            "/backlog",
            "/tasks/t-2",
            "/closed"
        ]
    );
    assert_eq!(tabs.selected(), 2);
    assert_eq!(loaded(&tabs), vec![false, false, true, false, false]);
    assert_eq!(
        tabs.start(),
        vec![
            Effect::CreateWebview {
                tab: 2,
                path: "/backlog".to_owned()
            },
            Effect::Show(2),
            Effect::UpdateBar,
        ]
    );

    let effects = tabs.select(HOME);
    assert_eq!(
        effects[0],
        Effect::CreateWebview {
            tab: HOME,
            path: "/".to_owned()
        }
    );
    assert_eq!(loaded(&tabs), vec![true, false, true, false, false]);

    stored(
        &files,
        &json!({"v": 1, "panes": [{"tabs": ["/backlog", 7, "/nope", "/backlog?x=1", "/tasks/", "/closed", "/schedules"], "selected": 6}], "split": [], "focused": 0}),
    );
    let filtered = tab_file::read(&files, id(FIRST_ID)).tabs;
    assert_eq!(
        restored_paths(&filtered),
        vec!["/backlog", "/closed", "/schedules"]
    );
    assert_eq!(filtered.selected(), 2);

    stored(
        &files,
        &json!({"v": 1, "panes": [{"tabs": ["/backlog", "/nope", "/closed"], "selected": 2}]}),
    );
    assert_eq!(tab_file::read(&files, id(FIRST_ID)).tabs.selected(), HOME);

    let many: Vec<String> = (0..MAX_TABS + 5).map(|n| format!("/tasks/t-{n}")).collect();
    stored(
        &files,
        &json!({"v": 1, "panes": [{"tabs": many, "selected": MAX_TABS + 3}]}),
    );
    let capped = tab_file::read(&files, id(FIRST_ID)).tabs;
    assert_eq!(capped.tabs().len(), MAX_TABS + 1);
    assert_eq!(capped.selected(), HOME);

    stored(
        &files,
        &json!({"v": 1, "panes": [{"tabs": ["/backlog"], "selected": 9}]}),
    );
    let out_of_range = tab_file::read(&files, id(FIRST_ID)).tabs;
    assert_eq!(out_of_range.selected(), HOME);
    assert_eq!(loaded(&out_of_range), vec![true, false]);

    let missing = tab_file::read(&MemoryFiles::default(), id(FIRST_ID));
    assert_eq!(missing.log, None);
    assert_eq!(missing.tabs, Tabs::new());
}

#[test]
fn client_app_024_corrupt_tab_file_restores_home_and_logs_one_line_with_the_server_id() {
    let corrupt: [&[u8]; 6] = [
        b"not json",
        b"",
        br#"{"v":2,"panes":[{"tabs":["/backlog"],"selected":1}]}"#,
        br#"{"panes":[]}"#,
        br#"{"v":1,"panes":[{"tabs":"/backlog","selected":1}]}"#,
        br#"{"v":1,"panes":[{"tabs":["/backlog"],"selected":-1}]}"#,
    ];
    for bytes in corrupt {
        let files = MemoryFiles::default();
        files.write(&tab_file_name(id(FIRST_ID)), bytes).unwrap();
        let restored = tab_file::read(&files, id(FIRST_ID));
        assert_eq!(
            restored.tabs,
            Tabs::new(),
            "{}",
            String::from_utf8_lossy(bytes)
        );
        assert_eq!(restored.tabs.tabs().len(), 1);
        assert_eq!(restored.log, Some(LogEvent::TabFileUnreadable));
    }

    let denied = tab_file::read(&Unreadable, id(FIRST_ID));
    assert_eq!(denied.tabs, Tabs::new());
    assert_eq!(denied.log, Some(LogEvent::TabFileUnreadable));

    assert_eq!(
        line(id(FIRST_ID), LogEvent::TabFileUnreadable),
        format!("server={FIRST_ID} tab file unreadable, restored home only")
    );
}

#[test]
fn client_app_036_tab_file_holds_paths_and_selection_only() {
    let mut tabs = Tabs::new();
    tabs.open("/tasks/t-1?transcript=1");
    tabs.open("/backlog");
    tabs.title(1, "Secret decrypted title · Agent Board");
    tabs.title(2, "Another private title · Agent Board");

    let written: Value = serde_json::from_slice(&tab_file::encode(&tabs)).unwrap();
    assert_eq!(
        written,
        json!({
            "v": VERSION,
            "panes": [{"tabs": ["/tasks/t-1?transcript=1", "/backlog"], "selected": 2}],
            "split": [],
            "focused": 0,
        })
    );
    let text = written.to_string();
    assert!(!text.contains("title"));
    assert!(!text.contains("label"));
    assert!(!text.contains("Secret"));
    assert!(!text.contains("private"));
}

#[test]
fn client_app_036_tab_file_write_is_atomic_and_named_after_the_server() {
    let directory = tempfile::tempdir().unwrap();
    let store = DirStore::new(directory.path());
    let mut tabs = Tabs::new();
    tabs.open("/closed");
    tab_file::write(&store, id(FIRST_ID), &tabs).unwrap();
    tabs.open("/backlog");
    tab_file::write(&store, id(FIRST_ID), &tabs).unwrap();

    let names = store.list().unwrap();
    assert_eq!(names, vec![format!("{FIRST_ID}.json")]);
    let reread = tab_file::read(&store, id(FIRST_ID)).tabs;
    assert_eq!(restored_paths(&reread), vec!["/closed", "/backlog"]);
    assert_eq!(reread.selected(), 2);
}
