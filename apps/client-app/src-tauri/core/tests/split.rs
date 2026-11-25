use agent_board_client_core::layout::{self, Bounds};
use agent_board_client_core::shortcuts::Action;
use agent_board_client_core::tab_file;
use agent_board_client_core::tabs::{
    Effect, HOME, MAX_PANES, MAX_TABS, MIN_PANE_FRACTION, TabId, Tabs,
};
use serde_json::{Value, json};

fn opened(paths: &[&str]) -> Tabs {
    let mut tabs = Tabs::new();
    for path in paths {
        tabs.open(path);
    }
    tabs
}

fn ids(tabs: &Tabs, pane: usize) -> Vec<TabId> {
    tabs.pane_tabs(pane).iter().map(|tab| tab.id).collect()
}

fn selected_of(tabs: &Tabs) -> Vec<TabId> {
    tabs.view().iter().map(|pane| pane.selected).collect()
}

fn page_paths(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| format!("/tasks/t-{index}"))
        .collect()
}

fn full(count: usize) -> Tabs {
    let paths = page_paths(count);
    let mut tabs = Tabs::new();
    for path in &paths {
        tabs.open(path);
    }
    tabs
}

fn restored(body: &Value) -> Tabs {
    tab_file::decode(body.to_string().as_bytes()).unwrap()
}

