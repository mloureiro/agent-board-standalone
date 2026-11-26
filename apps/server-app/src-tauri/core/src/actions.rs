use serde_json::{Value, json};

use crate::menu::ItemId;

#[derive(Clone, PartialEq, Eq)]
pub enum Action {
    OpenBoard,
    BackUpNow,
    RestartServer,
    RestartWorker,
    DisconnectWorker,
    CheckWorker,
    ConnectWorker { token: String, data_key: String },
    OpenLogs,
    OpenSettings,
    PairDevice,
}

impl std::fmt::Debug for Action {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::OpenBoard => "open-board",
            Action::BackUpNow => "backup-now",
            Action::RestartServer => "restart-server",
            Action::RestartWorker => "restart-worker",
            Action::DisconnectWorker => "disconnect-worker",
            Action::CheckWorker => "check-worker",
            Action::ConnectWorker { .. } => "connect-worker",
            Action::OpenLogs => "open-logs",
            Action::OpenSettings => "open-settings",
            Action::PairDevice => "pair-device",
        }
    }

    pub fn item(&self) -> ItemId {
        match self {
            Action::OpenBoard => ItemId::OpenBoard,
            Action::BackUpNow => ItemId::BackUpNow,
            Action::RestartServer => ItemId::RestartServer,
            Action::RestartWorker => ItemId::RestartWorker,
            Action::DisconnectWorker => ItemId::DisconnectWorker,
            Action::CheckWorker => ItemId::CheckWorker,
            Action::ConnectWorker { .. } => ItemId::ConnectWorker,
            Action::OpenLogs => ItemId::OpenLogs,
            Action::OpenSettings => ItemId::OpenSettings,
            Action::PairDevice => ItemId::PairDevice,
        }
    }

    pub fn parse(line: &str) -> Result<Action, Value> {
        let mut parts = line.split_whitespace();
        let name = parts.next().unwrap_or("");
        let arguments: Vec<&str> = parts.collect();
        let plain = |action: Action| {
            if arguments.is_empty() {
                Ok(action)
            } else {
                Err(json!({
                    "type": "action",
                    "action": name,
                    "ok": false,
                    "message": format!("{name} takes no arguments"),
                }))
            }
        };
        match name {
            "open-board" => plain(Action::OpenBoard),
            "backup-now" => plain(Action::BackUpNow),
            "restart-server" => plain(Action::RestartServer),
            "restart-worker" => plain(Action::RestartWorker),
            "disconnect-worker" => plain(Action::DisconnectWorker),
            "check-worker" => plain(Action::CheckWorker),
            "open-logs" => plain(Action::OpenLogs),
            "open-settings" => plain(Action::OpenSettings),
            "pair-device" => plain(Action::PairDevice),
            "connect-worker" => match arguments.as_slice() {
                [token, data_key] => Ok(Action::ConnectWorker {
                    token: (*token).to_string(),
                    data_key: (*data_key).to_string(),
                }),
                _ => Err(json!({
                    "type": "action",
                    "action": "connect-worker",
                    "ok": false,
                    "message": "connect-worker needs a token and a data key",
                })),
            },
            other => Err(json!({
                "type": "error",
                "message": format!("unknown action: {other}"),
            })),
        }
    }
}
