use crate::address::{AddressProblem, check_address};
use crate::ids::ServerId;
use crate::ports::{FileStore, PortError};
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

pub const SERVERS_FILE: &str = "servers.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ServerEntry {
    #[serde(serialize_with = "serialize_id")]
    pub id: ServerId,
    pub name: String,
    pub url: String,
}

fn serialize_id<S: serde::Serializer>(id: &ServerId, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(id)
}

#[derive(Serialize)]
struct Document<'a> {
    servers: &'a [ServerEntry],
}

#[derive(Debug, PartialEq, Eq)]
pub enum ServerError {
    Address(AddressProblem),
    BlankName,
    InvalidName,
    Unknown,
    Write(PortError),
}

fn parse_entry(value: &Value) -> Option<ServerEntry> {
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    Some(ServerEntry {
        id: ServerId::parse(text("id")?).ok()?,
        name: text("name")?.to_owned(),
        url: text("url")?.to_owned(),
    })
}

fn parse_list(contents: &[u8]) -> Vec<ServerEntry> {
    let Ok(document) = serde_json::from_slice::<Value>(contents) else {
        return Vec::new();
    };
    document
        .get("servers")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_entry).collect())
        .unwrap_or_default()
}

pub const NAME_MAX_CHARS: usize = 100;

pub fn trimmed_name(name: &str) -> Result<String, ServerError> {
    let name = name.trim();
    if name.is_empty() {
        Err(ServerError::BlankName)
    } else if name.chars().count() > NAME_MAX_CHARS || name.chars().any(char::is_control) {
        Err(ServerError::InvalidName)
    } else {
        Ok(name.to_owned())
    }
}

pub struct Servers<F> {
    files: F,
    entries: Mutex<Vec<ServerEntry>>,
}

impl<F: FileStore> Servers<F> {
    pub fn open(files: F) -> Self {
        let entries = files
            .read(SERVERS_FILE)
            .ok()
            .flatten()
            .map(|contents| parse_list(&contents))
            .unwrap_or_default();
        Self {
            files,
            entries: Mutex::new(entries),
        }
    }

    pub fn list(&self) -> Vec<ServerEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn get(&self, id: ServerId) -> Option<ServerEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
    }

    fn change<T>(
        &self,
        edit: impl FnOnce(&mut Vec<ServerEntry>) -> Result<T, ServerError>,
    ) -> Result<T, ServerError> {
        let mut entries = self.entries.lock().unwrap();
        let mut next = entries.clone();
        let outcome = edit(&mut next)?;
        let document = serde_json::to_vec_pretty(&Document { servers: &next })
            .map_err(|error| ServerError::Write(PortError(error.to_string())))?;
        self.files
            .write(SERVERS_FILE, &document)
            .map_err(ServerError::Write)?;
        *entries = next;
        Ok(outcome)
    }

    pub fn add(&self, id: ServerId, name: &str, address: &str) -> Result<ServerEntry, ServerError> {
        let url = check_address(address).map_err(ServerError::Address)?;
        let name = trimmed_name(name)?;
        let entry = ServerEntry { id, name, url };
        self.change(|entries| {
            entries.push(entry.clone());
            Ok(entry)
        })
    }

    pub fn rename(&self, id: ServerId, name: &str) -> Result<ServerEntry, ServerError> {
        let name = trimmed_name(name)?;
        self.change(|entries| {
            let entry = entries
                .iter_mut()
                .find(|entry| entry.id == id)
                .ok_or(ServerError::Unknown)?;
            entry.name = name;
            Ok(entry.clone())
        })
    }

    pub fn remove(&self, id: ServerId) -> Result<ServerEntry, ServerError> {
        self.change(|entries| {
            let index = entries
                .iter()
                .position(|entry| entry.id == id)
                .ok_or(ServerError::Unknown)?;
            Ok(entries.remove(index))
        })
    }
}
