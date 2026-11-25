use crate::adapters::{DialogConfirm, FileStore, PluginKeys, ReqwestHttp, SystemEnv};
use agent_board_bridge_core::bridge::Bridge;
use agent_board_bridge_core::servers::ServerEntry;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State, Wry};
use tauri_plugin_board_native::BoardNativeExt;
use tauri_plugin_opener::OpenerExt;

pub type AppBridge = Bridge<ReqwestHttp, PluginKeys<Wry>, DialogConfirm<Wry>, SystemEnv, FileStore>;

#[derive(Serialize)]
pub struct FetchHead {
    status: u16,
    headers: HashMap<String, String>,
}

fn text(error: agent_board_bridge_core::bridge::BridgeError) -> String {
    error.message()
}

#[tauri::command]
pub async fn server_fetch(
    bridge: State<'_, AppBridge>,
    server_id: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<FetchHead, String> {
    let response = bridge
        .server_fetch(&server_id, &method, &path, &headers, body.as_deref())
        .await
        .map_err(text)?;
    let head = FetchHead {
        status: response.status,
        headers: response.headers.into_iter().collect(),
    };
    let mut stream = response.body;
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = stream.next().await {
            let sent = match chunk {
                Ok(bytes) => on_chunk.send(InvokeResponseBody::Raw(bytes)),
                Err(message) => {
                    let _ = on_chunk.send(InvokeResponseBody::Json(
                        serde_json::json!({ "type": "error", "message": message }).to_string(),
                    ));
                    return;
                }
            };
            if sent.is_err() {
                return;
            }
        }
        let _ = on_chunk.send(InvokeResponseBody::Json(
            serde_json::json!({ "type": "end" }).to_string(),
        ));
    });
    Ok(head)
}

#[tauri::command]
pub async fn handoff_finish(
    bridge: State<'_, AppBridge>,
    server_id: String,
    flow_id: String,
    verifier: String,
) -> Result<(), String> {
    bridge
        .handoff_finish(&server_id, &flow_id, &verifier)
        .await
        .map_err(text)
}

#[tauri::command]
pub async fn pair(
    bridge: State<'_, AppBridge>,
    server_id: String,
    code: String,
    label: String,
) -> Result<(), String> {
    bridge.pair(&server_id, &code, &label).await.map_err(text)
}

#[tauri::command]
pub async fn sign_out(bridge: State<'_, AppBridge>, server_id: String) -> Result<(), String> {
    bridge.sign_out(&server_id).await.map_err(text)
}

#[tauri::command]
pub async fn list_servers(bridge: State<'_, AppBridge>) -> Result<Vec<ServerEntry>, String> {
    Ok(bridge.list_servers())
}

#[tauri::command]
pub async fn add_server(
    bridge: State<'_, AppBridge>,
    name: String,
    address: String,
) -> Result<Option<ServerEntry>, String> {
    bridge.add_server(&name, &address).map_err(text)
}

#[tauri::command]
pub async fn remove_server(
    bridge: State<'_, AppBridge>,
    server_id: String,
) -> Result<bool, String> {
    bridge.remove_server(&server_id).map_err(text)
}

#[tauri::command]
pub async fn rename_server(
    bridge: State<'_, AppBridge>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    bridge.rename_server(&server_id, &name).map_err(text)
}

#[tauri::command]
pub async fn open_link(
    app: AppHandle,
    bridge: State<'_, AppBridge>,
    url: String,
) -> Result<(), String> {
    let allowed = bridge.open_link(&url).map_err(text)?;
    app.opener()
        .open_url(allowed, None::<&str>)
        .map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    server_id: String,
    task_id: String,
    title: String,
}

#[tauri::command]
pub async fn notify(
    app: AppHandle,
    bridge: State<'_, AppBridge>,
    notification: Notification,
) -> Result<(), String> {
    bridge
        .list_servers()
        .iter()
        .find(|entry| entry.id == notification.server_id)
        .ok_or_else(|| "unknown-server".to_string())?;
    app.board_native()
        .notify(
            &notification.server_id,
            &notification.task_id,
            &notification.title,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_notifications(
    app: AppHandle,
    bridge: State<'_, AppBridge>,
    server_id: String,
    enabled: bool,
) -> Result<(), String> {
    bridge
        .set_notifications(&server_id, enabled)
        .map_err(text)?;
    let native = app.board_native();
    if bridge.notifying_servers().is_empty() {
        native.service_stop()
    } else {
        native.service_start()
    }
    .map_err(|error| error.to_string())
}
