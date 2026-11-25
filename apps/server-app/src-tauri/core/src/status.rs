use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RowState {
    Off,
    Starting,
    Running,
    Restarting,
    GaveUp,
    Failed,
    Stopping,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub state: RowState,
    pub text: String,
}

impl Row {
    pub fn new(state: RowState, text: impl Into<String>) -> Row {
        Row {
            state,
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct GaveUp {
    pub api: bool,
    pub worker: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub api: Row,
    pub worker: Row,
    #[serde(rename = "gaveUp")]
    pub gave_up: GaveUp,
    pub blocked: Option<String>,
}

impl Status {
    pub fn initial() -> Status {
        Status {
            api: Row::new(RowState::Starting, "Starting"),
            worker: Row::new(RowState::Off, "Not set up"),
            gave_up: GaveUp::default(),
            blocked: None,
        }
    }
}
