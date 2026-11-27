mod common;

use common::{Canned, FIRST_ID, SECOND_ID, harness, id, scope_of, servers_file, token};
use rumo_client_core::attention::{AttentionPoller, MAX_IDS_PER_POLL, POLL_SECS};
use rumo_client_core::ids::ServerId;
use rumo_client_core::log::LogEvent;
use rumo_client_core::notify::{
    Banner, Click, DEDUPE_SECS, Decision, EXPIRED_BANNER, FocusState, MAX_TRACKED, NotifyPolicy,
    NotifyRequest, Permission, Reason, Target, expiry_banner, route_click,
};
use rumo_client_core::page_input::{InputError, TITLE_MAX_CHARS};
use rumo_client_core::throttle::{BEAT_SECS, Change, SILENCE_SECS, State, Throttle};
use rumo_client_core::tokens::token_service;
use rumo_client_core::watch::{Tick, Watch};
use rumo_client_core::zoom::{
    Effect, LADDER, MENU_ZOOM_IN, MENU_ZOOM_IN_SHIFTED, MENU_ZOOM_OUT, MENU_ZOOM_RESET, Step, Zoom,
    from_menu_id,
};

const T0: u64 = 1_000;

fn request(server: &str, task: Option<&str>, title: &str) -> NotifyRequest {
    NotifyRequest::parse(id(server), "Work", task, title).unwrap()
}

fn nothing_focused() -> FocusState {
    FocusState {
        key_window_server: None,
        home_selected: false,
    }
}

fn is_raise(decision: &Decision) -> bool {
    matches!(decision, Decision::Raise { .. })
}

#[test]
fn client_app_041_no_notification_when_the_server_home_is_selected_in_the_key_window() {
    let mut policy = NotifyPolicy::new();
    let first = request(FIRST_ID, Some("t1"), "Review the plan");
    let home_of_first = FocusState {
        key_window_server: Some(id(FIRST_ID)),
        home_selected: true,
    };
    assert_eq!(
        policy.decide(&first, home_of_first, Permission::Granted, T0),
        Decision::Suppress(Reason::HomeInKeyWindow)
    );

    let task_tab_of_first = FocusState {
        home_selected: false,
        ..home_of_first
    };
    assert!(is_raise(&policy.decide(
        &first,
        task_tab_of_first,
        Permission::Granted,
        T0
    )));

    let other = request(SECOND_ID, Some("t1"), "Review the plan");
    assert!(is_raise(&policy.decide(
        &other,
        home_of_first,
        Permission::Granted,
        T0
    )));
}

#[test]
fn client_app_041_no_prompt_before_the_first_notification_and_denial_logs_once() {
    let mut policy = NotifyPolicy::new();
    let focused = FocusState {
        key_window_server: Some(id(FIRST_ID)),
        home_selected: true,
    };
    let silent = request(FIRST_ID, Some("t0"), "Seen already");
    assert_eq!(
        policy.decide(&silent, focused, Permission::Unknown, T0),
        Decision::Suppress(Reason::HomeInKeyWindow)
    );

    let first = request(FIRST_ID, Some("t1"), "Review the plan");
    let Decision::Raise { ask_permission, .. } =
        policy.decide(&first, nothing_focused(), Permission::Unknown, T0)
    else {
        panic!("expected a raise");
    };
    assert!(ask_permission);

    let second = request(FIRST_ID, Some("t2"), "Another");
    let Decision::Raise { ask_permission, .. } =
        policy.decide(&second, nothing_focused(), Permission::Granted, T0)
    else {
        panic!("expected a raise");
    };
    assert!(!ask_permission);

    let third = request(FIRST_ID, Some("t3"), "Third");
    let fourth = request(FIRST_ID, Some("t4"), "Fourth");
    assert_eq!(
        policy.decide(&third, nothing_focused(), Permission::Denied, T0),
        Decision::Suppress(Reason::PermissionDenied {
            log: Some(LogEvent::NotificationDenied)
        })
    );
    assert_eq!(
        policy.decide(&fourth, nothing_focused(), Permission::Denied, T0),
        Decision::Suppress(Reason::PermissionDenied { log: None })
    );
}

