mod common;

use common::MemoryFiles;
use rumo_client_core::keybindings::{
    Accelerator, FILE_NAME, Keybindings, Refusal, action_ids, read,
};
use rumo_client_core::ports::FileStore;
use rumo_client_core::shortcuts::{
    MENU_CLOSE_PANE, MENU_CLOSE_TAB, MENU_NEXT_TAB, MENU_PREVIOUS_TAB, MENU_SPLIT_TAB,
    from_menu_id, menu_select_id,
};
use serde_json::{Value, json};

fn resolved(body: &Value) -> Keybindings {
    Keybindings::resolve(Some(body.to_string().as_bytes()))
}

fn bound(keys: &Keybindings, id: &str) -> String {
    keys.accelerator(id).unwrap().to_owned()
}

#[test]
fn client_app_029_keybindings_file_overrides_defaults_and_ignores_invalid_entries() {
    let defaults = Keybindings::defaults();
    assert_eq!(bound(&defaults, MENU_CLOSE_TAB), "CmdOrCtrl+W");
    assert_eq!(bound(&defaults, MENU_NEXT_TAB), "Ctrl+Tab");
    assert_eq!(bound(&defaults, MENU_PREVIOUS_TAB), "Ctrl+Shift+Tab");
    assert_eq!(bound(&defaults, &menu_select_id(4)), "CmdOrCtrl+4");
    assert_eq!(Keybindings::resolve(None), defaults);

    let files = MemoryFiles::default();
    assert_eq!(read(&files), defaults, "no file means the defaults");

    let body = json!({
        "v": 1,
        "keybindings": {
            "tab-next": "cmd+alt+n",
            "split-tab": "CmdOrCtrl+Shift+D",
            "close-pane": "garbage",
            "tab-select-3": 7,
            "unknown-action": "CmdOrCtrl+K",
            "tab-previous": "CmdOrCtrl+Q",
            "tab-select-1": "Shift+A",
            "tab-select-2": "",
        }
    });
    files.write(FILE_NAME, body.to_string().as_bytes()).unwrap();
    let keys = read(&files);
    assert_eq!(bound(&keys, MENU_NEXT_TAB), "CmdOrCtrl+Alt+N");
    assert_eq!(bound(&keys, MENU_SPLIT_TAB), "CmdOrCtrl+Shift+D");
    for untouched in [
        MENU_CLOSE_PANE,
        MENU_PREVIOUS_TAB,
        MENU_CLOSE_TAB,
        &menu_select_id(1),
        &menu_select_id(2),
        &menu_select_id(3),
    ] {
        assert_eq!(
            keys.accelerator(untouched),
            defaults.accelerator(untouched),
            "{untouched}"
        );
    }
    assert!(keys.accelerator("unknown-action").is_none());

    for invalid in [
        &b"not json"[..],
        b"[]",
        b"{}",
        br#"{"v":2,"keybindings":{"tab-next":"CmdOrCtrl+K"}}"#,
        br#"{"v":1}"#,
        br#"{"v":1,"keybindings":[]}"#,
    ] {
        assert_eq!(Keybindings::resolve(Some(invalid)), defaults);
    }
}

#[test]
fn client_app_029_keybindings_never_share_an_accelerator() {
    let defaults = Keybindings::defaults();
    let mut seen: Vec<&str> = defaults
        .entries()
        .iter()
        .map(|(_, accelerator)| accelerator.as_str())
        .collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), action_ids().len());
    for (id, accelerator) in defaults.entries() {
        assert!(from_menu_id(id).is_some(), "{id}");
        assert_eq!(
            &Accelerator::parse(accelerator).unwrap().canonical(),
            accelerator
        );
    }

    let taken = resolved(&json!({"v": 1, "keybindings": {"split-tab": "CmdOrCtrl+W"}}));
    assert_eq!(
        bound(&taken, MENU_SPLIT_TAB),
        bound(&defaults, MENU_SPLIT_TAB)
    );

    let both = resolved(&json!({"v": 1, "keybindings": {
        "split-tab": "CmdOrCtrl+K", "move-tab": "cmdorctrl+k"
    }}));
    assert_eq!(both, defaults);

    let swapped = resolved(&json!({"v": 1, "keybindings": {
        "tab-next": "Ctrl+Shift+Tab", "tab-previous": "Ctrl+Tab"
    }}));
    assert_eq!(bound(&swapped, MENU_NEXT_TAB), "Ctrl+Shift+Tab");
    assert_eq!(bound(&swapped, MENU_PREVIOUS_TAB), "Ctrl+Tab");
}

#[test]
fn client_app_029_accelerators_are_parsed_strictly_and_system_keys_are_refused() {
    let canonical = |text: &str| Accelerator::parse(text).map(|found| found.canonical());
    assert_eq!(canonical("cmd+shift+]"), Ok("CmdOrCtrl+Shift+]".to_owned()));
    assert_eq!(
        canonical("Option+Command+p"),
        Ok("CmdOrCtrl+Alt+P".to_owned())
    );
    assert_eq!(canonical("Control+Left"), Ok("Ctrl+Left".to_owned()));
    assert_eq!(canonical("F5"), Ok("F5".to_owned()));
    assert_eq!(canonical("CmdOrCtrl+9"), Ok("CmdOrCtrl+9".to_owned()));

    for malformed in [
        "",
        "+",
        "Cmd+",
        "+K",
        "Cmd++K",
        "Cmd Cmd+K",
        "Cmd+Cmd+K",
        "Cmd+CmdOrCtrl+K",
        "Hyper+K",
        "Cmd+Shift",
        " Cmd+K",
    ] {
        assert!(canonical(malformed).is_err(), "{malformed:?}");
    }
    for unknown in [
        "Cmd+Space",
        "Cmd+F13",
        "Cmd+F0",
        "Cmd+F01",
        "Cmd+é",
        "Cmd+KK",
        "Cmd+`",
    ] {
        assert_eq!(canonical(unknown), Err(Refusal::UnknownKey), "{unknown}");
    }
    for bare in [
        "K",
        "Shift+K",
        "Alt+K",
        "Ctrl+K",
        "Alt+Shift+9",
        "Shift+Tab",
        "Alt+Left",
    ] {
        assert_eq!(canonical(bare), Err(Refusal::NeedsModifier), "{bare}");
    }
    for system in [
        "Cmd+Q",
        "CmdOrCtrl+q",
        "Cmd+H",
        "Cmd+Alt+H",
        "Cmd+M",
        "Cmd+C",
        "Cmd+V",
        "Cmd+X",
        "Cmd+A",
        "Cmd+Z",
        "Cmd+Shift+Z",
        "Cmd+Tab",
        "Cmd+Shift+Tab",
        "Cmd+Shift+W",
        "Cmd+Alt+W",
        "Cmd+Ctrl+Q",
        "Cmd+=",
        "Cmd+Shift+=",
        "Cmd+-",
        "Cmd+0",
    ] {
        assert_eq!(canonical(system), Err(Refusal::Reserved), "{system}");
    }
}
