use crate::ids::ServerId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogEvent {
    WindowOpened,
    OpenFailed,
    StoreDeletionFailed,
    TabFileCorrupt,
    TokenCleared,
    NotificationDenied,
    Throttled,
}

impl LogEvent {
    pub const ALL: [LogEvent; 7] = [
        Self::WindowOpened,
        Self::OpenFailed,
        Self::StoreDeletionFailed,
        Self::TabFileCorrupt,
        Self::TokenCleared,
        Self::NotificationDenied,
        Self::Throttled,
    ];

    pub fn text(self) -> &'static str {
        match self {
            Self::WindowOpened => "window opened",
            Self::OpenFailed => "open failed",
            Self::StoreDeletionFailed => "stored data deletion failed",
            Self::TabFileCorrupt => "tab file unreadable, restored home only",
            Self::TokenCleared => "stored token cleared",
            Self::NotificationDenied => "notification permission denied",
            Self::Throttled => "window throttled, polling attention",
        }
    }
}

pub fn line(server: ServerId, event: LogEvent) -> String {
    format!("server={server} {}", event.text())
}
