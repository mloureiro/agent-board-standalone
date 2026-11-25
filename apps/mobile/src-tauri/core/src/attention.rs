use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const POLL_SECONDS: u64 = 60;

#[derive(Deserialize)]
struct Answer {
    tasks: Vec<Task>,
}

#[derive(Deserialize)]
struct Task {
    id: String,
}

pub fn parse_attention(body: &[u8]) -> Result<Vec<String>, String> {
    serde_json::from_slice::<Answer>(body)
        .map(|answer| answer.tasks.into_iter().map(|task| task.id).collect())
        .map_err(|_| "invalid-answer".to_string())
}

pub fn notification_text(server_name: &str) -> String {
    format!("A task needs you on {server_name}")
}

#[derive(Default)]
pub struct AttentionState {
    seen: HashMap<String, HashSet<String>>,
}

impl AttentionState {
    pub fn update(&mut self, server_id: &str, ids: Vec<String>) -> Vec<String> {
        let current: HashSet<String> = ids.iter().cloned().collect();
        let fresh = match self.seen.get(server_id) {
            None => Vec::new(),
            Some(previous) => ids
                .into_iter()
                .filter(|id| !previous.contains(id))
                .collect(),
        };
        self.seen.insert(server_id.to_string(), current);
        fresh
    }

    pub fn tracked(&self) -> Vec<String> {
        self.seen.keys().cloned().collect()
    }

    pub fn forget(&mut self, server_id: &str) {
        self.seen.remove(server_id);
    }
}
