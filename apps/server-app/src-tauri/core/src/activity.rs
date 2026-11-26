use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::log_file::AppLog;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Busy {
    Enrolment,
    Backup,
    Recovery,
    Quit,
}

impl Busy {
    pub fn reason(self) -> &'static str {
        match self {
            Busy::Enrolment => "a worker enrolment is running",
            Busy::Backup => "a backup is running",
            Busy::Recovery => "a recovery action is running",
            Busy::Quit => "the app is quitting",
        }
    }
}

fn conflicts(wanted: Busy, active: &[Busy]) -> Option<Busy> {
    match wanted {
        Busy::Quit => None,
        Busy::Enrolment => active
            .iter()
            .copied()
            .find(|kind| matches!(kind, Busy::Enrolment | Busy::Recovery | Busy::Quit)),
        Busy::Backup | Busy::Recovery => active.first().copied(),
    }
}

pub type Changed = Arc<dyn Fn() + Send + Sync>;

struct Inner {
    active: Mutex<Vec<Busy>>,
    changed: Changed,
    log: AppLog,
}

#[derive(Clone)]
pub struct Activity(Arc<Inner>);

pub struct Ticket {
    inner: Arc<Inner>,
    kind: Busy,
    keep: bool,
}

impl Activity {
    pub fn new(log: AppLog, changed: Changed) -> Activity {
        Activity(Arc::new(Inner {
            active: Mutex::new(Vec::new()),
            changed,
            log,
        }))
    }

    pub fn active(&self) -> Vec<Busy> {
        self.0.active.lock().unwrap().clone()
    }

    pub fn is_busy(&self) -> bool {
        !self.0.active.lock().unwrap().is_empty()
    }

    pub fn begin(&self, kind: Busy) -> Result<Ticket, Busy> {
        {
            let mut active = self.0.active.lock().unwrap();
            if let Some(blocking) = conflicts(kind, &active) {
                return Err(blocking);
            }
            active.push(kind);
        }
        (self.0.changed)();
        Ok(Ticket {
            inner: Arc::clone(&self.0),
            kind,
            keep: false,
        })
    }

    pub fn refused(&self, action: &str, reason: &str) {
        self.0.log.info(&format!("refused {action}: {reason}"));
    }
}

impl Ticket {
    pub fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        {
            let mut active = self.inner.active.lock().unwrap();
            if let Some(position) = active.iter().position(|kind| *kind == self.kind) {
                active.remove(position);
            }
        }
        (self.inner.changed)();
    }
}
