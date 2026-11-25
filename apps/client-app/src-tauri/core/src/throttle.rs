use crate::ids::ServerId;
use std::collections::HashMap;

pub const BEAT_SECS: u64 = 5;
pub const MISSED_BEATS: u64 = 3;
pub const STRETCH_ALLOWANCE: u64 = 2;
pub const SILENCE_SECS: u64 = BEAT_SECS * MISSED_BEATS * STRETCH_ALLOWANCE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Live,
    Throttled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    pub server: ServerId,
    pub state: State,
}

struct Entry {
    hidden: bool,
    last_beat: u64,
    throttled: bool,
}

#[derive(Default)]
pub struct Throttle {
    servers: HashMap<ServerId, Entry>,
}

impl Throttle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_throttled(&self, server: ServerId) -> bool {
        self.servers
            .get(&server)
            .is_some_and(|entry| entry.throttled)
    }

    pub fn set_hidden(&mut self, server: ServerId, hidden: bool, now_secs: u64) -> Option<Change> {
        let entry = self.servers.entry(server).or_insert(Entry {
            hidden,
            last_beat: now_secs,
            throttled: false,
        });
        if hidden && !entry.hidden {
            entry.last_beat = now_secs;
        }
        entry.hidden = hidden;
        if hidden {
            return None;
        }
        Self::go_live(server, entry)
    }

    pub fn heartbeat(&mut self, server: ServerId, now_secs: u64) -> Option<Change> {
        let entry = self.servers.entry(server).or_insert(Entry {
            hidden: false,
            last_beat: now_secs,
            throttled: false,
        });
        entry.last_beat = now_secs;
        Self::go_live(server, entry)
    }

    pub fn tick(&mut self, now_secs: u64) -> Vec<Change> {
        let mut changes: Vec<Change> = self
            .servers
            .iter_mut()
            .filter(|(_, entry)| {
                entry.hidden
                    && !entry.throttled
                    && now_secs.saturating_sub(entry.last_beat) >= SILENCE_SECS
            })
            .map(|(server, entry)| {
                entry.throttled = true;
                Change {
                    server: *server,
                    state: State::Throttled,
                }
            })
            .collect();
        changes.sort_by_key(|change| change.server.to_bytes());
        changes
    }

    pub fn forget(&mut self, server: ServerId) {
        self.servers.remove(&server);
    }

    fn go_live(server: ServerId, entry: &mut Entry) -> Option<Change> {
        if !entry.throttled {
            return None;
        }
        entry.throttled = false;
        Some(Change {
            server,
            state: State::Live,
        })
    }
}
