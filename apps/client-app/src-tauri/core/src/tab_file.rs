use crate::ids::ServerId;
use crate::log::LogEvent;
use crate::orphans::tab_file_name;
use crate::ports::{FileStore, PortError};
use crate::tabs::Tabs;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u64 = 1;

#[derive(Serialize)]
struct FileOut<'a> {
    v: u64,
    panes: [PaneOut<'a>; 1],
    split: [f64; 0],
    focused: usize,
}

#[derive(Serialize)]
struct PaneOut<'a> {
    tabs: Vec<&'a str>,
    selected: usize,
}

#[derive(Deserialize)]
struct FileIn {
    v: u64,
    #[serde(default)]
    panes: Vec<PaneIn>,
}

#[derive(Deserialize)]
struct PaneIn {
    #[serde(default)]
    tabs: Vec<Value>,
    #[serde(default)]
    selected: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Unreadable;

pub struct Restored {
    pub tabs: Tabs,
    pub log: Option<LogEvent>,
}

pub fn encode(tabs: &Tabs) -> Vec<u8> {
    let (paths, selected) = tabs.saved();
    let file = FileOut {
        v: VERSION,
        panes: [PaneOut {
            tabs: paths,
            selected,
        }],
        split: [],
        focused: 0,
    };
    serde_json::to_vec_pretty(&file).unwrap_or_default()
}

pub fn decode(bytes: &[u8]) -> Result<Tabs, Unreadable> {
    let file: FileIn = serde_json::from_slice(bytes).map_err(|_| Unreadable)?;
    if file.v != VERSION {
        return Err(Unreadable);
    }
    let Some(pane) = file.panes.first() else {
        return Ok(Tabs::new());
    };
    let paths = pane
        .tabs
        .iter()
        .map(|entry| entry.as_str().unwrap_or_default());
    Ok(Tabs::restore(paths, pane.selected))
}

pub fn read(files: &impl FileStore, server: ServerId) -> Restored {
    let unreadable = Restored {
        tabs: Tabs::new(),
        log: Some(LogEvent::TabFileUnreadable),
    };
    match files.read(&tab_file_name(server)) {
        Ok(None) => Restored {
            tabs: Tabs::new(),
            log: None,
        },
        Ok(Some(bytes)) => match decode(&bytes) {
            Ok(tabs) => Restored { tabs, log: None },
            Err(Unreadable) => unreadable,
        },
        Err(_) => unreadable,
    }
}

pub fn write(files: &impl FileStore, server: ServerId, tabs: &Tabs) -> Result<(), PortError> {
    files.write(&tab_file_name(server), &encode(tabs))
}
