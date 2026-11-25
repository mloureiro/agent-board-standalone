use crate::links;
use crate::server_tabs;
use crate::state::AppState;
use crate::tab_registry::TabRegistry;
use agent_board_client_core::bridge::Scope;
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::layout;
use agent_board_client_core::log::line;
use agent_board_client_core::servers::ServerEntry;
use agent_board_client_core::tab_file;
use agent_board_client_core::tabs::{HOME, TabId};
use std::sync::Arc;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

pub const LIST_LABEL: &str = "list";
pub const ALL_SERVERS_LABEL: &str = "all-servers";
const SERVER_PREFIX: &str = "server-";
const LIST_PAGE: &str = "_native/list.html";
const TABBAR_PAGE: &str = "_native/tabbar.html";
const APP_ORIGIN: &str = "tauri://localhost";
const TAB_PREFIX: &str = "tab-";
pub const TABBAR_PREFIX: &str = "tabbar-";
pub const BRIDGE_SCRIPT: &str = include_str!("../../dist-bridge/bridge.js");

pub fn server_window_label(server: ServerId) -> String {
    format!("{SERVER_PREFIX}{server}")
}

pub fn tab_label(server: ServerId, tab: TabId) -> String {
    format!("tab-{server}-{tab}")
}

pub fn tabbar_label(server: ServerId) -> String {
    format!("{TABBAR_PREFIX}{server}")
}

pub fn server_of_bar_label(label: &str) -> Option<ServerId> {
    ServerId::parse(label.strip_prefix(TABBAR_PREFIX)?).ok()
}

pub fn tab_of_label(label: &str) -> Option<(ServerId, TabId)> {
    let (server, number) = label.strip_prefix(TAB_PREFIX)?.rsplit_once('-')?;
    Some((ServerId::parse(server).ok()?, number.parse().ok()?))
}

pub fn server_of_label(label: &str) -> Option<ServerId> {
    server_of_bar_label(label).or_else(|| tab_of_label(label).map(|(server, _)| server))
}

pub fn focused_server(app: &AppHandle) -> Option<ServerId> {
    app.windows()
        .into_iter()
        .filter(|(_, window)| window.is_focused().unwrap_or(false))
        .find_map(|(label, _)| ServerId::parse(label.strip_prefix(SERVER_PREFIX)?).ok())
}

pub fn app_origin() -> Url {
    Url::parse(APP_ORIGIN).expect("the app origin is a valid URL")
}

pub fn open_server_windows(app: &AppHandle) -> Vec<ServerId> {
    let mut open: Vec<ServerId> = app
        .windows()
        .keys()
        .filter_map(|label| label.strip_prefix(SERVER_PREFIX))
        .filter_map(|id| ServerId::parse(id).ok())
        .collect();
    open.sort_by_key(ToString::to_string);
    open
}

pub fn scope_for(app: &AppHandle, listed: &[ServerEntry], label: &str) -> Scope {
    if label == LIST_LABEL {
        Scope::AllServers(listed.iter().map(|entry| entry.id).collect())
    } else {
        Scope::from_label(label, &open_server_windows(app))
    }
}

fn bring_forward(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()
}

pub fn show_list(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LIST_LABEL) {
        return bring_forward(&window);
    }
    WebviewWindowBuilder::new(app, LIST_LABEL, WebviewUrl::App(LIST_PAGE.into()))
        .title("Agent Board")
        .inner_size(520.0, 560.0)
        .min_inner_size(360.0, 320.0)
        .build()
        .map(|_| ())
}

pub fn show_all_servers(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(ALL_SERVERS_LABEL) {
        return bring_forward(&window);
    }
    WebviewWindowBuilder::new(app, ALL_SERVERS_LABEL, WebviewUrl::App("".into()))
        .title("All servers")
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 360.0)
        .initialization_script(BRIDGE_SCRIPT)
        .on_navigation(links::guard(app_origin()))
        .on_new_window(links::on_new_window(app_origin(), |_| {}))
        .build()
        .map(|_| ())
}

pub fn focus_server_window(app: &AppHandle, server: ServerId) -> tauri::Result<()> {
    let Some(window) = app.get_window(&server_window_label(server)) else {
        return Ok(());
    };
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()
}

pub fn create_server_window(app: &AppHandle, entry: &ServerEntry) -> tauri::Result<()> {
    let server = entry.id;
    let window = WindowBuilder::new(app, server_window_label(server))
        .title(&entry.name)
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 360.0)
        .closable(false)
        .build()?;
    let origin = app_origin();
    let size = server_tabs::window_size(&window)?;
    let bar = layout::tab_bar(size.width, size.height);
    window.add_child(
        WebviewBuilder::new(tabbar_label(server), WebviewUrl::App(TABBAR_PAGE.into()))
            .on_navigation(links::guard(origin.clone()))
            .on_new_window(links::on_new_window(origin.clone(), |_| {})),
        LogicalPosition::new(bar.x, bar.y),
        LogicalSize::new(bar.width, bar.height),
    )?;

    let restored = tab_file::read(&*app.state::<Arc<AppState>>().tab_files, server);
    if let Some(event) = restored.log {
        eprintln!("{}", line(server, event));
    }
    let home_selected = restored.tabs.selected() == HOME;
    app.state::<TabRegistry>()
        .insert(server, restored.tabs, origin.clone());

    let (handle, resized) = (app.clone(), window.clone());
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
        WindowEvent::Resized(_) => server_tabs::relayout(&resized),
        WindowEvent::Destroyed => handle.state::<TabRegistry>().remove(server),
        _ => {}
    });

    server_tabs::run(app, server, |tabs| tabs.start());
    if !home_selected {
        server_tabs::create_hidden_home(app, server, &origin);
    }
    Ok(())
}

pub fn retitle_server_window(app: &AppHandle, entry: &ServerEntry) -> Result<(), String> {
    match app.get_window(&server_window_label(entry.id)) {
        Some(window) => window.set_title(&entry.name).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

pub fn close_server_window(app: &AppHandle, server: ServerId) -> Result<(), String> {
    match app.get_window(&server_window_label(server)) {
        Some(window) => window.destroy().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

    #[test]
    fn client_app_017_labels_name_one_server_and_one_tab() {
        let server = ServerId::parse(ID).unwrap();
        assert_eq!(tab_of_label(&tab_label(server, 7)), Some((server, 7)));
        assert_eq!(server_of_bar_label(&tabbar_label(server)), Some(server));
        assert_eq!(server_of_label(&tabbar_label(server)), Some(server));
        assert_eq!(server_of_label(&tab_label(server, 0)), Some(server));
        for label in [
            "list",
            "all-servers",
            "tab-nope-1",
            "tabbar-nope",
            &format!("tab-{ID}-x"),
            &format!("tab-{ID}"),
            &format!("server-{ID}"),
        ] {
            assert_eq!(server_of_label(label), None, "{label}");
        }
    }
}
