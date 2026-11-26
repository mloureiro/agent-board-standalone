mod windows;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use agent_board_server_core::actions::Action;
use agent_board_server_core::app::Running;
use agent_board_server_core::console::{Console, Event};
use agent_board_server_core::handover::SystemRunner;
use agent_board_server_core::menu::{BADGE, ItemId, Menu, TITLE};
use agent_board_server_core::opener::SystemOpener;
use agent_board_server_core::signals;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry};

const TRAY_ID: &str = "main";
const SEPARATED: [ItemId; 5] = [
    ItemId::ApiStatus,
    ItemId::RestartServer,
    ItemId::OpenLogs,
    ItemId::ConnectWorker,
    ItemId::Quit,
];

#[cfg(target_os = "macos")]
fn hide_from_dock(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn hide_from_dock(_: &mut tauri::App) {}

struct Items(Vec<(ItemId, MenuItem<Wry>)>);

fn refresh(handle: &AppHandle, console: &Console) {
    let menu = console.menu();
    if let Some(items) = handle.try_state::<Items>() {
        apply(&items.0, &menu);
    }
    if let Some(tray) = handle.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(menu.badge.then_some(BADGE));
        let _ = tray.set_tooltip(Some(menu.tooltip.as_str()));
    }
}

fn apply(items: &[(ItemId, MenuItem<Wry>)], menu: &Menu) {
    for (id, item) in items {
        let model = menu.item(*id);
        let _ = item.set_text(&model.label);
        let _ = item.set_enabled(model.enabled);
    }
}

fn build_items(app: &tauri::App, menu: &Menu) -> tauri::Result<Vec<(ItemId, MenuItem<Wry>)>> {
    menu.items
        .iter()
        .map(|model| {
            MenuItemBuilder::with_id(model.id.key(), &model.label)
                .enabled(model.enabled)
                .build(app)
                .map(|item| (model.id, item))
        })
        .collect()
}

fn action_of(id: ItemId) -> Option<Action> {
    match id {
        ItemId::OpenBoard => Some(Action::OpenBoard),
        ItemId::RestartServer => Some(Action::RestartServer),
        ItemId::BackUpNow => Some(Action::BackUpNow),
        ItemId::RestartWorker => Some(Action::RestartWorker),
        ItemId::DisconnectWorker => Some(Action::DisconnectWorker),
        ItemId::CheckWorker => Some(Action::CheckWorker),
        ItemId::OpenLogs => Some(Action::OpenLogs),
        ItemId::OpenSettings => Some(Action::OpenSettings),
        ItemId::PairDevice => Some(Action::PairDevice),
        ItemId::ApiStatus
        | ItemId::WorkerStatus
        | ItemId::LastBackup
        | ItemId::Versions
        | ItemId::ConnectWorker
        | ItemId::Quit => None,
    }
}

fn clicked(app: &AppHandle, console: &Arc<Console>, id: ItemId) {
    match id {
        ItemId::Quit => {
            console.request_quit();
            app.exit(0);
        }
        ItemId::ConnectWorker => {
            if console.may_open_connect() {
                windows::show_connect(app);
            }
        }
        other => {
            let Some(action) = action_of(other) else {
                return;
            };
            let app = app.clone();
            let console = Arc::clone(console);
            thread::spawn(move || {
                if let Some(reply) = console.dispatch(action) {
                    windows::show_reply(&app, &reply);
                }
            });
        }
    }
}

fn watch_signals(handle: AppHandle) {
    thread::spawn(move || {
        loop {
            if let Some(signal) = signals::received() {
                if let Some(running) = handle.try_state::<Running>() {
                    running
                        .app_log
                        .info(&format!("{} received, quitting", signals::name(signal)));
                }
                handle.exit(0);
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
}

pub fn run(running: Running) {
    signals::install();
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            windows::enrol_state,
            windows::enrol_set,
            windows::enrol_connect,
            windows::pair_state,
            windows::close_self
        ])
        .setup(move |app| {
            hide_from_dock(app);
            let (changes, changed) = mpsc::channel::<()>();
            let changes = Mutex::new(changes);
            let console = Console::start(
                &running,
                Arc::new(SystemOpener::new(running.open_program.clone())),
                Arc::new(SystemRunner::new(running.open_program.clone())),
                Arc::new(move |event| {
                    if matches!(event, Event::Changed | Event::Menu) {
                        let _ = changes.lock().unwrap().send(());
                    }
                }),
            );

            let menu = console.menu();
            let items = build_items(app, &menu)?;
            let mut builder = MenuBuilder::new(app);
            for (id, item) in &items {
                if SEPARATED.contains(id) {
                    builder = builder.separator();
                }
                builder = builder.item(item);
            }
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .menu(&builder.build()?)
                .tooltip(TITLE)
                .on_menu_event(|app, event| {
                    let console = app
                        .try_state::<Arc<Console>>()
                        .map(|state| state.inner().clone());
                    if let (Some(console), Some(id)) =
                        (console, ItemId::from_key(event.id().as_ref()))
                    {
                        clicked(app, &console, id);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            running.app_log.info("tray ready");

            app.manage(Items(items));
            app.manage(Arc::clone(&console));
            app.manage(windows::PairShown::default());
            app.manage(running);
            let handle = app.handle().clone();
            refresh(&handle, &console);
            thread::spawn(move || {
                while changed.recv().is_ok() {
                    while changed.try_recv().is_ok() {}
                    refresh(&handle, &console);
                }
            });
            watch_signals(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| match event {
            RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
            RunEvent::Exit => {
                if let Some(console) = handle.try_state::<Arc<Console>>() {
                    console.stop();
                }
            }
            _ => {}
        }),
        Err(error) => eprintln!("{error}"),
    }
}
