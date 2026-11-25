use crate::keychain::Background;
use crate::state::AppState;
use agent_board_client_core::legacy::{TABS_DIRECTORY, stores_to_delete, sweep_sessions};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub async fn clean(app: &AppHandle, state: &Arc<AppState>) {
    if let Ok(found) = app.fetch_data_store_identifiers().await {
        for store in stores_to_delete(found) {
            let _ = app.remove_data_store(store.to_bytes()).await;
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(data.join(TABS_DIRECTORY));
    }
    let secrets = Background(Arc::clone(&state.secrets));
    let _ = tauri::async_runtime::spawn_blocking(move || sweep_sessions(&secrets)).await;
}