#[test]
fn client_app_040_one_notification_per_server_task_across_tabs_and_windows() {
    let mut policy = NotifyPolicy::new();
    let task = request(FIRST_ID, Some("t1"), "Review the plan");
    let Decision::Raise {
        title,
        subtitle,
        user_info,
        ..
    } = policy.decide(&task, nothing_focused(), Permission::Granted, T0)
    else {
        panic!("expected a raise");
    };
    assert_eq!(title, "Review the plan");
    assert_eq!(subtitle, "Work");
    assert_eq!(user_info.server_id, FIRST_ID);
    assert_eq!(user_info.task_id.as_deref(), Some("t1"));

    assert_eq!(
        policy.decide(&task, nothing_focused(), Permission::Granted, T0 + 1),
        Decision::Suppress(Reason::Duplicate)
    );
    assert_eq!(
        policy.decide(
            &task,
            nothing_focused(),
            Permission::Granted,
            T0 + DEDUPE_SECS - 1
        ),
        Decision::Suppress(Reason::Duplicate)
    );

    let other_task = request(FIRST_ID, Some("t2"), "Review the plan");
    let other_server = request(SECOND_ID, Some("t1"), "Review the plan");
    let no_task = request(FIRST_ID, None, "Review the plan");
    for different in [&other_task, &other_server, &no_task] {
        assert!(is_raise(&policy.decide(
            different,
            nothing_focused(),
            Permission::Granted,
            T0 + 2
        )));
    }

    assert!(is_raise(&policy.decide(
        &task,
        nothing_focused(),
        Permission::Granted,
        T0 + DEDUPE_SECS
    )));
}

#[test]
fn client_app_040_requests_are_capped_and_user_info_carries_only_ids() {
    let long = "x".repeat(TITLE_MAX_CHARS + 50);
    let capped = NotifyRequest::parse(id(FIRST_ID), "Work", Some("t1"), &long).unwrap();
    let mut policy = NotifyPolicy::new();
    let Decision::Raise { title, .. } =
        policy.decide(&capped, nothing_focused(), Permission::Granted, T0)
    else {
        panic!("expected a raise");
    };
    assert_eq!(title.chars().count(), TITLE_MAX_CHARS);

    let controls = NotifyRequest::parse(id(FIRST_ID), "Wo\nrk", Some("t9"), "a\u{0}b").unwrap();
    let Decision::Raise {
        title, subtitle, ..
    } = policy.decide(&controls, nothing_focused(), Permission::Granted, T0)
    else {
        panic!("expected a raise");
    };
    assert_eq!((title.as_str(), subtitle.as_str()), ("ab", "Work"));

    for bad in ["", "a b", "../x", &"a".repeat(65)] {
        assert_eq!(
            NotifyRequest::parse(id(FIRST_ID), "Work", Some(bad), "Title"),
            Err(InputError::TaskId)
        );
    }
    assert_eq!(
        NotifyRequest::parse(id(FIRST_ID), "Work", Some("t1"), "\n"),
        Err(InputError::NotificationTitle)
    );
}

#[test]
fn client_app_042_a_click_opens_the_task_tab_or_selects_home() {
    let open = |_| true;
    assert_eq!(
        route_click(FIRST_ID, Some("t1"), open),
        Click::Focus {
            server: id(FIRST_ID),
            tab: Target::Task("t1".to_owned())
        }
    );
    for task in [None, Some("../bad id")] {
        assert_eq!(
            route_click(FIRST_ID, task, open),
            Click::Focus {
                server: id(FIRST_ID),
                tab: Target::Home
            }
        );
    }
}

#[test]
fn client_app_042_a_click_for_a_server_without_a_window_is_ignored() {
    let only_second = |server: ServerId| server == id(SECOND_ID);
    assert_eq!(
        route_click(FIRST_ID, Some("t1"), only_second),
        Click::Ignore
    );
    assert_eq!(route_click("not-a-server", None, |_| true), Click::Ignore);
}

#[tokio::test]
async fn client_app_043_expired_state_is_shown_and_cleared_by_signing_in() {
    let server = id(FIRST_ID);
    let harness = harness(
        [Ok(Canned::json(
            401,
            r#"{"error":{"code":"unauthorized","message":"x"}}"#,
        ))],
        servers_file(&[
            (FIRST_ID, "Alpha", "https://board.example.test/"),
            (SECOND_ID, "Beta", "http://localhost:4000/"),
        ]),
        true,
    );
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    assert_eq!(
        expiry_banner(server, harness.bridge.is_expired(server)),
        Banner { server, text: None }
    );
    harness
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert_eq!(
        expiry_banner(server, harness.bridge.is_expired(server)),
        Banner {
            server,
            text: Some(EXPIRED_BANNER)
        }
    );
    let second = id(SECOND_ID);
    assert_eq!(
        expiry_banner(second, harness.bridge.is_expired(second)),
        Banner {
            server: second,
            text: None
        }
    );
    assert_eq!(expiry_banner(server, false), Banner { server, text: None });

    let mut policy = NotifyPolicy::new();
    let task = request(FIRST_ID, Some("t1"), "Review the plan");
    assert!(is_raise(&policy.decide(
        &task,
        nothing_focused(),
        Permission::Granted,
        T0
    )));
}

