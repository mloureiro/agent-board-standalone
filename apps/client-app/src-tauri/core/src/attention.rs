use crate::ids::ServerId;
use crate::notify::NotifyRequest;
use crate::page_input::task_id;
use std::collections::{HashMap, HashSet};

pub const POLL_SECS: u64 = 30;
pub const MAX_IDS_PER_POLL: usize = 100;

struct Entry {
    next_poll: u64,
    baseline: Option<HashSet<String>>,
}

#[derive(Default)]
pub struct AttentionPoller {
    servers: HashMap<ServerId, Entry>,
}

impl AttentionPoller {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_polling(&self, server: ServerId) -> bool {
        self.servers.contains_key(&server)
    }

    pub fn start(&mut self, server: ServerId, now_secs: u64) {
        self.servers.entry(server).or_insert(Entry {
            next_poll: now_secs,
            baseline: None,
        });
    }

    pub fn stop(&mut self, server: ServerId) {
        self.servers.remove(&server);
    }

    pub fn due(&mut self, now_secs: u64) -> Vec<ServerId> {
        let mut due: Vec<ServerId> = self
            .servers
            .iter_mut()
            .filter(|(_, entry)| entry.next_poll <= now_secs)
            .map(|(server, entry)| {
                entry.next_poll = now_secs + POLL_SECS;
                *server
            })
            .collect();
        due.sort_by_key(|server| server.to_bytes());
        due
    }

    pub fn observe(
        &mut self,
        server: ServerId,
        server_name: &str,
        ids: &[String],
    ) -> Vec<NotifyRequest> {
        let Some(entry) = self.servers.get_mut(&server) else {
            return Vec::new();
        };
        let current: Vec<String> = ids
            .iter()
            .filter_map(|id| task_id(id).ok())
            .take(MAX_IDS_PER_POLL)
            .collect();
        let known = entry.baseline.replace(current.iter().cloned().collect());
        let Some(known) = known else {
            return Vec::new();
        };
        let title = format!("A task needs you on {server_name}");
        let mut seen = HashSet::new();
        current
            .iter()
            .filter(|id| !known.contains(*id) && seen.insert(id.as_str()))
            .filter_map(|id| NotifyRequest::parse(server, server_name, Some(id), &title).ok())
            .collect()
    }
}
