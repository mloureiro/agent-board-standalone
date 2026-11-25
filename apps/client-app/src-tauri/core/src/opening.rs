use crate::handshake::{ClientInfo, handshake};
use crate::ids::ServerId;
use crate::ports::Http;
use crate::servers::ServerEntry;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAction {
    Open,
    Remove,
    Rename,
}

pub fn window_error(action: WindowAction, name: &str, detail: &str) -> String {
    match action {
        WindowAction::Open => format!("{name} could not be opened: {detail}"),
        WindowAction::Remove => format!("{name}: the window could not be closed: {detail}"),
        WindowAction::Rename => {
            format!("The name was saved, but the window title could not be updated: {detail}")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opening {
    Focus(ServerId),
    CreateWindow {
        server: ServerId,
        request_signature: bool,
    },
    ListError {
        name: String,
        text: String,
    },
}

pub async fn plan_open(
    http: &impl Http,
    client: &ClientInfo,
    server: &ServerEntry,
    open_windows: &[ServerId],
) -> Opening {
    if open_windows.contains(&server.id) {
        return Opening::Focus(server.id);
    }
    match handshake(http, &server.url, client).await {
        Ok(outcome) => Opening::CreateWindow {
            server: server.id,
            request_signature: outcome.request_signature,
        },
        Err(failure) => Opening::ListError {
            name: server.name.clone(),
            text: window_error(WindowAction::Open, &server.name, &failure.text()),
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchWindow {
    ServerList,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LaunchPlan {
    pub windows: Vec<LaunchWindow>,
}

pub fn launch_plan(_listed: &[ServerEntry]) -> LaunchPlan {
    LaunchPlan {
        windows: vec![LaunchWindow::ServerList],
    }
}
