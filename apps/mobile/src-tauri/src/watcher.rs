use crate::commands::AppBridge;
use agent_board_bridge_core::attention::{AttentionState, POLL_SECONDS, notification_text};
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_board_native::BoardNativeExt;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut state = AttentionState::default();
        let bridge = app.state::<AppBridge>();
        if !bridge.notifying_servers().is_empty() {
            let _ = app.board_native().service_start();
        }
        loop {
            let servers = bridge.notifying_servers();
            let live: HashSet<&str> = servers.iter().map(|entry| entry.id.as_str()).collect();
            for gone in state
                .tracked()
                .into_iter()
                .filter(|id| !live.contains(id.as_str()))
            {
                state.forget(&gone);
            }
            for entry in &servers {
                let polled =
                    tokio::time::timeout(Duration::from_secs(20), bridge.attention(&entry.id))
                        .await;
                let Ok(Ok(ids)) = polled else {
                    continue;
                };
                for task in state.update(&entry.id, ids) {
                    let _ = app.board_native().notify(
                        &entry.id,
                        &task,
                        &notification_text(&entry.name),
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(POLL_SECONDS)).await;
        }
    });
}
