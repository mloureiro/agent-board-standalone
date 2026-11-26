use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::activity::Busy;
use crate::backup_desk::BackupView;
use crate::status::{Row, RowState, Status};
use crate::versions::Versions;

pub const TITLE: &str = "Agent Board Server";
pub const BADGE: &str = "!";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemId {
    OpenBoard,
    ApiStatus,
    WorkerStatus,
    LastBackup,
    Versions,
    RestartServer,
    BackUpNow,
    RestartWorker,
    DisconnectWorker,
    CheckWorker,
    OpenLogs,
    OpenSettings,
    ConnectWorker,
    PairDevice,
    Quit,
}

impl ItemId {
    pub fn key(self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    pub fn from_key(key: &str) -> Option<ItemId> {
        serde_json::from_value(Value::String(key.to_string())).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: ItemId,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inputs<'a> {
    pub status: &'a Status,
    pub backup: &'a BackupView,
    pub versions: &'a Versions,
    pub request_signature: bool,
    pub busy: &'a [Busy],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Menu {
    pub items: Vec<Item>,
    pub badge: bool,
    pub tooltip: String,
    pub busy: Vec<Busy>,
}

pub fn is_failing(row: &Row) -> bool {
    matches!(row.state, RowState::Failed | RowState::GaveUp)
}

pub fn failing_text(status: &Status) -> Option<&str> {
    [&status.api, &status.worker]
        .into_iter()
        .find(|row| is_failing(row))
        .map(|row| row.text.as_str())
}

pub fn worker_connected(status: &Status) -> bool {
    status.worker.state != RowState::Off
}

fn backup_label(backup: &BackupView) -> String {
    if backup.in_progress {
        return "Last backup: backing up\u{2026}".to_string();
    }
    if let Some(error) = &backup.last_error {
        return format!("Last backup failed: {error}");
    }
    match backup.last_backup.as_deref() {
        Some(iso) if iso.len() >= 16 => {
            format!("Last backup: {} {} UTC", &iso[..10], &iso[11..16])
        }
        _ => "Last backup: never".to_string(),
    }
}

fn worker_label(row: &Row) -> String {
    if row.state == RowState::Off {
        row.text.clone()
    } else {
        format!("Worker: {}", row.text)
    }
}

impl Menu {
    pub fn build(inputs: &Inputs) -> Menu {
        let status = inputs.status;
        let api_running = status.api.state == RowState::Running;
        let connected = worker_connected(status);
        let idle = inputs.busy.is_empty();
        let item = |id: ItemId, label: &str, enabled: bool| Item {
            id,
            label: label.to_string(),
            enabled,
        };
        let items = vec![
            item(ItemId::OpenBoard, "Open board", api_running),
            item(
                ItemId::ApiStatus,
                &format!("API: {}", status.api.text),
                false,
            ),
            item(ItemId::WorkerStatus, &worker_label(&status.worker), false),
            item(ItemId::LastBackup, &backup_label(inputs.backup), false),
            item(ItemId::Versions, &inputs.versions.line(), false),
            item(ItemId::RestartServer, "Restart server", idle),
            item(ItemId::BackUpNow, "Back up now", api_running && idle),
            item(ItemId::RestartWorker, "Restart worker", connected && idle),
            item(
                ItemId::DisconnectWorker,
                "Disconnect worker",
                connected && idle,
            ),
            item(ItemId::CheckWorker, "Check worker", connected && idle),
            item(ItemId::OpenLogs, "Open logs folder", idle),
            item(ItemId::OpenSettings, "Open settings file", idle),
            item(ItemId::ConnectWorker, "Connect worker\u{2026}", api_running),
            item(
                ItemId::PairDevice,
                "Pair a device\u{2026}",
                api_running && inputs.request_signature && idle,
            ),
            item(ItemId::Quit, "Quit", true),
        ];
        let failing = failing_text(status);
        Menu {
            items,
            badge: failing.is_some(),
            tooltip: failing.unwrap_or(TITLE).to_string(),
            busy: inputs.busy.to_vec(),
        }
    }

    pub fn item(&self, id: ItemId) -> &Item {
        self.items
            .iter()
            .find(|item| item.id == id)
            .expect("every item is always built")
    }

    pub fn to_json(&self) -> Value {
        json!({
            "type": "menu",
            "items": self.items,
            "badge": self.badge.then_some(BADGE),
            "tooltip": self.tooltip,
            "busy": self.busy,
        })
    }
}