#[test]
fn client_app_029_splits_moves_and_closes_panes_within_the_tab_limit() {
    let mut tabs = opened(&["/backlog", "/schedules", "/closed"]);
    assert_eq!(tabs.selected(), 3);

    let effects = tabs.split_tab();
    assert!(effects.contains(&Effect::Show(2)));
    assert_eq!(effects[effects.len() - 4], Effect::Show(3));
    assert!(effects.contains(&Effect::Layout));
    assert_eq!(tabs.pane_count(), 2);
    assert_eq!(tabs.focused(), 1);
    assert_eq!(tabs.split(), [0.5]);
    assert_eq!(ids(&tabs, 0), vec![HOME, 1, 2]);
    assert_eq!(ids(&tabs, 1), vec![3]);
    assert_eq!(selected_of(&tabs), vec![2, 3]);

    assert_eq!(tabs.split_tab(), vec![], "a pane with one tab cannot split");

    tabs.select(1);
    assert_eq!(tabs.focused(), 0);
    tabs.split_tab();
    assert_eq!(ids(&tabs, 0), vec![HOME, 2]);
    assert_eq!(ids(&tabs, 1), vec![1]);
    assert_eq!(ids(&tabs, 2), vec![3]);
    assert_eq!(tabs.split(), [0.25, 0.5]);
    assert_eq!(tabs.focused(), 1);

    assert_eq!(tabs.move_tab(HOME, 2), vec![], "home stays in pane 0");
    assert_eq!(tabs.split_tab(), vec![]);
    tabs.select(HOME);
    assert_eq!(tabs.split_tab(), vec![], "home never leaves pane 0");

    tabs.select(2);
    let moved = tabs.move_tab(2, 1);
    assert!(moved.contains(&Effect::Show(HOME)));
    assert!(moved.contains(&Effect::Hide(1)));
    assert_eq!(ids(&tabs, 0), vec![HOME]);
    assert_eq!(ids(&tabs, 1), vec![1, 2]);
    assert_eq!(tabs.focused(), 1);
    assert_eq!(selected_of(&tabs), vec![HOME, 2, 3]);

    let closed = tabs.close_pane(1);
    assert_eq!(
        closed,
        vec![
            Effect::Hide(2),
            Effect::Show(HOME),
            Effect::Layout,
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    );
    assert_eq!(ids(&tabs, 0), vec![HOME, 1, 2]);
    assert_eq!(ids(&tabs, 1), vec![3]);
    assert_eq!(tabs.split(), [0.5]);
    assert_eq!(tabs.focused(), 0);
    assert_eq!(tabs.close_pane(0), vec![], "pane 0 holds home and stays");

    let emptied = tabs.close(3);
    assert!(emptied.contains(&Effect::Close(3)));
    assert_eq!(tabs.pane_count(), 1);
    assert_eq!(tabs.split(), [] as [f64; 0]);
    assert_eq!(tabs.focused(), 0);
}

#[test]
fn client_app_029_the_twenty_tab_limit_counts_every_pane() {
    let mut tabs = full(MAX_TABS);
    tabs.split_tab();
    assert_eq!(tabs.pane_count(), 2);
    assert_eq!(tabs.open("/backlog"), vec![Effect::LimitReached]);
    tabs.select(HOME);
    assert_eq!(tabs.open("/backlog"), vec![Effect::LimitReached]);
    let focused_before = tabs.focused();
    let existing = tabs.open("/tasks/t-19");
    assert!(existing.contains(&Effect::Show(20)));
    assert_ne!(tabs.focused(), focused_before);
    assert_eq!(tabs.focused(), 1);

    let restored = restored(&json!({
        "v": 1,
        "panes": [
            {"tabs": page_paths(12), "selected": 0},
            {"tabs": (12..30).map(|index| format!("/tasks/t-{index}")).collect::<Vec<_>>(), "selected": 1},
        ],
        "split": [0.5],
        "focused": 0,
    }));
    let total: usize = (0..restored.pane_count())
        .map(|pane| restored.pane_tabs(pane).len())
        .sum();
    assert_eq!(total, MAX_TABS + 1);
}

#[test]
fn client_app_029_panes_are_capped_and_actions_reach_the_pane_model() {
    let mut tabs = full(8);
    for _ in 0..MAX_PANES + 2 {
        tabs.split_tab();
        if let Some(first) = tabs.pane_tabs(0).get(1).map(|tab| tab.id) {
            tabs.select(first);
        }
    }
    assert_eq!(tabs.pane_count(), MAX_PANES);
    assert!(
        tabs.split()
            .windows(2)
            .all(|pair| pair[1] - pair[0] >= MIN_PANE_FRACTION)
    );

    let mut tabs = opened(&["/backlog", "/closed"]);
    assert!(tabs.apply(Action::SplitTab).contains(&Effect::Layout));
    assert_eq!(tabs.focused(), 1);
    assert!(!tabs.apply(Action::FocusNextPane).is_empty());
    assert_eq!(tabs.focused(), 0);
    tabs.apply(Action::FocusNextPane);
    assert!(tabs.apply(Action::MoveTab).contains(&Effect::Layout));
    assert_eq!(
        tabs.pane_count(),
        1,
        "moving the only tab of a pane drops the pane"
    );
    tabs.apply(Action::SplitTab);
    assert_eq!(tabs.apply(Action::ClosePane).len(), 5);
    assert_eq!(tabs.pane_count(), 1);
}

#[test]
fn client_app_029_dividers_clamp_and_commit_only_when_released() {
    let mut tabs = full(6);
    tabs.split_tab();
    tabs.select(1);
    tabs.split_tab();
    assert_eq!(tabs.split(), [0.25, 0.5]);

    assert_eq!(
        tabs.resize(0, 0.3, false),
        vec![Effect::Layout, Effect::UpdateBar]
    );
    assert_eq!(
        tabs.resize(0, 0.35, true),
        vec![Effect::Layout, Effect::UpdateBar, Effect::WriteTabFile]
    );
    assert_eq!(tabs.split(), [0.35, 0.5]);

    tabs.resize(0, 0.99, true);
    assert!((tabs.split()[0] - (0.5 - MIN_PANE_FRACTION)).abs() < 1e-9);
    tabs.resize(1, 0.0, true);
    assert!((tabs.split()[1] - (tabs.split()[0] + MIN_PANE_FRACTION)).abs() < 1e-9);
    tabs.resize(1, 5.0, true);
    assert!((tabs.split()[1] - (1.0 - MIN_PANE_FRACTION)).abs() < 1e-9);

    assert_eq!(tabs.resize(5, 0.5, true), vec![]);
    assert_eq!(tabs.resize(0, f64::NAN, true), vec![]);
    let before = tabs.split().to_vec();
    assert_eq!(tabs.resize(1, before[1], false), vec![]);
    assert_eq!(tabs.resize(1, before[1], true), vec![Effect::WriteTabFile]);
}

#[test]
fn client_app_029_panes_share_the_window_by_their_ratios() {
    let first = layout::pane_page(1000.0, 800.0, &[0.25, 0.5], 0);
    let middle = layout::pane_page(1000.0, 800.0, &[0.25, 0.5], 1);
    let last = layout::pane_page(1000.0, 800.0, &[0.25, 0.5], 2);
    let expect = |x: f64, width: f64| Bounds {
        x,
        y: layout::TAB_BAR_HEIGHT,
        width,
        height: 800.0 - layout::TAB_BAR_HEIGHT,
    };
    assert_eq!(first, expect(0.0, 250.0));
    assert_eq!(middle, expect(250.0, 250.0));
    assert_eq!(last, expect(500.0, 500.0));
    assert_eq!(layout::pane_page(900.0, 600.0, &[], 0), expect_single());
}

fn expect_single() -> Bounds {
    Bounds {
        x: 0.0,
        y: layout::TAB_BAR_HEIGHT,
        width: 900.0,
        height: 600.0 - layout::TAB_BAR_HEIGHT,
    }
}

fn loaded_paths(tabs: &Tabs) -> Vec<String> {
    (0..tabs.pane_count())
        .flat_map(|pane| tabs.pane_tabs(pane))
        .filter(|tab| tab.loaded)
        .map(|tab| tab.path.clone())
        .collect()
}

fn selected_paths(tabs: &Tabs) -> Vec<String> {
    let chosen = selected_of(tabs);
    (0..tabs.pane_count())
        .flat_map(|pane| tabs.pane_tabs(pane))
        .filter(|tab| chosen.contains(&tab.id))
        .map(|tab| tab.path.clone())
        .collect()
}

fn paths_of(tabs: &Tabs, pane: usize) -> Vec<String> {
    tabs.pane_tabs(pane)
        .iter()
        .map(|tab| tab.path.clone())
        .collect()
}

#[test]
fn client_app_029_layout_round_trips_through_the_tab_file() {
    let mut tabs = opened(&[
        "/backlog",
        "/tasks/t-1?transcript=1",
        "/schedules",
        "/closed",
        "/settings",
    ]);
    tabs.split_tab();
    tabs.select(2);
    tabs.split_tab();
    tabs.resize(0, 0.3, true);
    tabs.select(HOME);
    tabs.focus_pane(1);

    let bytes = tab_file::encode(&tabs);
    let file: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(file["v"], 1);
    assert_eq!(file["panes"].as_array().unwrap().len(), 3);
    assert_eq!(file["panes"][0]["tabs"][0], "/backlog");
    assert_eq!(file["split"], json!([0.3, 0.5]));
    assert_eq!(file["focused"], 1);
    assert!(!file.to_string().contains("Backlog"));

    let again = tab_file::decode(&bytes).unwrap();
    assert_eq!(again.layout().split, tabs.layout().split);
    assert_eq!(again.focused(), tabs.focused());
    assert_eq!(again.pane_count(), 3);
    for pane in 0..3 {
        assert_eq!(paths_of(&again, pane), paths_of(&tabs, pane));
    }
    assert_eq!(selected_paths(&again), selected_paths(&tabs));
    assert_eq!(loaded_paths(&again), selected_paths(&tabs));
    assert_eq!(tab_file::encode(&again), bytes);
    assert!(again.start().len() >= 6);
}

#[test]
fn client_app_029_restore_validates_ratios_and_drops_empty_panes() {
    let body = |split: Value| {
        json!({
            "v": 1,
            "panes": [
                {"tabs": ["/backlog"], "selected": 0},
                {"tabs": ["/schedules", "/closed"], "selected": 2},
                {"tabs": ["/settings"], "selected": 1},
            ],
            "split": split,
            "focused": 2,
        })
    };

    let kept = restored(&body(json!([0.2, 0.6])));
    assert_eq!(kept.split(), [0.2, 0.6]);
    assert_eq!(kept.focused(), 2);
    assert_eq!(selected_of(&kept)[1], kept.pane_tabs(1)[1].id);

    for bad in [
        json!([0.6, 0.2]),
        json!([0.05, 0.6]),
        json!([0.2, 0.95]),
        json!([0.5]),
        json!([0.2, "x"]),
        json!("wide"),
        json!(null),
        json!([-1.0, 2.0]),
    ] {
        assert_eq!(restored(&body(bad)).split(), [1.0 / 3.0, 2.0 / 3.0]);
    }

    let dropped = restored(&json!({
        "v": 1,
        "panes": [
            {"tabs": ["/backlog"], "selected": 1},
            {"tabs": ["/", "//evil", "/unknown"], "selected": 1},
            {"tabs": ["/backlog", "/closed"], "selected": 0},
            {"tabs": [], "selected": 0},
        ],
        "split": [0.2, 0.5, 0.8],
        "focused": 1,
    }));
    assert_eq!(dropped.pane_count(), 2);
    assert_eq!(paths_of(&dropped, 1), vec!["/closed"]);
    assert_eq!(dropped.split(), [0.5]);
    assert_eq!(dropped.focused(), 0, "a dropped pane cannot stay focused");
    assert_eq!(selected_of(&dropped)[1], dropped.pane_tabs(1)[0].id);

    let crowded = restored(&json!({
        "v": 1,
        "panes": (0..8)
            .map(|index| json!({"tabs": [format!("/tasks/t-{index}")], "selected": 1}))
            .collect::<Vec<_>>(),
        "split": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        "focused": 99,
    }));
    assert_eq!(crowded.pane_count(), MAX_PANES);
    assert_eq!(crowded.focused(), 0);
    assert_eq!(crowded.split(), [0.1, 0.2, 0.3]);

    let single = restored(&json!({"v": 1, "panes": [{"tabs": ["/backlog"], "selected": 1}]}));
    assert_eq!(single.pane_count(), 1);
    assert!(single.split().is_empty());
    assert_eq!(
        tab_file::decode(br#"{"v":1,"panes":[],"split":7,"focused":-3}"#)
            .unwrap()
            .pane_count(),
        1
    );
}
