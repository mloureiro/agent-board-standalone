use std::fmt;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::cli_run::WorkerCli;
use crate::credential_flow::{
    DATA_KEY_VARIABLE, Pair, TOKEN_VARIABLE, clear_pair, normalize_secret, read_pair, write_pair,
};
use crate::credentials::{
    CredentialStore, PENDING_WORKER_DATA_KEY, PENDING_WORKER_TOKEN, WORKER_DATA_KEY, WORKER_TOKEN,
};
use crate::log_file::AppLog;
use crate::redact::redact;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrolError {
    Invalid(String),
    Refused(String),
    Failed(String),
}

impl EnrolError {
    pub fn reason(&self) -> &str {
        match self {
            EnrolError::Invalid(reason)
            | EnrolError::Refused(reason)
            | EnrolError::Failed(reason) => reason,
        }
    }
}

impl fmt::Display for EnrolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

pub trait Lifecycle {
    fn stop(&self) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
}

pub struct Enrolment<'a> {
    pub store: &'a dyn CredentialStore,
    pub service: &'a str,
    pub cli: &'a dyn WorkerCli,
    pub lifecycle: &'a dyn Lifecycle,
    pub profile_config: &'a Path,
    pub pause_grace_seconds: u64,
    pub log: &'a AppLog,
}

struct Step<'s> {
    name: &'static str,
    apply: Box<dyn Fn() -> Result<(), String> + 's>,
    undo: Box<dyn Fn() -> Result<(), String> + 's>,
}

fn text_of<E: fmt::Display>(error: E) -> String {
    redact(&error.to_string())
}

fn restoring<'s>(
    store: &'s dyn CredentialStore,
    service: &'s str,
    account: &'static str,
    previous: Option<String>,
) -> Box<dyn Fn() -> Result<(), String> + 's> {
    Box::new(move || match &previous {
        Some(value) => store.set(service, account, value).map_err(text_of),
        None => store.delete(service, account).map_err(text_of),
    })
}

fn setting<'s>(
    store: &'s dyn CredentialStore,
    service: &'s str,
    account: &'static str,
    value: String,
) -> Box<dyn Fn() -> Result<(), String> + 's> {
    Box::new(move || store.set(service, account, &value).map_err(text_of))
}

fn deleting<'s>(
    store: &'s dyn CredentialStore,
    service: &'s str,
    account: &'static str,
) -> Box<dyn Fn() -> Result<(), String> + 's> {
    Box::new(move || store.delete(service, account).map_err(text_of))
}

pub fn set_machine(config: &Path, machine: &str) -> Result<(), String> {
    let text = fs::read_to_string(config).unwrap_or_default();
    let line = format!("machine: {machine}");
    let mut replaced = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|existing| {
            if existing.starts_with("machine:") {
                replaced = true;
                line.clone()
            } else {
                existing.to_string()
            }
        })
        .collect();
    if !replaced {
        lines.insert(0, line);
    }
    fs::write(config, format!("{}\n", lines.join("\n"))).map_err(text_of)
}

fn restore_file(config: &Path, previous: Option<String>) -> Result<(), String> {
    match previous {
        Some(text) => fs::write(config, text).map_err(text_of),
        None => match fs::remove_file(config) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(text_of(error)),
            _ => Ok(()),
        },
    }
}

