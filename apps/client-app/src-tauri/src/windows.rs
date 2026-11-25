use agent_board_client_core::bridge::Scope;
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::servers::ServerEntry;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const LIST_LABEL: &str = "list";
pub const ALL_SERVERS_LABEL: &str = "all-servers";
const SERVER_PREFIX: &str = "server-";
const LIST_PAGE: &str = "_native/list.html";
const BRIDGE_SCRIPT: &str = include_str!("../../dist-bridge/bridge.js");

pub fn server_window_label(server: ServerId) -> String {
    format!("{SERVER_PREFIX}{server}")
}

pub fn tab_label(server: ServerId, tab: usize) -> String {
    format!("tab-{server}-{tab}")
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
    let window = WindowBuilder::new(app, server_window_label(entry.id))
        .title(&entry.name)
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 360.0)
        .closable(false)
        .build()?;
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let page = WebviewBuilder::new(tab_label(entry.id, 0), WebviewUrl::App("".into()))
        .initialization_script(BRIDGE_SCRIPT)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .auto_resize();
    window.add_child(
        page,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(size.width, size.height),
    )?;
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
