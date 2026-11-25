use crate::commands::tabs;
use crate::fetches::pump;
use crate::state::AppState;
use crate::{removals, windows};
use agent_board_client_core::bridge::{BridgeError, Scope};
use agent_board_client_core::headers::Header;
use agent_board_client_core::page_input::{self, TabIntent};
use agent_board_client_core::ports::PortError;
use agent_board_client_core::servers::ServerEntry;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State, Webview};

type Shared<'a> = State<'a, Arc<AppState>>;

fn scope(app: &AppHandle, state: &AppState, webview: &Webview) -> Scope {
    windows::scope_for(app, &state.bridge.servers().list(), webview.label())
}

fn text(error: BridgeError) -> String {
    error.message()
}

fn input(error: page_input::InputError) -> String {
    error.message().to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchHead {
    fetch_id: u64,
    status: u16,
    headers: HashMap<String, String>,
}

fn response_headers(headers: Vec<Header>) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = HashMap::new();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if name == "set-cookie" {
            continue;
        }
        merged
            .entry(name)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }
    merged
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn server_fetch(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    channel: Channel<InvokeResponseBody>,
) -> Result<FetchHead, String> {
    page_input::fetch_input(headers.len(), body.as_deref()).map_err(input)?;
    let scope = scope(&app, &state, &webview);
    let outgoing: Vec<Header> = headers.into_iter().collect();
    let response = state
        .bridge
        .server_fetch(
            &scope,
            &server_id,
            &method,
            &path,
            &outgoing,
            body.as_deref(),
        )
        .await
        .map_err(text)?;
    let fetch_id = state.fetches.next_id();
    let owner = Arc::clone(&state);
    state.fetches.start(fetch_id, webview.label(), || {
        tauri::async_runtime::spawn(async move {
            pump(response.body, channel).await;
            owner.fetches.finish(fetch_id);
        })
    });
    Ok(FetchHead {
        fetch_id,
        status: response.status,
        headers: response_headers(response.headers),
    })
}

#[tauri::command]
pub async fn server_fetch_cancel(
    webview: Webview,
    state: Shared<'_>,
    fetch_id: u64,
) -> Result<(), String> {
    state.fetches.cancel(fetch_id, webview.label());
    Ok(())
}

#[derive(Serialize)]
pub struct HandoffOutcome {
    status: &'static str,
}

#[tauri::command]
pub async fn handoff_finish(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
    flow: String,
    verifier: String,
) -> Result<HandoffOutcome, String> {
    let _ = (flow, verifier);
    scope(&app, &state, &webview)
        .resolve(&server_id)
        .map_err(text)?;
    Err("sign-in is not available in this build yet".to_owned())
}

#[tauri::command]
pub async fn pair(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
    code: String,
    label: String,
) -> Result<(), String> {
    let _ = (code, label);
    scope(&app, &state, &webview)
        .resolve(&server_id)
        .map_err(text)?;
    Err("pairing is not available in this build yet".to_owned())
}

#[tauri::command]
pub async fn sign_out(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
) -> Result<(), String> {
    scope(&app, &state, &webview)
        .resolve(&server_id)
        .map(|_| ())
        .map_err(text)
}

#[tauri::command]
pub async fn notify(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
    task_id: String,
    title: String,
) -> Result<(), String> {
    scope(&app, &state, &webview)
        .resolve(&server_id)
        .map_err(text)?;
    page_input::notification(&task_id, &title)
        .map(|_| ())
        .map_err(input)
}

#[tauri::command]
pub async fn open_link(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    url: String,
) -> Result<(), String> {
    if scope(&app, &state, &webview) == Scope::None {
        return Err(text(BridgeError::UnknownServer));
    }
    let url = page_input::link(&url).map_err(input)?;
    std::process::Command::new("open")
        .arg("--")
        .arg(url.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|_| "the link could not be opened".to_owned())
}

#[tauri::command]
pub async fn report_tab(
    app: AppHandle,
    webview: Webview,
    path: String,
    title: String,
) -> Result<(), String> {
    let report = page_input::tab_report(&path, &title).map_err(input)?;
    if let Some((server, tab)) = windows::tab_of_label(webview.label()) {
        crate::server_tabs::dispatch(&app, server, move |tabs| {
            let mut effects = tabs::navigate(tabs, tab, TabIntent::Route, &report.path);
            effects.extend(tabs.title(tab, &report.title));
            effects
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn list_servers(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
) -> Result<Vec<ServerEntry>, String> {
    Ok(state.bridge.list_servers(&scope(&app, &state, &webview)))
}

#[tauri::command]
pub async fn page_add_server(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    name: String,
    address: String,
) -> Result<Option<ServerEntry>, String> {
    let scope = scope(&app, &state, &webview);
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.bridge.page_add_server(&scope, &name, &address)
    })
    .await
    .map_err(|_| "the server could not be added".to_owned())?
    .map_err(text)
}

#[tauri::command]
pub async fn page_remove_server(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
) -> Result<bool, String> {
    let scope = scope(&app, &state, &webview);
    let blocking = Arc::clone(&state);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        blocking.bridge.page_remove_server(&scope, &server_id)
    })
    .await
    .map_err(|_| "the server could not be removed".to_owned())?
    .map_err(text)?;
    Ok(start_removal(&app, &state, outcome))
}

pub fn start_removal(
    app: &AppHandle,
    state: &AppState,
    outcome: Option<(
        agent_board_client_core::removal::Removal,
        Vec<agent_board_client_core::removal::Effect>,
    )>,
) -> bool {
    let Some((removal, effects)) = outcome else {
        return false;
    };
    let server = removal.server();
    state.removals.begin(removal);
    removals::run(app, server, effects);
    true
}

#[tauri::command]
pub async fn rename_server(
    app: AppHandle,
    webview: Webview,
    state: Shared<'_>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    let scope = scope(&app, &state, &webview);
    let report = state
        .bridge
        .rename_server(&scope, &server_id, &name, |entry| {
            windows::retitle_server_window(&app, entry).map_err(PortError)
        })
        .map_err(text)?;
    report.retitle_warning.map_or(Ok(()), Err)
}