fn throttled(server: &str) -> Change {
    Change {
        server: id(server),
        state: State::Throttled,
    }
}

#[test]
fn client_app_050_missed_heartbeats_of_a_hidden_window_start_attention_polling() {
    let server = id(FIRST_ID);
    let mut throttle = Throttle::new();
    let mut poller = AttentionPoller::new();
    assert_eq!(throttle.set_hidden(server, true, T0), None);

    assert!(throttle.tick(T0 + SILENCE_SECS - 1).is_empty());
    assert_eq!(throttle.tick(T0 + SILENCE_SECS), vec![throttled(FIRST_ID)]);
    assert!(throttle.is_throttled(server));
    assert!(throttle.tick(T0 + SILENCE_SECS + BEAT_SECS).is_empty());

    poller.start(server, T0 + SILENCE_SECS);
    assert_eq!(poller.due(T0 + SILENCE_SECS), vec![server]);
    assert!(poller.due(T0 + SILENCE_SECS + POLL_SECS - 1).is_empty());
    assert_eq!(poller.due(T0 + SILENCE_SECS + POLL_SECS), vec![server]);

    let beat = T0 + SILENCE_SECS + POLL_SECS + 1;
    assert_eq!(
        throttle.heartbeat(server, beat),
        Some(Change {
            server,
            state: State::Live
        })
    );
    poller.stop(server);
    assert!(!poller.is_polling(server));
    assert!(poller.due(beat + 10 * POLL_SECS).is_empty());
}

#[test]
fn client_app_050_the_silence_threshold_tolerates_a_stretched_beat_cadence() {
    let stretched = BEAT_SECS * 2;
    assert!(SILENCE_SECS >= 3 * stretched);
    let server = id(FIRST_ID);
    let mut throttle = Throttle::new();
    throttle.set_hidden(server, true, T0);
    for step in 1..=20 {
        let now = T0 + step * stretched;
        assert_eq!(throttle.heartbeat(server, now), None);
        assert!(throttle.tick(now).is_empty());
    }
}

#[test]
fn client_app_050_a_visible_window_is_never_throttled_and_showing_it_goes_live() {
    let server = id(FIRST_ID);
    let mut throttle = Throttle::new();
    throttle.heartbeat(server, T0);
    assert!(throttle.tick(T0 + 10 * SILENCE_SECS).is_empty());

    throttle.set_hidden(server, true, T0 + 100);
    assert_eq!(
        throttle.tick(T0 + 100 + SILENCE_SECS),
        vec![throttled(FIRST_ID)]
    );
    assert_eq!(
        throttle.set_hidden(server, false, T0 + 200),
        Some(Change {
            server,
            state: State::Live
        })
    );
    assert!(throttle.tick(T0 + 200 + 10 * SILENCE_SECS).is_empty());

    throttle.forget(server);
    assert!(!throttle.is_throttled(server));
}

#[test]
fn client_app_050_new_attention_ids_raise_the_generic_text() {
    let server = id(FIRST_ID);
    let mut poller = AttentionPoller::new();
    let ids = |list: &[&str]| {
        list.iter()
            .map(|text| (*text).to_owned())
            .collect::<Vec<_>>()
    };

    poller.start(server, T0);
    assert!(poller.observe(server, "Work", &ids(&["t1"])).is_empty());

    let raised = poller.observe(server, "Work", &ids(&["t1", "t2", "t3", "t3", "bad id"]));
    let mut policy = NotifyPolicy::new();
    let decisions: Vec<Decision> = raised
        .iter()
        .map(|request| policy.decide(request, nothing_focused(), Permission::Granted, T0))
        .collect();
    assert_eq!(decisions.len(), 2);
    for (decision, task) in decisions.iter().zip(["t2", "t3"]) {
        let Decision::Raise {
            title,
            subtitle,
            user_info,
            ..
        } = decision
        else {
            panic!("expected a raise");
        };
        assert_eq!(title, "A task needs you on Work");
        assert_eq!(subtitle, "Work");
        assert_eq!(user_info.task_id.as_deref(), Some(task));
        assert_eq!(user_info.server_id, FIRST_ID);
    }

    assert!(
        poller
            .observe(server, "Work", &ids(&["t1", "t2", "t3"]))
            .is_empty()
    );
    assert_eq!(poller.observe(server, "Work", &ids(&["t2"])).len(), 0);
    assert_eq!(poller.observe(server, "Work", &ids(&["t2", "t3"])).len(), 1);
}

