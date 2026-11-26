use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use serde_json::{Value, json};

use crate::app::Running;
use crate::backup::{ApiHold, Backups, Outcome};
use crate::control::ControlClient;
use crate::log_file::AppLog;
use crate::spec;
use crate::supervisor::Handle;

pub struct ServerHold {
    pub handle: Handle,
    pub control: ControlClient,
}

impl ApiHold for ServerHold {
    fn hold(&self) -> Result<(), String> {
        self.handle.set_hold(true);
        self.control.hold().map_err(|error| error.to_string())
    }

    fn resume(&self) -> Result<(), String> {
        let resumed = self.control.resume().map_err(|error| error.to_string());
        self.handle.set_hold(false);
        resumed
    }
}

pub struct Desk {
    backups: Result<Backups, String>,
    socket: std::path::PathBuf,
    log: AppLog,
    in_progress: bool,
    last_error: Option<String>,
    cancel: Arc<AtomicBool>,
}

impl Desk {
    pub fn new(running: &Running) -> Desk {
        Desk {
            backups: match &running.settings {
                Ok(settings) => Ok(Backups::new(
                    settings.backup_dir.clone(),
                    settings.data_dir.clone(),
                )),
                Err(error) => Err(error.to_string()),
            },
            socket: spec::control_socket(&running.paths),
            log: running.app_log.clone(),
            in_progress: false,
            last_error: None,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn view(&self) -> Value {
        json!({
            "inProgress": self.in_progress,
            "lastBackup": self.backups.as_ref().ok().and_then(Backups::last_manual),
            "lastError": self.last_error,
        })
    }

    pub fn start(
        &mut self,
        handle: Handle,
        done: impl FnOnce(Outcome) + Send + 'static,
    ) -> Result<(), String> {
        let backups = self.backups.clone()?;
        if self.in_progress {
            return Err("a backup is already running".to_string());
        }
        self.in_progress = true;
        self.last_error = None;
        let hold = ServerHold {
            handle,
            control: ControlClient::new(self.socket.clone()),
        };
        let cancel = Arc::clone(&self.cancel);
        let log = self.log.clone();
        thread::spawn(move || {
            log.info("backup started");
            let outcome = backups.manual(&hold, &cancel, &log);
            match &outcome.result {
                Ok(name) => log.info(&format!("backup {name} finished")),
                Err(message) => log.error(&format!("backup failed: {message}")),
            }
            done(outcome);
        });
        Ok(())
    }

    pub fn finish(&mut self, outcome: &Outcome) {
        self.in_progress = false;
        self.last_error = outcome.result.as_ref().err().cloned();
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}
