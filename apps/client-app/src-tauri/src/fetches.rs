use futures_util::StreamExt;
use rumo_client_core::ports::{ByteStream, PortError};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};

struct Active {
    webview: String,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct Fetches {
    next: AtomicU64,
    active: Mutex<HashMap<u64, Active>>,
}

impl Fetches {
    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn start(&self, id: u64, webview: &str, spawn: impl FnOnce() -> JoinHandle<()>) {
        let mut active = self.active.lock().unwrap();
        let task = spawn();
        active.insert(
            id,
            Active {
                webview: webview.to_owned(),
                task,
            },
        );
    }

    pub fn finish(&self, id: u64) {
        self.active.lock().unwrap().remove(&id);
    }

    pub fn cancel(&self, id: u64, webview: &str) {
        let mut active = self.active.lock().unwrap();
        if active
            .get(&id)
            .is_some_and(|entry| entry.webview == webview)
            && let Some(entry) = active.remove(&id)
        {
            entry.task.abort();
        }
    }
}

pub async fn pump(mut body: ByteStream, channel: Channel<InvokeResponseBody>) {
    while let Some(item) = body.next().await {
        match item {
            Ok(chunk) => {
                if channel.send(InvokeResponseBody::Raw(chunk)).is_err() {
                    return;
                }
            }
            Err(PortError(detail)) => {
                let message = serde_json::json!({ "error": detail }).to_string();
                let _ = channel.send(InvokeResponseBody::Json(message));
                return;
            }
        }
    }
    let _ = channel.send(InvokeResponseBody::Json(r#"{"end":true}"#.to_owned()));
}
