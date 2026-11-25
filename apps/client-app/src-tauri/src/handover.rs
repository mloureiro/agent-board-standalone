use crate::state::{AppState, OpenFailure};
use crate::windows;
use agent_board_client_core::handover::{EarlyLinks, HandoverPlan, plan};
use agent_board_client_core::handshake::Handshake;
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::opening::{Opening, WindowAction, plan_open, window_error};
use agent_board_client_core::servers::ServerEntry;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const FAILURES_QUEUED_EVENT: &str = "open-failures-queued";
const SERVERS_CHANGED_EVENT: &str = "servers-changed";
const LINK_NOTICE_NAME: &str = "Agent Board";

pub fn queue_failure(app: &AppHandle, state: &AppState, name: &str, text: String) {
    state.queue_open_failure(OpenFailure {
        name: name.to_owned(),
        text,
    });
    let _ = windows::show_list(app);
    let _ = app.emit_to(windows::LIST_LABEL, FAILURES_QUEUED_EVENT, ());
}

pub async fn open_entry(
    app: &AppHandle,
    state: &AppState,
    entry: &ServerEntry,
    store_on_success: bool,
) -> Result<(), String> {
    let open = windows::open_server_windows(app);
    let failed = |detail: String| window_error(WindowAction::Open, &entry.name, &detail);
    match plan_open(&state.http, &state.client, entry, &open).await {
        Opening::Focus(server) => {
            windows::focus_server_window(app, server).map_err(|error| failed(error.to_string()))
        }
        Opening::CreateWindow {
            server,
            request_signature,
        } => {
            if store_on_success {
                state
                    .bridge
                    .servers()
                    .add(entry.id, &entry.name, &entry.url)
                    .map_err(|error| {
                        agent_board_client_core::bridge::BridgeError::from(error).message()
                    })?;
                let _ = app.emit_to(windows::LIST_LABEL, SERVERS_CHANGED_EVENT, ());
            }
            state
                .bridge
                .record_handshake(server, Handshake { request_signature });
            windows::create_server_window(app, entry).map_err(|error| failed(error.to_string()))
        }
        Opening::ListError { text, .. } => Err(text),
    }
}

async fn handle(app: &AppHandle, links: Vec<String>) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let listed = state.bridge.servers().list();
    match plan(links.iter().map(String::as_str), &listed) {
        HandoverPlan::ShowList { message } => {
            let _ = windows::show_list(app);
            if let Some(text) = message {
                queue_failure(app, &state, LINK_NOTICE_NAME, text);
            }
        }
        HandoverPlan::Open(server) => {
            if let Some(entry) = state.bridge.servers().get(server)
                && let Err(text) = open_entry(app, &state, &entry, false).await
            {
                queue_failure(app, &state, &entry.name, text);
            }
        }
        HandoverPlan::Add { name, url } => {
            let entry = ServerEntry {
                id: ServerId::generate(),
                name,
                url,
            };
            if let Err(text) = open_entry(app, &state, &entry, true).await {
                queue_failure(app, &state, &entry.name, text);
            }
        }
    }
}

fn spawn_handling(app: &AppHandle, links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { handle(&app, links).await });
}

pub fn deliver(app: &AppHandle, links: Vec<String>) {
    if let Some(now) = app.state::<EarlyLinks>().deliver(links) {
        spawn_handling(app, now);
    }
}

pub fn release_early(app: &AppHandle) {
    spawn_handling(app, app.state::<EarlyLinks>().release());
}
