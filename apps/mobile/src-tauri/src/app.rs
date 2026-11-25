use crate::adapters::{DialogConfirm, FileStore, PluginKeys, ReqwestHttp, SystemEnv};
use crate::commands;
use agent_board_bridge_core::bridge::{Bridge, BridgeConfig, CONTRACT_LEVEL};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const SHIM: &str = include_str!("../shim.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_board_native::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let store = FileStore(app.path().app_data_dir()?.join("servers.json"));
            let bridge = Bridge::new(
                ReqwestHttp::new()?,
                PluginKeys(handle.clone()),
                DialogConfirm(handle),
                SystemEnv,
                store,
                BridgeConfig {
                    contract: CONTRACT_LEVEL,
                    client_version: env!("CARGO_PKG_VERSION").to_string(),
                },
            );
            app.manage(bridge);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .initialization_script(SHIM)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::server_fetch,
            commands::handoff_finish,
            commands::pair,
            commands::sign_out,
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::rename_server,
            commands::open_link,
            commands::notify,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
