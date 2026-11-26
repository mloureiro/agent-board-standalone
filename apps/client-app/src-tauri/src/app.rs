use crate::clock::SystemClock;
use crate::commands::{list, page, tabs, watch};
use crate::confirm::NativeConfirm;
use crate::fetches::Fetches;
use crate::keychain::{Background, Keychain};
use crate::removals::Removals;
use crate::state::{AppState, CONTRACT};
use crate::tab_registry::{TabQueue, TabRegistry};
use crate::{alerts, handover, menu, windows};
use agent_board_client_core::bridge::Bridge;
use agent_board_client_core::files::DirStore;
use agent_board_client_core::handover::EarlyLinks;
use agent_board_client_core::handshake::ClientInfo;
use agent_board_client_core::http::ReqwestHttp;
use agent_board_client_core::keybindings;
use agent_board_client_core::opening::{LaunchWindow, launch_plan};
use agent_board_client_core::orphans::sweep;
use agent_board_client_core::servers::Servers;
use std::sync::{Arc, Mutex};
use tauri::{App, AppHandle, Manager, RunEvent};

const TAB_FILES_DIRECTORY: &str = "tab-files";

fn build_state(app: &App) -> Result<AppState, Box<dyn std::error::Error>> {
    let config = app.path().app_config_dir()?;
    let data = app.path().app_data_dir()?;
    let client = ClientInfo {
        contract: CONTRACT,
        version: app.package_info().version.to_string(),
    };
    let secrets = Arc::new(Keychain::default());
    let bridge = Bridge::new(
        ReqwestHttp::new().map_err(|error| error.0)?,
        Arc::clone(&secrets),
        NativeConfirm::new(app.handle().clone()),
        SystemClock,
        Servers::open(DirStore::new(config)),
        client.clone(),
    );
    Ok(AppState {
        bridge,
        secrets,
        client,
        http: ReqwestHttp::new().map_err(|error| error.0)?,
        tab_files: Arc::new(DirStore::new(data.join(TAB_FILES_DIRECTORY))),
        fetches: Fetches::default(),
        removals: Removals::default(),
        open_failures: Mutex::new(Vec::new()),
    })
}

fn launch(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<()> {
    let listed = state.bridge.servers().list();
    for window in launch_plan(&listed).windows {
        match window {
            LaunchWindow::ServerList => windows::show_list(app)?,
        }
    }
    let state = Arc::clone(state);
    if !state.bridge.servers().complete() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let listed: Vec<_> = state
            .bridge
            .servers()
            .list()
            .iter()
            .map(|entry| entry.id)
            .collect();
        sweep(
            &listed,
            &Background(Arc::clone(&state.secrets)),
            &*state.tab_files,
        );
    });
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(EarlyLinks::holding())
        .manage(TabRegistry::default())
        .manage(TabQueue::start())
        .invoke_handler(tauri::generate_handler![
            page::server_fetch,
            page::server_fetch_cancel,
            page::handoff_finish,
            page::pair,
            page::sign_out,
            page::notify,
            page::open_link,
            page::report_tab,
            page::list_servers,
            page::page_add_server,
            page::page_remove_server,
            page::rename_server,
            list::list_add_server,
            list::list_remove_server,
            list::open_server,
            list::open_all_servers,
            list::retry_store_deletion,
            list::take_open_failures,
            list::list_is_complete,
            tabs::tabs_snapshot,
            tabs::tab_select,
            tabs::tab_close,
            tabs::tab_cycle,
            tabs::tab_split,
            tabs::tab_move,
            tabs::pane_close,
            tabs::pane_focus,
            tabs::split_resize,
            tabs::tab_focused,
            tabs::tab_navigate,
            tabs::tab_title,
            watch::page_heartbeat,
            watch::tabbar_banner,
        ])
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .setup(|app| {
            let state = Arc::new(build_state(app)?);
            app.manage(Arc::clone(&state));
            alerts::install(app.handle(), &state);
            let settings = DirStore::new(app.path().app_config_dir()?);
            let keys = keybindings::read(&settings);
            menu::install(app.handle(), &keys)
                .or_else(|_| menu::install(app.handle(), &keybindings::Keybindings::defaults()))?;
            launch(app.handle(), &state)?;
            handover::release_early(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app could not be built");

    app.run(|handle, event| match event {
        RunEvent::Opened { urls } => {
            handover::deliver(handle, urls.iter().map(ToString::to_string).collect());
        }
        RunEvent::Reopen { .. } => {
            let _ = windows::show_list(handle);
        }
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        _ => {}
    });
}
