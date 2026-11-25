use crate::ids::ServerId;
use crate::opening::{WindowAction, window_error};
use std::time::Duration;

pub const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(200),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    CloseWindow,
    DeleteStores,
    DeleteStoresAfter(Duration),
    ReportWindowError(String),
    ReportStoreFailure(String),
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Deletion {
    Running { retries_used: usize },
    Done,
    Failed,
}

#[derive(Debug)]
pub struct Removal {
    server: ServerId,
    name: String,
    deletion: Deletion,
}

pub fn store_failure_message(name: &str) -> String {
    format!("Couldn't delete the stored data of {name}.")
}

impl Removal {
    pub fn start(server: ServerId, name: &str) -> (Self, Vec<Effect>) {
        let removal = Self {
            server,
            name: name.to_owned(),
            deletion: Deletion::Running { retries_used: 0 },
        };
        (removal, vec![Effect::CloseWindow, Effect::DeleteStores])
    }

    pub fn server(&self) -> ServerId {
        self.server
    }

    pub fn window_closed(&mut self, result: Result<(), String>) -> Vec<Effect> {
        match result {
            Ok(()) => Vec::new(),
            Err(detail) => vec![Effect::ReportWindowError(window_error(
                WindowAction::Remove,
                &self.name,
                &detail,
            ))],
        }
    }

    pub fn stores_deleted(&mut self, result: Result<(), String>) -> Vec<Effect> {
        let Deletion::Running { retries_used } = self.deletion else {
            return Vec::new();
        };
        if result.is_ok() {
            self.deletion = Deletion::Done;
            return vec![Effect::Finished];
        }
        match RETRY_DELAYS.get(retries_used) {
            Some(delay) => {
                self.deletion = Deletion::Running {
                    retries_used: retries_used + 1,
                };
                vec![Effect::DeleteStoresAfter(*delay)]
            }
            None => {
                self.deletion = Deletion::Failed;
                vec![Effect::ReportStoreFailure(store_failure_message(
                    &self.name,
                ))]
            }
        }
    }

    pub fn retry(&mut self) -> Vec<Effect> {
        if self.deletion != Deletion::Failed {
            return Vec::new();
        }
        self.deletion = Deletion::Running { retries_used: 0 };
        vec![Effect::DeleteStores]
    }
}