#[test]
fn client_app_050_a_stopped_poller_forgets_its_baseline_and_caps_the_ids() {
    let server = id(FIRST_ID);
    let mut poller = AttentionPoller::new();
    let ids = |list: &[&str]| {
        list.iter()
            .map(|text| (*text).to_owned())
            .collect::<Vec<_>>()
    };

    assert!(poller.observe(server, "Work", &ids(&["t1"])).is_empty());

    poller.start(server, T0);
    poller.observe(server, "Work", &ids(&["t1"]));
    poller.stop(server);

    poller.start(server, T0 + 500);
    assert!(
        poller
            .observe(server, "Work", &ids(&["t1", "t2"]))
            .is_empty()
    );
    assert_eq!(
        poller
            .observe(server, "Work", &ids(&["t1", "t2", "t3"]))
            .len(),
        1
    );

    let many: Vec<String> = (0..MAX_IDS_PER_POLL * 3).map(|n| format!("n{n}")).collect();
    assert_eq!(
        poller.observe(server, "Work", &many).len(),
        MAX_IDS_PER_POLL
    );
}

#[test]
fn client_app_016_a_live_hidden_window_does_not_poll() {
    let server = id(FIRST_ID);
    let mut throttle = Throttle::new();
    let mut poller = AttentionPoller::new();
    throttle.set_hidden(server, true, T0);

    let stretched = BEAT_SECS * 4 / 3 + 1;
    let mut now = T0;
    for _ in 0..180 {
        now += stretched;
        throttle.heartbeat(server, now);
        for change in throttle.tick(now) {
            poller.start(change.server, now);
        }
        assert!(poller.due(now).is_empty());
    }
    assert!(!throttle.is_throttled(server));
    assert!(!poller.is_polling(server));
}

#[test]
fn client_app_045_zoom_steps_through_the_ladder_per_server_and_resets_at_launch() {
    let first = id(FIRST_ID);
    let second = id(SECOND_ID);
    let mut zoom = Zoom::new();
    assert_eq!(zoom.percent(first), 100);

    assert_eq!(
        zoom.zoom_in(first),
        Some(Effect::Zoom {
            server: first,
            factor: 1.1
        })
    );
    assert_eq!(
        zoom.zoom_in(first),
        Some(Effect::Zoom {
            server: first,
            factor: 1.25
        })
    );
    assert_eq!(zoom.percent(second), 100);
    assert_eq!(
        zoom.zoom_out(second),
        Some(Effect::Zoom {
            server: second,
            factor: 0.9
        })
    );
    assert_eq!(zoom.percent(first), 125);

    assert_eq!(
        zoom.reset(first),
        Some(Effect::Zoom {
            server: first,
            factor: 1.0
        })
    );
    assert_eq!(zoom.reset(first), None);

    while zoom.zoom_in(first).is_some() {}
    assert_eq!(zoom.percent(first), 500);
    assert_eq!(zoom.zoom_in(first), None);
    while zoom.zoom_out(first).is_some() {}
    assert_eq!(zoom.percent(first), 25);
    assert_eq!(zoom.zoom_out(first), None);
    assert_eq!(LADDER.len(), 17);

    let relaunched = Zoom::new();
    assert_eq!(relaunched.percent(first), 100);
    assert_eq!(relaunched.percent(second), 100);

    zoom.forget(first);
    assert_eq!(zoom.percent(first), 100);
}

