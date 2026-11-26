mod common;

use std::fs;

use agent_board_server_core::activity::Busy;
use agent_board_server_core::backup_desk::BackupView;
use agent_board_server_core::menu::{BADGE, Inputs, ItemId, Menu, TITLE};
use agent_board_server_core::status::{GaveUp, Row, RowState, Status};
use agent_board_server_core::versions::Versions;
use agent_board_server_core::worker::NOT_CONNECTED;

fn status(api: Row, worker: Row) -> Status {
    Status {
        api,
        worker,
        gave_up: GaveUp::default(),
        blocked: None,
    }
}

fn running() -> Status {
    status(
        Row::new(RowState::Running, "Running"),
        Row::new(RowState::Running, "ok"),
    )
}

fn unconnected() -> Status {
    status(
        Row::new(RowState::Running, "Running"),
        Row::new(RowState::Off, NOT_CONNECTED),
    )
}

fn versions() -> Versions {
    Versions {
        app: "1.2.3".to_string(),
        api: "4.5.6".to_string(),
        cli: "7.8.9".to_string(),
    }
}

fn build(status: &Status, request_signature: bool, busy: &[Busy]) -> Menu {
    Menu::build(&Inputs {
        status,
        backup: &BackupView::default(),
        versions: &versions(),
        request_signature,
        busy,
    })
}

fn enabled(menu: &Menu) -> Vec<ItemId> {
    menu.items
        .iter()
        .filter(|item| item.enabled)
        .map(|item| item.id)
        .collect()
}

#[test]
fn server_app_011_the_items_come_in_the_catalogue_order_with_pairing_after_connect() {
    let menu = build(&running(), true, &[]);
    let ids: Vec<ItemId> = menu.items.iter().map(|item| item.id).collect();
    assert_eq!(
        ids,
        [
            ItemId::OpenBoard,
            ItemId::ApiStatus,
            ItemId::WorkerStatus,
            ItemId::LastBackup,
            ItemId::Versions,
            ItemId::RestartServer,
            ItemId::BackUpNow,
            ItemId::RestartWorker,
            ItemId::DisconnectWorker,
            ItemId::CheckWorker,
            ItemId::OpenLogs,
            ItemId::OpenSettings,
            ItemId::ConnectWorker,
            ItemId::PairDevice,
            ItemId::Quit,
        ]
    );
    let labels: Vec<&str> = menu
        .items
        .iter()
        .filter(|item| {
            !matches!(
                item.id,
                ItemId::ApiStatus | ItemId::WorkerStatus | ItemId::LastBackup | ItemId::Versions
            )
        })
        .map(|item| item.label.as_str())
        .collect();
    assert_eq!(
        labels,
        [
            "Open board",
            "Restart server",
            "Back up now",
            "Restart worker",
            "Disconnect worker",
            "Check worker",
            "Open logs folder",
            "Open settings file",
            "Connect worker\u{2026}",
            "Pair a device\u{2026}",
            "Quit",
        ]
    );
}

#[test]
fn server_app_012_open_board_connect_and_backup_follow_the_api_and_worker_items_follow_the_enrolment()
 {
    let api_down = status(
        Row::new(RowState::Starting, "Starting"),
        Row::new(RowState::Off, NOT_CONNECTED),
    );
    assert_eq!(
        enabled(&build(&api_down, true, &[])),
        [
            ItemId::RestartServer,
            ItemId::OpenLogs,
            ItemId::OpenSettings,
            ItemId::Quit
        ]
    );

    assert_eq!(
        enabled(&build(&unconnected(), true, &[])),
        [
            ItemId::OpenBoard,
            ItemId::RestartServer,
            ItemId::BackUpNow,
            ItemId::OpenLogs,
            ItemId::OpenSettings,
            ItemId::ConnectWorker,
            ItemId::PairDevice,
            ItemId::Quit
        ]
    );

    assert_eq!(
        enabled(&build(&running(), true, &[])),
        [
            ItemId::OpenBoard,
            ItemId::RestartServer,
            ItemId::BackUpNow,
            ItemId::RestartWorker,
            ItemId::DisconnectWorker,
            ItemId::CheckWorker,
            ItemId::OpenLogs,
            ItemId::OpenSettings,
            ItemId::ConnectWorker,
            ItemId::PairDevice,
            ItemId::Quit
        ]
    );

    let connected_api_down = status(
        Row::new(RowState::Failed, "Blocked: no space"),
        Row::new(RowState::Starting, "Starting"),
    );
    assert_eq!(
        enabled(&build(&connected_api_down, true, &[])),
        [
            ItemId::RestartServer,
            ItemId::RestartWorker,
            ItemId::DisconnectWorker,
            ItemId::CheckWorker,
            ItemId::OpenLogs,
            ItemId::OpenSettings,
            ItemId::Quit
        ]
    );
}

#[test]
fn server_app_013_every_busy_kind_leaves_only_open_board_connect_and_quit_enabled() {
    for busy in [Busy::Enrolment, Busy::Backup, Busy::Recovery, Busy::Quit] {
        let menu = build(&running(), true, &[busy]);
        assert_eq!(
            enabled(&menu),
            [ItemId::OpenBoard, ItemId::ConnectWorker, ItemId::Quit],
            "{busy:?}"
        );
        assert_eq!(menu.busy, [busy]);
    }
}

