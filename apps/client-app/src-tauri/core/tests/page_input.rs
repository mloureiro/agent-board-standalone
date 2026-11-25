use agent_board_client_core::page_input::{
    BODY_MAX_BYTES, HEADERS_MAX, InputError, TITLE_MAX_CHARS, fetch_input, link, notification,
    pairing, sign_in, tab_report,
};

#[test]
fn client_app_002_notifications_cap_the_title_and_refuse_odd_task_ids() {
    let long = "t".repeat(TITLE_MAX_CHARS + 50);
    let accepted = notification("task_1-A", &format!("{long}\n")).unwrap();
    assert_eq!(accepted.title.chars().count(), TITLE_MAX_CHARS);
    assert!(!accepted.title.contains('\n'));
    assert!(notification("4f0d6a1e-7c7a-4a52-9d6e-0a7b8c9d0e1f", "x").is_ok());
    for bad in ["", "a b", "../x", "x\n", &"a".repeat(65), "é"] {
        assert_eq!(notification(bad, "x"), Err(InputError::TaskId), "{bad:?}");
    }
}

#[test]
fn client_app_002_links_are_http_or_https_with_a_host_only() {
    assert!(link("https://example.test/a?b=1").is_ok());
    assert!(link("http://localhost:3000/").is_ok());
    for bad in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,x",
        "mailto:a@b.test",
        "about:blank",
        "https://",
        "not a url",
        "https://example.test/\u{7}",
        &format!("https://example.test/{}", "a".repeat(2100)),
    ] {
        assert_eq!(link(bad).map(|_| ()), Err(InputError::Link), "{bad:?}");
    }
}

#[test]
fn client_app_002_tab_reports_are_paths_with_a_capped_title() {
    assert!(tab_report("/tasks/1?x=2", "Title").is_ok());
    for bad in [
        "tasks",
        "//evil.test",
        "/a\nb",
        &format!("/{}", "a".repeat(2100)),
    ] {
        assert!(
            matches!(tab_report(bad, "t"), Err(InputError::TabPath)),
            "{bad:?}"
        );
    }
    assert!(matches!(
        tab_report("/", "bad\ntitle"),
        Err(InputError::TabTitle)
    ));
    let capped = tab_report("/", &"é".repeat(300)).unwrap();
    assert_eq!(capped.title.chars().count(), TITLE_MAX_CHARS);
}

#[test]
fn client_app_049_fetch_inputs_are_bounded() {
    assert!(fetch_input(HEADERS_MAX, Some("{}")).is_ok());
    assert_eq!(
        fetch_input(HEADERS_MAX + 1, None),
        Err(InputError::TooManyHeaders)
    );
    let body = "x".repeat(BODY_MAX_BYTES + 1);
    assert_eq!(fetch_input(0, Some(&body)), Err(InputError::BodyTooLarge));
}

#[test]
fn client_app_018_tab_commands_accept_only_known_intents_directions_and_plain_paths() {
    use agent_board_client_core::page_input::{
        TabIntent, tab_direction, tab_intent, tab_path, tab_title,
    };
    assert_eq!(tab_intent("open"), Ok(TabIntent::Open));
    assert_eq!(tab_intent("route"), Ok(TabIntent::Route));
    assert_eq!(tab_intent("new"), Ok(TabIntent::New));
    assert_eq!(tab_intent("Open"), Err(InputError::TabIntent));
    assert_eq!(tab_direction("next"), Ok(true));
    assert_eq!(tab_direction("previous"), Ok(false));
    assert_eq!(tab_direction("up"), Err(InputError::TabDirection));
    assert_eq!(tab_path("/backlog?q=1"), Ok("/backlog?q=1".to_owned()));
    assert_eq!(tab_path("//evil.test"), Err(InputError::TabPath));
    assert_eq!(tab_path("https://evil.test"), Err(InputError::TabPath));
    assert_eq!(tab_title("Backlog"), Ok("Backlog".to_owned()));
    assert_eq!(tab_title("a\nb"), Err(InputError::TabTitle));
}

#[test]
fn client_app_002_sign_in_and_pairing_inputs_are_capped_and_free_of_control_characters() {
    let verifier = "v".repeat(43);
    assert!(sign_in("flow-1", &verifier).is_ok());
    for (flow, verifier) in [
        ("", "v"),
        ("f", ""),
        ("f\n", "v"),
        ("f", "v\u{0}"),
        (&"f".repeat(129), "v"),
        ("f", &"v".repeat(129)),
    ] {
        assert_eq!(sign_in(flow, verifier), Err(InputError::SignIn), "{flow:?}");
    }
    assert!(pairing("ABCD-2345", "Mac").is_ok());
    for (code, label) in [
        ("", "Mac"),
        ("ABCD-2345", ""),
        ("ABCD-2345", &"l".repeat(65)),
        (&"A".repeat(33), "Mac"),
        ("ABCD\n2345", "Mac"),
        ("ABCD-2345", "Ma\tc"),
    ] {
        assert_eq!(
            pairing(code, label),
            Err(InputError::Pairing),
            "{code:?} {label:?}"
        );
    }
}