#[test]
fn client_app_040_the_dedupe_window_is_bounded_by_dropping_the_oldest_entry() {
    let mut policy = NotifyPolicy::new();
    for index in 0..MAX_TRACKED {
        let task = format!("t{index}");
        let decision = policy.decide(
            &request(FIRST_ID, Some(&task), "Title"),
            nothing_focused(),
            Permission::Granted,
            T0 + u64::from(index > 0),
        );
        assert!(is_raise(&decision));
    }
    let newest = request(FIRST_ID, Some("extra"), "Title");
    assert!(is_raise(&policy.decide(
        &newest,
        nothing_focused(),
        Permission::Granted,
        T0 + 2
    )));
    assert_eq!(
        policy.decide(&newest, nothing_focused(), Permission::Granted, T0 + 3),
        Decision::Suppress(Reason::Duplicate)
    );
    let evicted = request(FIRST_ID, Some("t0"), "Title");
    assert!(is_raise(&policy.decide(
        &evicted,
        nothing_focused(),
        Permission::Granted,
        T0 + 4
    )));
}

#[test]
fn client_app_050_a_heartbeat_or_showing_the_window_stops_the_attention_poll() {
    let server = id(FIRST_ID);
    let mut watch = Watch::new();
    watch.set_hidden(server, true, T0);
    assert_eq!(watch.tick(T0 + SILENCE_SECS - 1), Tick::default());

    let tick = watch.tick(T0 + SILENCE_SECS);
    assert_eq!(tick.logs, vec![(server, LogEvent::Throttled)]);
    assert_eq!(tick.polls, vec![server]);
    assert!(watch.is_polling(server));
    assert!(watch.tick(T0 + SILENCE_SECS + 1).polls.is_empty());

    watch.heartbeat(server, T0 + SILENCE_SECS + 2);
    assert!(!watch.is_polling(server));
    assert_eq!(watch.tick(T0 + SILENCE_SECS + 3), Tick::default());

    watch.set_hidden(server, true, T0 + 100);
    watch.tick(T0 + 100 + SILENCE_SECS);
    assert!(watch.is_polling(server));
    watch.set_hidden(server, false, T0 + 200);
    assert!(!watch.is_polling(server));

    watch.set_hidden(server, true, T0 + 300);
    watch.tick(T0 + 300 + SILENCE_SECS);
    watch.forget(server);
    assert!(!watch.is_polling(server));
}

#[tokio::test]
async fn client_app_050_the_attention_route_goes_through_the_pipeline_with_the_token() {
    let server = id(FIRST_ID);
    let harness = harness(
        [Ok(Canned::json(
            200,
            r#"{"tasks":[{"id":"t1","projectId":"p","since":"2026-01-01T00:00:00Z"},{"id":"t2","projectId":"p","since":"2026-01-01T00:00:00Z"}]}"#,
        ))],
        servers_file(&[(FIRST_ID, "Alpha", "https://board.example.test/")]),
        true,
    );
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    let ids = harness
        .bridge
        .attention(server, &harness.secrets)
        .await
        .unwrap();
    assert_eq!(ids, vec!["t1".to_owned(), "t2".to_owned()]);
    let sent = harness.http.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].method, "GET");
    assert!(sent[0].url.ends_with("/api/client/attention"));
    assert_eq!(
        sent[0].header("authorization"),
        Some(format!("Bearer {}", token()).as_str())
    );
}

#[tokio::test]
async fn client_app_050_an_unauthorised_attention_poll_marks_the_server_expired() {
    let server = id(FIRST_ID);
    let harness = harness(
        [Ok(Canned::json(
            401,
            r#"{"error":{"code":"unauthorized","message":"x"}}"#,
        ))],
        servers_file(&[(FIRST_ID, "Alpha", "https://board.example.test/")]),
        true,
    );
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    assert!(
        harness
            .bridge
            .attention(server, &harness.secrets)
            .await
            .is_err()
    );
    assert!(harness.bridge.is_expired(server));
}

#[test]
fn client_app_045_zoom_menu_items_step_the_key_servers_ladder() {
    assert_eq!(from_menu_id(MENU_ZOOM_IN), Some(Step::In));
    assert_eq!(from_menu_id(MENU_ZOOM_IN_SHIFTED), Some(Step::In));
    assert_eq!(from_menu_id(MENU_ZOOM_OUT), Some(Step::Out));
    assert_eq!(from_menu_id(MENU_ZOOM_RESET), Some(Step::Reset));
    assert_eq!(from_menu_id("close-tab"), None);

    let server = id(FIRST_ID);
    let mut zoom = Zoom::new();
    assert_eq!(
        zoom.apply(server, Step::In),
        Some(Effect::Zoom {
            server,
            factor: 1.1
        })
    );
    assert_eq!(
        zoom.apply(server, Step::Out),
        Some(Effect::Zoom {
            server,
            factor: 1.0
        })
    );
    assert_eq!(zoom.apply(server, Step::Reset), None);
}
