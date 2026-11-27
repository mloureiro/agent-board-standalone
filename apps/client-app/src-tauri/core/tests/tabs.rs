use rumo_client_core::shortcuts::{
    Action, Key, MENU_CLOSE_TAB, MENU_NEXT_TAB, MENU_PREVIOUS_TAB, from_key, from_menu_id,
    menu_select_id,
};
use rumo_client_core::tabs::{
    Effect, HOME, MAX_LABEL_CHARS, MAX_TABS, Page, Route, TabId, Tabs, classify, label_from_title,
};

fn opened(paths: &[&str]) -> Tabs {
    let mut tabs = Tabs::new();
    for path in paths {
        tabs.open(path);
    }
    tabs
}

fn ids(tabs: &Tabs) -> Vec<TabId> {
    tabs.tabs().iter().map(|tab| tab.id).collect()
}

fn paths(tabs: &Tabs) -> Vec<String> {
    tabs.tabs().iter().map(|tab| tab.path.clone()).collect()
}

fn create(tab: TabId, path: &str) -> Effect {
    Effect::CreateWebview {
        tab,
        path: path.to_owned(),
    }
}

#[test]
fn client_app_017_home_never_closes_and_never_leaves_the_board() {
    let mut tabs = opened(&["/backlog"]);
    assert_eq!(
        tabs.select(HOME),
        vec![
            Effect::Hide(1),
            Effect::Show(HOME),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );

    assert_eq!(tabs.close(HOME), vec![]);
    assert_eq!(tabs.middle_close(HOME), vec![]);
    assert_eq!(tabs.close_selected(), vec![]);
    assert_eq!(tabs.apply(Action::CloseTab), vec![]);
    assert_eq!(tabs.selected(), HOME);
    assert_eq!(ids(&tabs), vec![HOME, 1]);

    let effects = tabs.route(HOME, "/tasks/abc");
    assert_eq!(
        effects[0],
        Effect::Navigate {
            tab: HOME,
            path: "/".to_owned(),
        }
    );
    assert!(effects.contains(&create(2, "/tasks/abc")));
    assert_eq!(tabs.tabs()[0].path, "/");
    assert_eq!(tabs.selected(), 2);

    let mut only_home = Tabs::new();
    assert_eq!(only_home.close_selected(), vec![]);
    assert_eq!(only_home.view()[0].tabs.len(), 1);
    assert!(only_home.view()[0].tabs[0].home);
}

#[test]
fn client_app_018_leaving_home_opens_a_tab_or_selects_the_existing_one() {
    let mut tabs = Tabs::new();
    for (index, path) in [
        "/backlog",
        "/schedules",
        "/closed",
        "/settings",
        "/tasks/t-1",
    ]
    .iter()
    .enumerate()
    {
        let id = index as TabId + 1;
        assert_eq!(
            tabs.open(path),
            vec![
                create(id, path),
                Effect::Hide(if index == 0 { HOME } else { id - 1 }),
                Effect::Show(id),
                Effect::UpdateBar,
                Effect::WriteTabFile,
            ]
        );
        assert_eq!(tabs.selected(), id);
    }
    assert_eq!(tabs.tabs().len(), 6);

    assert_eq!(
        tabs.open("/backlog"),
        vec![
            Effect::Hide(5),
            Effect::Show(1),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(tabs.tabs().len(), 6);
    assert_eq!(tabs.selected(), 1);

    assert_eq!(tabs.open("/"), tabs_select_home_effects(1));
    assert_eq!(tabs.selected(), HOME);
    assert_eq!(tabs.open("/approve"), vec![]);
    assert_eq!(tabs.open("/tasks/"), vec![]);
    assert_eq!(tabs.open("/tasks/a/b"), vec![]);
    assert_eq!(tabs.open("//evil.example.test/backlog"), vec![]);
    assert_eq!(tabs.open("/backlog\n"), vec![]);
    assert_eq!(tabs.tabs().len(), 6);
}

fn tabs_select_home_effects(from: TabId) -> Vec<Effect> {
    vec![
        Effect::Hide(from),
        Effect::Show(HOME),
        Effect::UpdateBar,
        Effect::WriteTabFile,
    ]
}

#[test]
fn client_app_018_query_does_not_make_a_new_page() {
    let mut tabs = opened(&["/tasks/t-1"]);
    tabs.select(HOME);

    let effects = tabs.open("/tasks/t-1?transcript=1");
    assert_eq!(
        effects,
        vec![
            Effect::Hide(HOME),
            Effect::Show(1),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(tabs.tabs().len(), 2);

    tabs.select(HOME);
    tabs.open("/tasks/t-1/");
    tabs.open("/tasks/t-1#top");
    assert_eq!(tabs.tabs().len(), 2);

    tabs.open("/tasks/t-2");
    assert_eq!(tabs.tabs().len(), 3);
}

#[test]
fn client_app_019_navigation_in_a_tab_is_in_place_and_board_closes_the_tab() {
    let mut tabs = opened(&["/backlog", "/tasks/t-1"]);

    assert_eq!(
        tabs.route(2, "/tasks/t-1?transcript=1"),
        vec![Effect::WriteTabFile]
    );
    assert_eq!(tabs.route(2, "/tasks/t-1?transcript=1"), vec![]);
    assert_eq!(tabs.tabs().len(), 3);

    tabs.title(2, "Fix login · Rumo");
    assert_eq!(
        tabs.route(2, "/schedules"),
        vec![Effect::UpdateBar, Effect::WriteTabFile]
    );
    assert_eq!(tabs.tabs()[2].path, "/schedules");
    assert_eq!(tabs.tabs()[2].label, "Schedules");
    assert_eq!(tabs.tabs().len(), 3);

    assert_eq!(
        tabs.route(2, "/"),
        vec![
            Effect::Close(2),
            Effect::Show(HOME),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(ids(&tabs), vec![HOME, 1]);
    assert_eq!(tabs.selected(), HOME);

    assert_eq!(tabs.route(99, "/"), vec![]);
    assert_eq!(tabs.route(HOME, "/"), vec![]);
}

#[test]
fn client_app_019_cmd_click_opens_a_new_tab_from_any_tab() {
    let mut tabs = opened(&["/backlog", "/tasks/t-1"]);
    tabs.select(1);

    let effects = tabs.open("/closed");
    assert_eq!(effects[0], create(3, "/closed"));
    assert_eq!(tabs.selected(), 3);
    assert_eq!(paths(&tabs), vec!["/", "/backlog", "/tasks/t-1", "/closed"]);

    tabs.select(HOME);
    tabs.open("/settings");
    assert_eq!(tabs.tabs().len(), 5);
    assert_eq!(tabs.tabs()[4].path, "/settings");
}

#[test]
fn client_app_020_sign_in_and_expiry_pages_stay_in_their_tab() {
    for path in [
        "/approve",
        "/approve?code=1",
        "/auth/login",
        "/auth/expired",
        "/unknown",
        "/settings/profile",
        "/backlogs",
    ] {
        assert_eq!(classify(path), Route::Stay, "{path}");
        let mut tabs = opened(&["/tasks/t-1"]);
        assert_eq!(tabs.route(1, path), vec![], "{path}");
        assert_eq!(tabs.tabs().len(), 2);
        assert_eq!(tabs.tabs()[1].path, "/tasks/t-1");
        assert_eq!(tabs.selected(), 1);

        assert_eq!(tabs.route(HOME, path), vec![], "{path}");
        assert_eq!(tabs.tabs()[0].path, "/");
        assert_eq!(tabs.tabs().len(), 2);
    }
    assert_eq!(classify("/"), Route::Home);
    assert_eq!(classify("/?x=1"), Route::Home);
    assert_eq!(classify("/tasks/a_b-9"), Route::Page(Page::Task));
    assert_eq!(classify("/settings/"), Route::Page(Page::Settings));
}

#[test]
fn client_app_021_a_twenty_first_tab_does_not_open() {
    let mut tabs = Tabs::new();
    for number in 0..MAX_TABS {
        let effects = tabs.open(&format!("/tasks/t-{number}"));
        assert!(effects.contains(&Effect::WriteTabFile));
    }
    assert_eq!(tabs.tabs().len(), MAX_TABS + 1);
    let selected = tabs.selected();

    assert_eq!(tabs.open("/tasks/one-more"), vec![Effect::LimitReached]);
    assert_eq!(tabs.tabs().len(), MAX_TABS + 1);
    assert_eq!(tabs.selected(), selected);

    assert_eq!(tabs.open("/tasks/t-0")[0], Effect::Hide(selected));
    assert_eq!(tabs.tabs().len(), MAX_TABS + 1);

    tabs.close(selected);
    assert!(tabs.open("/tasks/one-more").contains(&Effect::WriteTabFile));
    assert_eq!(tabs.open("/tasks/another"), vec![Effect::LimitReached]);
}

#[test]
fn client_app_023_label_strips_the_suffix_caps_at_200_and_falls_back_to_a_path_label() {
    assert_eq!(
        label_from_title("Fix login · Rumo").as_deref(),
        Some("Fix login")
    );
    assert_eq!(
        label_from_title("  Fix login  ").as_deref(),
        Some("Fix login")
    );
    assert_eq!(label_from_title("Rumo"), None);
    assert_eq!(label_from_title(" · Rumo"), None);
    assert_eq!(label_from_title("   "), None);

    let exact = "x".repeat(MAX_LABEL_CHARS);
    assert_eq!(label_from_title(&exact).as_deref(), Some(exact.as_str()));
    let long = format!("{} · Rumo", "é".repeat(MAX_LABEL_CHARS + 50));
    let capped = label_from_title(&long).unwrap();
    assert_eq!(capped.chars().count(), MAX_LABEL_CHARS);
    assert!(capped.ends_with('…'));

    let mut tabs = opened(&["/backlog", "/tasks/t-1"]);
    assert_eq!(tabs.tabs()[1].label, "Backlog");
    assert_eq!(tabs.tabs()[2].label, "Task");
    assert_eq!(tabs.title(2, "Fix login · Rumo"), vec![Effect::UpdateBar]);
    assert_eq!(tabs.tabs()[2].label, "Fix login");
    assert_eq!(tabs.title(2, "Fix login · Rumo"), vec![]);
    assert_eq!(tabs.title(2, "Rumo"), vec![Effect::UpdateBar]);
    assert_eq!(tabs.tabs()[2].label, "Task");
    assert_eq!(tabs.title(HOME, "Anything"), vec![]);
    assert_eq!(tabs.title(99, "Anything"), vec![]);
    assert_eq!(tabs.view()[0].tabs[0].label, "Board");
}

#[test]
fn client_app_025_shortcuts_close_select_and_cycle_one_tab_per_press() {
    let mut tabs = opened(&["/backlog", "/schedules", "/closed"]);
    assert_eq!(tabs.selected(), 3);

    assert_eq!(
        tabs.apply(Action::Next),
        vec![
            Effect::Hide(3),
            Effect::Show(HOME),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(tabs.selected(), HOME);
    tabs.apply(Action::Previous);
    assert_eq!(tabs.selected(), 3);
    tabs.apply(Action::Previous);
    assert_eq!(tabs.selected(), 2);
    tabs.apply(Action::Next);
    tabs.apply(Action::Next);
    assert_eq!(tabs.selected(), HOME);

    tabs.apply(Action::Select(3));
    assert_eq!(tabs.selected(), 2);
    tabs.apply(Action::Select(1));
    assert_eq!(tabs.selected(), HOME);
    assert_eq!(tabs.apply(Action::Select(9)), vec![]);
    assert_eq!(tabs.apply(Action::Select(5)), vec![]);
    assert_eq!(tabs.apply(Action::Select(0)), vec![]);
    assert_eq!(tabs.selected(), HOME);

    tabs.select(2);
    let effects = tabs.apply(Action::CloseTab);
    assert_eq!(
        effects,
        vec![
            Effect::Close(2),
            Effect::Show(3),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(tabs.selected(), 3);
    tabs.apply(Action::CloseTab);
    assert_eq!(tabs.selected(), 1);
    tabs.apply(Action::CloseTab);
    assert_eq!(tabs.selected(), HOME);
    assert_eq!(tabs.apply(Action::CloseTab), vec![]);
    assert_eq!(tabs.apply(Action::Next), vec![]);
    assert_eq!(tabs.apply(Action::Previous), vec![]);

    let mut tabs = opened(&["/backlog", "/closed"]);
    assert_eq!(
        tabs.middle_close(1),
        vec![Effect::Close(1), Effect::UpdateBar, Effect::WriteTabFile,]
    );
    assert_eq!(tabs.selected(), 2);

    let key = |text| Key {
        key: text,
        ..Key::default()
    };
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("w")
        }),
        Some(Action::CloseTab)
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("W")
        }),
        Some(Action::CloseTab)
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("1")
        }),
        Some(Action::Select(1))
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("9")
        }),
        Some(Action::Select(9))
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("0")
        }),
        None
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("12")
        }),
        None
    );
    assert_eq!(
        from_key(&Key {
            ctrl: true,
            ..key("Tab")
        }),
        Some(Action::Next)
    );
    assert_eq!(
        from_key(&Key {
            ctrl: true,
            shift: true,
            ..key("Tab")
        }),
        Some(Action::Previous)
    );
    assert_eq!(
        from_key(&Key {
            ctrl: true,
            repeat: true,
            ..key("Tab")
        }),
        None
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            repeat: true,
            ..key("w")
        }),
        None
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            shift: true,
            ..key("w")
        }),
        None
    );
    assert_eq!(
        from_key(&Key {
            meta: true,
            alt: true,
            ..key("1")
        }),
        None
    );
    assert_eq!(from_key(&key("Tab")), None);
    assert_eq!(from_key(&key("w")), None);
    assert_eq!(
        from_key(&Key {
            meta: true,
            ..key("Tab")
        }),
        None
    );

    assert_eq!(from_menu_id(MENU_CLOSE_TAB), Some(Action::CloseTab));
    assert_eq!(from_menu_id(MENU_NEXT_TAB), Some(Action::Next));
    assert_eq!(from_menu_id(MENU_PREVIOUS_TAB), Some(Action::Previous));
    for position in 1..=9 {
        assert_eq!(
            from_menu_id(&menu_select_id(position)),
            Some(Action::Select(position))
        );
    }
    assert_eq!(from_menu_id(&menu_select_id(10)), None);
    assert_eq!(from_menu_id(&menu_select_id(0)), None);
    assert_eq!(from_menu_id("tab-select-x"), None);
    assert_eq!(from_menu_id("quit"), None);
}

#[test]
fn client_app_025_closing_a_tab_loads_an_unloaded_neighbour_only() {
    let mut tabs = Tabs::restore(["/backlog", "/schedules", "/closed"], 0);
    assert_eq!(tabs.selected(), HOME);
    assert_eq!(
        tabs.select(2),
        vec![
            create(2, "/schedules"),
            Effect::Hide(HOME),
            Effect::Show(2),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(
        tabs.close(2),
        vec![
            Effect::Close(2),
            create(3, "/closed"),
            Effect::Show(3),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(tabs.close(1), vec![Effect::UpdateBar, Effect::WriteTabFile]);
    assert_eq!(tabs.selected(), 3);
}

#[test]
fn client_app_019_a_background_tab_reaching_the_board_closes_without_moving_the_selection() {
    let mut tabs = opened(&["/backlog", "/tasks/t-1"]);
    tabs.select(1);

    assert_eq!(
        tabs.route(2, "/"),
        vec![Effect::Close(2), Effect::UpdateBar, Effect::WriteTabFile]
    );
    assert_eq!(tabs.selected(), 1);
    assert_eq!(ids(&tabs), vec![HOME, 1]);
}
