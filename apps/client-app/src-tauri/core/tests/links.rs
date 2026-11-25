use agent_board_client_core::ids::ServerId;
use agent_board_client_core::links::{Link, Trigger, classify};
use agent_board_client_core::log::{LogEvent, line};

#[test]
fn client_app_034_log_lines_carry_only_the_server_id() {
    let server = ServerId::parse("6ba7b810-9dad-41d1-80b4-00c04fd430c8").unwrap();
    for event in LogEvent::ALL {
        let text = line(server, event);
        assert_eq!(
            text,
            format!(
                "server=6ba7b810-9dad-41d1-80b4-00c04fd430c8 {}",
                event.text()
            )
        );
        for fragment in ["://", "/", "\\", "?", "#", "@"] {
            assert!(!event.text().contains(fragment), "{}", event.text());
        }
    }
    let distinct: std::collections::BTreeSet<_> =
        LogEvent::ALL.iter().map(|event| event.text()).collect();
    assert_eq!(distinct.len(), LogEvent::ALL.len());
}

fn app() -> url::Url {
    url::Url::parse("tauri://localhost").unwrap()
}

const TRIGGERS: [Trigger; 3] = [
    Trigger::Navigation,
    Trigger::NewWindow,
    Trigger::ModifiedClick,
];

#[test]
fn client_app_031_another_origin_opens_in_the_default_browser() {
    for target in [
        "https://github.com/o/r/pull/1",
        "http://localhost:4000/tasks/1",
        "https://board.example.test:8443/",
        "https://board.example.test/approve?code=ABCD-2345",
        "http://tauri.localhost.evil.test/",
    ] {
        for trigger in TRIGGERS {
            let parsed = url::Url::parse(target).unwrap().to_string();
            assert_eq!(
                classify(target, &app(), trigger),
                Link::External(parsed),
                "{target} {trigger:?}"
            );
        }
    }
}

#[test]
fn client_app_032_dropped_schemes_and_blank_new_windows_go_nowhere() {
    for target in [
        "mailto:a@example.test",
        "file:///etc/hosts",
        "javascript:alert(1)",
        "data:text/html,x",
        "about:blank",
        "blob:https://example.test/1",
        "tauri://localhost.evil.test/",
        "ftp://example.test/x",
        "https://",
        "not a url",
        "",
        "https://example.test/\u{7}",
    ] {
        for trigger in TRIGGERS {
            assert_eq!(
                classify(target, &app(), trigger),
                Link::Drop,
                "{target:?} {trigger:?}"
            );
        }
    }
}

#[test]
fn client_app_033_an_app_path_in_a_new_window_opens_a_tab_and_never_a_window() {
    for (target, path) in [
        ("tauri://localhost/", "/"),
        ("tauri://localhost/tasks/1?x=1", "/tasks/1?x=1"),
    ] {
        assert_eq!(
            classify(target, &app(), Trigger::NewWindow),
            Link::Tab(path.to_owned()),
            "{target}"
        );
    }
}

#[test]
fn client_app_033_the_app_origin_is_the_one_the_window_runs_on() {
    let dev = url::Url::parse("http://localhost:1420").unwrap();
    assert_eq!(
        classify("http://localhost:1420/tasks/1", &dev, Trigger::Navigation),
        Link::Stay
    );
    assert_eq!(
        classify("tauri://localhost/tasks/1", &dev, Trigger::Navigation),
        Link::Drop
    );
}

#[test]
fn client_app_033_only_the_handoff_link_and_external_origins_leave_the_app() {
    for stays in [
        "tauri://localhost/",
        "tauri://localhost/tasks/1?transcript=1",
        "tauri://localhost/settings",
        "tauri://localhost/approve",
    ] {
        assert_eq!(
            classify(stays, &app(), Trigger::Navigation),
            Link::Stay,
            "{stays}"
        );
    }
    assert_eq!(
        classify(
            "tauri://localhost/tasks/1?x=1",
            &app(),
            Trigger::ModifiedClick
        ),
        Link::Tab("/tasks/1?x=1".to_owned())
    );
    assert_eq!(
        classify("tauri://localhost/", &app(), Trigger::ModifiedClick),
        Link::Tab("/".to_owned())
    );
    assert_eq!(
        classify(
            "https://board.example.test/approve?code=ABCD-2345",
            &app(),
            Trigger::Navigation
        ),
        Link::External("https://board.example.test/approve?code=ABCD-2345".to_owned())
    );
}
