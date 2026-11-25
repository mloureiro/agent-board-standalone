use crate::alerts;
use crate::state::AppState;
use crate::windows;
use agent_board_client_core::notify::expiry_banner;
use agent_board_client_core::tabs::HOME;
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};

const UNKNOWN: &str = "unknown server";

#[tauri::command]
pub async fn page_heartbeat(app: AppHandle, webview: Webview) -> Result<(), String> {
    let (server, tab) = windows::tab_of_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())?;
    if tab == HOME {
        alerts::heartbeat(&app, server);
    }
    Ok(())
}

#[tauri::command]
pub async fn tabbar_banner(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<&'static str>, String> {
    let server = windows::server_of_bar_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())?;
    Ok(expiry_banner(server, state.bridge.is_expired(server)).text)
}
