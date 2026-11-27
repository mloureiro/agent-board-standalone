use crate::commands::page::start_removal;
use crate::state::{AppState, OpenFailure};
use crate::{handover, windows};
use rumo_client_core::ids::ServerId;
use rumo_client_core::servers::ServerEntry;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};

type Shared<'a> = State<'a, Arc<AppState>>;

fn parse(server_id: &str) -> Result<ServerId, String> {
    ServerId::parse(server_id).map_err(|_| "unknown server".to_owned())
}

#[tauri::command]
pub async fn list_add_server(
    state: Shared<'_>,
    name: String,
    address: String,
) -> Result<ServerEntry, String> {
    state
        .bridge
        .servers()
        .add(ServerId::generate(), &name, &address)
        .map_err(|error| rumo_client_core::bridge::BridgeError::from(error).message())
}

#[derive(Serialize)]
pub struct Purge {
    purge: String,
}

#[tauri::command]
pub async fn list_remove_server(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
) -> Result<Option<Purge>, String> {
    let scope = windows::scope_for(&app, &state.bridge.servers().list(), webview.label());
    let blocking = Arc::clone(&state);
    let requested = server_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        blocking.bridge.page_remove_server(&scope, &requested)
    })
    .await
    .map_err(|_| "the server could not be removed".to_owned())?
    .map_err(|error| error.message())?;
    Ok(start_removal(&app, &state, outcome).then_some(Purge { purge: server_id }))
}

#[tauri::command]
pub async fn open_server(
    app: AppHandle,
    state: Shared<'_>,
    server_id: String,
) -> Result<(), String> {
    let id = parse(&server_id)?;
    let entry = state
        .bridge
        .servers()
        .get(id)
        .ok_or_else(|| "unknown server".to_owned())?;
    handover::open_entry(&app, &state, &entry, false).await
}

#[tauri::command]
pub async fn open_all_servers(app: AppHandle) -> Result<(), String> {
    windows::show_all_servers(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn retry_store_deletion(
    app: AppHandle,
    state: Shared<'_>,
    server_id: String,
) -> Result<(), String> {
    let id = parse(&server_id)?;
    crate::removals::run(&app, id, state.removals.retry(id));
    Ok(())
}

#[tauri::command]
pub async fn take_open_failures(state: Shared<'_>) -> Result<Vec<OpenFailure>, String> {
    Ok(state.take_open_failures())
}

#[tauri::command]
pub async fn list_is_complete(state: Shared<'_>) -> Result<bool, String> {
    Ok(state.bridge.servers().complete())
}
