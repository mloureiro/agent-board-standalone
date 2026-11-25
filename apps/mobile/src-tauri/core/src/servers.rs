use crate::address::{AddressProblem, check_address};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub signed: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerList {
    pub servers: Vec<ServerEntry>,
}

impl ServerList {
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"servers\":[]}".to_string())
    }

    pub fn get(&self, id: &str) -> Option<&ServerEntry> {
        self.servers.iter().find(|entry| entry.id == id)
    }

    pub fn add(
        &mut self,
        id: String,
        name: &str,
        address: &str,
    ) -> Result<ServerEntry, AddressProblem> {
        let url = check_address(address)?;
        let name = name.trim();
        let name = if name.is_empty() {
            url.clone()
        } else {
            name.chars().take(80).collect()
        };
        let entry = ServerEntry {
            id,
            name,
            url,
            signed: false,
        };
        self.servers.push(entry.clone());
        Ok(entry)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        let name = name.trim();
        match self.servers.iter_mut().find(|entry| entry.id == id) {
            Some(entry) if !name.is_empty() => {
                entry.name = name.chars().take(80).collect();
                true
            }
            _ => false,
        }
    }

    pub fn remove(&mut self, id: &str) -> Option<ServerEntry> {
        let index = self.servers.iter().position(|entry| entry.id == id)?;
        Some(self.servers.remove(index))
    }

    pub fn mark_signed(&mut self, id: &str) {
        if let Some(entry) = self.servers.iter_mut().find(|entry| entry.id == id) {
            entry.signed = true;
        }
    }
}
