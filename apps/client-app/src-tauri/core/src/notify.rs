use crate::ids::ServerId;
use crate::log::LogEvent;
use crate::page_input::{InputError, clean_title, task_id};
use std::collections::HashMap;

pub const DEDUPE_SECS: u64 = 60;
pub const MAX_TRACKED: usize = 256;
pub const EXPIRED_BANNER: &str =
    "Your session expired. Sign in again to keep receiving notifications.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotifyRequest {
    server: ServerId,
    server_name: String,
    task_id: Option<String>,
    title: String,
}

impl NotifyRequest {
    pub fn parse(
        server: ServerId,
        server_name: &str,
        task_id_text: Option<&str>,
        title: &str,
    ) -> Result<Self, InputError> {
        let task_id = task_id_text.map(task_id).transpose()?;
        let title = clean_title(title);
        if title.is_empty() {
            return Err(InputError::NotificationTitle);
        }
        Ok(Self {
            server,
            server_name: clean_title(server_name),
            task_id,
            title,
        })
    }

    pub fn server(&self) -> ServerId {
        self.server
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FocusState {
    pub key_window_server: Option<ServerId>,
    pub home_selected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Unknown,
    Granted,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserInfo {
    pub server_id: String,
    pub task_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    HomeInKeyWindow,
    Duplicate,
    PermissionDenied { log: Option<LogEvent> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Raise {
        title: String,
        subtitle: String,
        user_info: UserInfo,
        ask_permission: bool,
    },
    Suppress(Reason),
}

#[derive(Default)]
pub struct NotifyPolicy {
    raised: HashMap<(ServerId, Option<String>), u64>,
    denial_logged: bool,
}

impl NotifyPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decide(
        &mut self,
        request: &NotifyRequest,
        focus: FocusState,
        permission: Permission,
        now_secs: u64,
    ) -> Decision {
        if focus.home_selected && focus.key_window_server == Some(request.server) {
            return Decision::Suppress(Reason::HomeInKeyWindow);
        }
        self.raised
            .retain(|_, at| now_secs.saturating_sub(*at) < DEDUPE_SECS);
        let key = (request.server, request.task_id.clone());
        if self.raised.contains_key(&key) {
            return Decision::Suppress(Reason::Duplicate);
        }
        if permission == Permission::Denied {
            let log = (!self.denial_logged).then_some(LogEvent::NotificationDenied);
            self.denial_logged = true;
            return Decision::Suppress(Reason::PermissionDenied { log });
        }
        if self.raised.len() >= MAX_TRACKED
            && let Some(oldest) = self
                .raised
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
        {
            self.raised.remove(&oldest);
        }
        self.raised.insert(key, now_secs);
        Decision::Raise {
            title: request.title.clone(),
            subtitle: request.server_name.clone(),
            user_info: UserInfo {
                server_id: request.server.to_string(),
                task_id: request.task_id.clone(),
            },
            ask_permission: permission == Permission::Unknown,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Task(String),
    Home,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Click {
    Ignore,
    Focus { server: ServerId, tab: Target },
}

pub fn route_click(
    server_id: &str,
    task_id_text: Option<&str>,
    has_window: impl Fn(ServerId) -> bool,
) -> Click {
    let Ok(server) = ServerId::parse(server_id) else {
        return Click::Ignore;
    };
    if !has_window(server) {
        return Click::Ignore;
    }
    let tab = match task_id_text.map(task_id) {
        Some(Ok(id)) => Target::Task(id),
        _ => Target::Home,
    };
    Click::Focus { server, tab }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Banner {
    pub server: ServerId,
    pub text: Option<&'static str>,
}

pub fn expiry_banner(server: ServerId, expired: bool) -> Banner {
    Banner {
        server,
        text: expired.then_some(EXPIRED_BANNER),
    }
}
