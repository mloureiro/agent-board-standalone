use crate::state::AppState;
use crate::windows;
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::orphans::tab_file_name;
use agent_board_client_core::ports::FileStore;
use agent_board_client_core::removal::{Effect, Removal};
use agent_board_client_core::tokens::{delete_secret, key_service, token_service};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const STORE_FAILURE_EVENT: &str = "store-deletion-failed";
pub const WINDOW_ERROR_EVENT: &str = "window-error";

#[derive(Default)]
pub struct Removals {
    running: Mutex<HashMap<ServerId, Removal>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreFailure {
    server_id: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct WindowError {
    message: String,
}

impl Removals {
    pub fn begin(&self, removal: Removal) {
        self.running
            .lock()
            .unwrap()
            .insert(removal.server(), removal);
    }

    fn with<T>(&self, server: ServerId, job: impl FnOnce(&mut Removal) -> T) -> Option<T> {
        self.running.lock().unwrap().get_mut(&server).map(job)
    }

    fn drop_finished(&self, server: ServerId) {
        self.running.lock().unwrap().remove(&server);
    }

    pub fn retry(&self, server: ServerId) -> Vec<Effect> {
        self.with(server, Removal::retry).unwrap_or_default()
    }
}

async fn delete_stores(state: &Arc<AppState>, server: ServerId) -> Result<(), String> {
    let mut failed = false;
    for service in [token_service(), key_service()] {
        failed |= delete_secret(&state.secrets, service, server)
            .await
            .is_err();
    }
    let files = Arc::clone(&state.tab_files);
    let file = tauri::async_runtime::spawn_blocking(move || files.delete(&tab_file_name(server)))
        .await
        .map_or(true, |result| result.is_err());
    if failed || file {
        Err("store deletion failed".to_owned())
    } else {
        Ok(())
    }
}

pub fn run(app: &AppHandle, server: ServerId, effects: Vec<Effect>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<AppState>>().inner().clone();
        let mut queue: VecDeque<Effect> = effects.into();
        while let Some(effect) = queue.pop_front() {
            let follow_up = match effect {
                Effect::CloseWindow => {
                    let result = windows::close_server_window(&app, server);
                    state
                        .removals
                        .with(server, |removal| removal.window_closed(result))
                }
                Effect::DeleteStores => {
                    let result = delete_stores(&state, server).await;
                    state
                        .removals
                        .with(server, |removal| removal.stores_deleted(result))
                }
                Effect::DeleteStoresAfter(delay) => {
                    tokio::time::sleep(delay).await;
                    let result = delete_stores(&state, server).await;
                    state
                        .removals
                        .with(server, |removal| removal.stores_deleted(result))
                }
                Effect::ReportWindowError(message) => {
                    let _ = app.emit_to(
                        windows::LIST_LABEL,
                        WINDOW_ERROR_EVENT,
                        WindowError { message },
                    );
                    None
                }
                Effect::ReportStoreFailure(message) => {
                    let _ = app.emit_to(
                        windows::LIST_LABEL,
                        STORE_FAILURE_EVENT,
                        StoreFailure {
                            server_id: server.to_string(),
                            message,
                        },
                    );
                    None
                }
                Effect::Finished => {
                    state.removals.drop_finished(server);
                    None
                }
            };
            queue.extend(follow_up.unwrap_or_default());
        }
    });
}