#[test]
fn server_app_013_the_busy_lock_does_not_enable_what_the_api_state_disables() {
    let api_down = status(
        Row::new(RowState::Restarting, "Restarting in 1 s"),
        Row::new(RowState::Off, NOT_CONNECTED),
    );
    assert_eq!(
        enabled(&build(&api_down, true, &[Busy::Recovery])),
        [ItemId::Quit]
    );
}

#[test]
fn server_app_090_pairing_needs_the_api_and_the_request_signature() {
    let pair = |status: &Status, signature: bool| {
        build(status, signature, &[])
            .item(ItemId::PairDevice)
            .enabled
    };
    assert!(pair(&running(), true));
    assert!(!pair(&running(), false));
    assert!(!pair(
        &status(
            Row::new(RowState::Starting, "Starting"),
            Row::new(RowState::Off, NOT_CONNECTED)
        ),
        true
    ));
}

#[test]
fn server_app_015_the_first_failing_row_sets_the_mark_and_the_tooltip_and_recovery_clears_them() {
    let healthy = build(&running(), false, &[]);
    assert!(!healthy.badge);
    assert_eq!(healthy.tooltip, TITLE);
    assert_eq!(healthy.to_json()["badge"], serde_json::Value::Null);

    let both = status(
        Row::new(RowState::Failed, "Blocked: the backup folder is full"),
        Row::new(RowState::Failed, "error \u{2014} the tick failed"),
    );
    let failing = build(&both, false, &[]);
    assert!(failing.badge);
    assert_eq!(failing.tooltip, "Blocked: the backup folder is full");
    assert_eq!(failing.to_json()["badge"], BADGE);

    let worker_only = status(
        Row::new(RowState::Running, "Running"),
        Row::new(RowState::Failed, "refused \u{2014} wrong token"),
    );
    assert_eq!(
        build(&worker_only, false, &[]).tooltip,
        "refused \u{2014} wrong token"
    );

    let gave_up = status(
        Row::new(RowState::GaveUp, "Gave up after 3 restarts"),
        Row::new(RowState::Off, NOT_CONNECTED),
    );
    assert!(build(&gave_up, false, &[]).badge);

    let recovered = build(&running(), false, &[]);
    assert!(!recovered.badge);
    assert_eq!(recovered.tooltip, TITLE);
}

#[test]
fn server_app_015_rows_that_are_still_coming_up_or_off_do_not_count_as_failing() {
    for state in [
        RowState::Off,
        RowState::Starting,
        RowState::Restarting,
        RowState::Stopping,
        RowState::Stopped,
    ] {
        let calm = status(
            Row::new(state, "calm"),
            Row::new(RowState::Off, NOT_CONNECTED),
        );
        assert!(!build(&calm, false, &[]).badge, "{state:?}");
    }
}

#[test]
fn server_app_016_the_version_line_names_the_three_parts() {
    let menu = build(&running(), false, &[]);
    let line = menu.item(ItemId::Versions);
    assert_eq!(
        line.label,
        "server app 1.2.3 \u{b7} API 4.5.6 \u{b7} CLI 7.8.9"
    );
    assert!(!line.enabled);
}

#[test]
fn server_app_016_an_unreadable_part_reads_unknown() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("api")).unwrap();
    fs::create_dir_all(dir.path().join("cli")).unwrap();
    fs::write(dir.path().join("api/version"), "2.0.1\n").unwrap();
    fs::write(
        dir.path().join("cli/version"),
        "not a version\nsecond line\n",
    )
    .unwrap();

    let read = Versions::read(dir.path());
    assert_eq!(read.api, "2.0.1");
    assert_eq!(read.cli, "unknown");
    assert!(read.line().ends_with("API 2.0.1 \u{b7} CLI unknown"));

    let empty = tempfile::tempdir().unwrap();
    let nothing = Versions::read(empty.path());
    assert_eq!(
        (nothing.api.as_str(), nothing.cli.as_str()),
        ("unknown", "unknown")
    );
    assert!(!nothing.app.is_empty());
}

#[test]
fn server_app_011_the_status_rows_and_the_last_backup_row_read_from_the_state() {
    let menu = build(&unconnected(), false, &[]);
    assert_eq!(menu.item(ItemId::ApiStatus).label, "API: Running");
    assert_eq!(menu.item(ItemId::WorkerStatus).label, NOT_CONNECTED);
    assert_eq!(menu.item(ItemId::LastBackup).label, "Last backup: never");

    let with_backup = |backup: BackupView| {
        Menu::build(&Inputs {
            status: &running(),
            backup: &backup,
            versions: &versions(),
            request_signature: false,
            busy: &[],
        })
    };
    assert_eq!(
        with_backup(BackupView {
            last_backup: Some("2026-11-26T09:41:12.123Z".to_string()),
            ..BackupView::default()
        })
        .item(ItemId::LastBackup)
        .label,
        "Last backup: 2026-11-26 09:41 UTC"
    );
    assert_eq!(
        with_backup(BackupView {
            in_progress: true,
            ..BackupView::default()
        })
        .item(ItemId::LastBackup)
        .label,
        "Last backup: backing up\u{2026}"
    );
    assert_eq!(
        with_backup(BackupView {
            last_error: Some("the disk is full".to_string()),
            ..BackupView::default()
        })
        .item(ItemId::LastBackup)
        .label,
        "Last backup failed: the disk is full"
    );
    assert_eq!(
        build(&running(), false, &[])
            .item(ItemId::WorkerStatus)
            .label,
        "Worker: ok"
    );
}