impl Enrolment<'_> {
    fn rollback(&self, steps: &[Step], failed_at: usize) {
        for step in steps[..=failed_at].iter().rev() {
            if let Err(error) = (step.undo)() {
                self.log
                    .error(&format!("rollback of {} failed: {error}", step.name));
            }
        }
    }

    fn promote(&self, new: &Pair, machine: &str) -> Result<(), String> {
        let (store, service) = (self.store, self.service);
        let get = |account: &str| store.get(service, account).map_err(text_of);
        let (old_token, old_key) = (get(WORKER_TOKEN)?, get(WORKER_DATA_KEY)?);
        let config = self.profile_config;
        let old_config = fs::read_to_string(config).ok();
        let steps = [
            Step {
                name: "token",
                apply: setting(store, service, WORKER_TOKEN, new.token.clone()),
                undo: restoring(store, service, WORKER_TOKEN, old_token),
            },
            Step {
                name: "data key",
                apply: setting(store, service, WORKER_DATA_KEY, new.data_key.clone()),
                undo: restoring(store, service, WORKER_DATA_KEY, old_key),
            },
            Step {
                name: "machine",
                apply: Box::new(move || set_machine(config, machine)),
                undo: Box::new(move || restore_file(config, old_config.clone())),
            },
            Step {
                name: "pending token",
                apply: deleting(store, service, PENDING_WORKER_TOKEN),
                undo: setting(store, service, PENDING_WORKER_TOKEN, new.token.clone()),
            },
            Step {
                name: "pending data key",
                apply: deleting(store, service, PENDING_WORKER_DATA_KEY),
                undo: setting(
                    store,
                    service,
                    PENDING_WORKER_DATA_KEY,
                    new.data_key.clone(),
                ),
            },
        ];
        for (index, step) in steps.iter().enumerate() {
            if let Err(error) = (step.apply)() {
                self.log
                    .error(&format!("promotion failed at {}: {error}", step.name));
                self.rollback(&steps, index);
                return Err(format!("promoting the {} failed: {error}", step.name));
            }
        }
        Ok(())
    }

    fn discard_pending(&self) {
        if let Err(error) = clear_pair(self.store, self.service, true) {
            self.log
                .error(&format!("pending pair not discarded: {error}"));
        }
    }

    pub fn connect(&self, token: &str, data_key: &str) -> Result<String, EnrolError> {
        let new = Pair {
            token: normalize_secret(token, TOKEN_VARIABLE, "token").map_err(EnrolError::Invalid)?,
            data_key: normalize_secret(data_key, DATA_KEY_VARIABLE, "data key")
                .map_err(EnrolError::Invalid)?,
        };
        let recipe = self.cli.recipe().map_err(EnrolError::Failed)?;
        write_pair(self.store, self.service, true, &new)
            .map_err(|error| EnrolError::Failed(text_of(error)))?;
        let machine = match self.cli.check_pending(&recipe) {
            Ok(machine) => machine,
            Err(reason) => {
                self.discard_pending();
                self.log.info("worker pair refused");
                return Err(EnrolError::Refused(reason));
            }
        };
        if let Err(reason) = self.lifecycle.stop() {
            self.discard_pending();
            return Err(EnrolError::Failed(reason));
        }
        if let Err(reason) = self.cli.pause_cards(&recipe, self.pause_grace_seconds) {
            self.log.error(&format!("pausing cards failed: {reason}"));
        }
        let promoted = self.promote(&new, &machine);
        self.discard_pending();
        let started = self.lifecycle.start();
        promoted.map_err(EnrolError::Failed)?;
        started.map_err(EnrolError::Failed)?;
        self.log.info(&format!("worker connected as {machine}"));
        Ok(machine)
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.lifecycle.stop()?;
        if let Ok(recipe) = self.cli.recipe()
            && let Err(reason) = self.cli.pause_cards(&recipe, self.pause_grace_seconds)
        {
            self.log.error(&format!("pausing cards failed: {reason}"));
        }
        clear_pair(self.store, self.service, false).map_err(text_of)?;
        clear_pair(self.store, self.service, true).map_err(text_of)?;
        self.lifecycle.start()
    }
}

pub fn discard_stale_pending(store: &dyn CredentialStore, service: &str, log: &AppLog) {
    match read_pair(store, service, true) {
        Ok(None) => {}
        Ok(Some(_)) => log.info("a pending worker pair from an earlier run was discarded"),
        Err(error) => log.error(&format!("pending pair unreadable: {error}")),
    }
    if let Err(error) = clear_pair(store, service, true) {
        log.error(&format!("pending pair not discarded: {error}"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Editing,
    Connecting,
    Failed,
    Connected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldView {
    pub label: &'static str,
    pub mask: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FormView {
    pub fields: [FieldView; 2],
    pub connect_enabled: bool,
    pub status: Option<String>,
    pub can_close: bool,
}

pub const MASK_CHARACTER: char = '\u{2022}';

#[derive(Debug, Clone)]
pub struct EnrolForm {
    token: String,
    data_key: String,
    phase: Phase,
    message: String,
}

impl Default for EnrolForm {
    fn default() -> Self {
        EnrolForm::new()
    }
}

impl EnrolForm {
    pub fn new() -> EnrolForm {
        EnrolForm {
            token: String::new(),
            data_key: String::new(),
            phase: Phase::Editing,
            message: String::new(),
        }
    }

    pub fn set_token(&mut self, value: &str) {
        if self.phase != Phase::Connecting {
            self.token = value.to_string();
        }
    }

    pub fn set_data_key(&mut self, value: &str) {
        if self.phase != Phase::Connecting {
            self.data_key = value.to_string();
        }
    }

    pub fn can_connect(&self) -> bool {
        self.phase != Phase::Connecting
            && !self.token.trim().is_empty()
            && !self.data_key.trim().is_empty()
    }

    pub fn begin(&mut self) -> Option<(String, String)> {
        if !self.can_connect() {
            return None;
        }
        self.phase = Phase::Connecting;
        Some((self.token.clone(), self.data_key.clone()))
    }

    pub fn finish(&mut self, outcome: Result<String, EnrolError>) {
        match outcome {
            Ok(machine) => {
                self.phase = Phase::Connected;
                self.message = format!("Connected as {machine}");
                self.token.clear();
                self.data_key.clear();
            }
            Err(error) => {
                self.phase = Phase::Failed;
                self.message = error.reason().to_string();
            }
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn can_close(&self) -> bool {
        self.phase != Phase::Connecting
    }

    pub fn view(&self) -> FormView {
        let field = |label, value: &str| FieldView {
            label,
            mask: MASK_CHARACTER.to_string().repeat(value.chars().count()),
            count: value.chars().count(),
        };
        FormView {
            fields: [
                field("Token", &self.token),
                field("Data key", &self.data_key),
            ],
            connect_enabled: self.can_connect(),
            status: match self.phase {
                Phase::Editing => None,
                Phase::Connecting => Some("Connecting\u{2026}".to_string()),
                Phase::Failed | Phase::Connected => Some(self.message.clone()),
            },
            can_close: self.can_close(),
        }
    }
}
