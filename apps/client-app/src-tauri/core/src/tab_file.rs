use crate::ids::ServerId;
use crate::log::LogEvent;
use crate::orphans::tab_file_name;
use crate::ports::{FileStore, PortError};
use crate::tabs::{PaneSpec, Tabs};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u64 = 1;

#[derive(Serialize)]
struct FileOut<'a> {
    v: u64,
    panes: Vec<PaneOut<'a>>,
    split: &'a [f64],
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
    #[serde(default)]
    split: Value,
    #[serde(default)]
    focused: Value,
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
    let saved = tabs.saved();
    let file = FileOut {
        v: VERSION,
        panes: saved
            .panes
            .into_iter()
            .map(|pane| PaneOut {
                tabs: pane.paths,
                selected: pane.selected,
            })
            .collect(),
        split: saved.split,
        focused: saved.focused,
    };
    serde_json::to_vec_pretty(&file).unwrap_or_default()
}

fn edges(value: &Value) -> Option<Vec<f64>> {
    value
        .as_array()?
        .iter()
        .map(Value::as_f64)
        .collect::<Option<Vec<f64>>>()
}

pub fn decode(bytes: &[u8]) -> Result<Tabs, Unreadable> {
    let file: FileIn = serde_json::from_slice(bytes).map_err(|_| Unreadable)?;
    if file.v != VERSION {
        return Err(Unreadable);
    }
    let specs: Vec<PaneSpec<'_>> = file
        .panes
        .iter()
        .map(|pane| PaneSpec {
            paths: pane
                .tabs
                .iter()
                .map(|entry| entry.as_str().unwrap_or_default())
                .collect(),
            selected: pane.selected,
        })
        .collect();
    let split = edges(&file.split);
    let focused = file
        .focused
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(0);
    Ok(Tabs::restore_panes(&specs, split.as_deref(), focused))
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
