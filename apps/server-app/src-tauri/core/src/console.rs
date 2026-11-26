use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::SystemTime;

use serde_json::{Value, json};

use crate::actions::Action;
use crate::activity::{Activity, Busy};
use crate::app::Running;
use crate::backup::Outcome;
use crate::backup_desk::{BackupView, Desk};
use crate::control::ControlClient;
use crate::enrol::{EnrolError, EnrolForm, FormView};
use crate::handover::{self, CommandRunner};
use crate::log_file::AppLog;
use crate::menu::{Inputs, ItemId, Menu, worker_connected};
use crate::opener::{self, Opener};
use crate::pairing;
use crate::paths::AppPaths;
use crate::services::Services;
use crate::settings::{Settings, SettingsError};
use crate::setup::{SetupPlace, SetupStatus};
use crate::spec;
use crate::status::Status;
use crate::versions::Versions;
use crate::worker::NOT_CONNECTED;
use crate::worker_actions;

pub enum Event {
    Changed,
    Menu,
    Reply(Value),
}

pub type Events = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Console {
    services: RwLock<Option<Services>>,
    last: Mutex<Status>,
    desk: Mutex<Desk>,
    activity: Activity,
    form: Mutex<EnrolForm>,
    versions: Versions,
    settings: RwLock<Result<Settings, SettingsError>>,
    setup: SetupPlace,
    resources: PathBuf,
    control_socket: PathBuf,
    paths: AppPaths,
    log: AppLog,
    opener: Arc<dyn Opener>,
    runner: Arc<dyn CommandRunner>,
    events: Events,
}

fn failed(action: &str, message: impl Into<String>) -> Value {
    json!({ "type": "action", "action": action, "ok": false, "message": message.into() })
}

fn opened(action: &str, result: std::io::Result<()>) -> Value {
    match result {
        Ok(()) => json!({ "type": "action", "action": action, "ok": true }),
        Err(error) => failed(action, error.to_string()),
    }
}

fn backed_up(outcome: &Outcome) -> Value {
    match &outcome.result {
        Ok(name) => json!({ "type": "action", "action": "backup-now", "ok": true, "name": name }),
        Err(message) => failed("backup-now", message.clone()),
    }
}

fn board_opened(settings: &Settings, runner: &dyn CommandRunner) -> Value {
    let loopback = format!("http://127.0.0.1:{}/", settings.port);
    let browser = match &settings.public_url {
        Some(public_url) => crate::setup::sign_up_url(public_url),
        None => loopback.clone(),
    };
    let opened = handover::open_board(&loopback, &browser, runner);
    json!({
        "type": "action",
        "action": "open-board",
        "ok": opened.failure.is_none(),
        "message": opened.failure,
        "commands": opened.commands,
        "target": if opened.in_client_app { "client-app" } else { "browser" },
    })
}

impl Console {
    pub fn start(
        running: &Running,
        opener: Arc<dyn Opener>,
        runner: Arc<dyn CommandRunner>,
        events: Events,
    ) -> Arc<Console> {
        let services = Services::start(running, {
            let events = Arc::clone(&events);
            Arc::new(move || events(Event::Changed))
        });
        Arc::new(Console {
            last: Mutex::new(services.status()),
            services: RwLock::new(Some(services)),
            desk: Mutex::new(Desk::new(running)),
            activity: Activity::new(running.app_log.clone(), {
                let events = Arc::clone(&events);
                Arc::new(move || events(Event::Menu))
            }),
            form: Mutex::new(EnrolForm::new()),
            versions: running.versions.clone(),
            settings: RwLock::new(running.settings.clone()),
            setup: running.setup.clone(),
            resources: running.resources.clone(),
            control_socket: spec::control_socket(&running.paths),
            paths: running.paths.clone(),
            log: running.app_log.clone(),
            opener,
            runner,
            events,
        })
    }

    pub fn status(&self) -> Status {
        match self.services.read().unwrap().as_ref() {
            Some(services) => services.status(),
            None => self.last.lock().unwrap().clone(),
        }
    }

    pub fn backup_view(&self) -> BackupView {
        self.desk.lock().unwrap().view()
    }

    pub fn settings(&self) -> Result<Settings, SettingsError> {
        self.settings.read().unwrap().clone()
    }

    fn signature_and_remote(&self) -> (bool, bool) {
        match self.settings.read().unwrap().as_ref() {
            Ok(settings) => (settings.request_signature, settings.remote()),
            Err(_) => (false, false),
        }
    }

    pub fn menu(&self) -> Menu {
        let status = self.status();
        let backup = self.backup_view();
        let (request_signature, remote) = self.signature_and_remote();
        Menu::build(&Inputs {
            status: &status,
            backup: &backup,
            versions: &self.versions,
            request_signature,
            remote,
            busy: &self.activity.active(),
        })
    }

    pub fn setup(&self) -> &SetupPlace {
        &self.setup
    }

    pub fn setup_status(&self) -> Result<SetupStatus, String> {
        self.setup.status(worker_connected(&self.status()))
    }

    pub fn open_in_browser(&self, url: &str) -> Result<(), String> {
        match self.runner.run(&[url.to_string()]) {
            Ok(0) => Ok(()),
            Ok(code) => Err(format!("open exited with {code}")),
            Err(error) => Err(format!("open failed: {error}")),
        }
    }

    fn reload(&self) -> Result<Option<crate::spec::ChildSpec>, String> {
        let current = self.settings.read().unwrap().clone();
        let Ok(current) = current else {
            return Ok(None);
        };
        let (settings, spec) = self.setup.api_plan(&current, &self.resources)?;
        if settings != current {
            self.log.info(&format!(
                "settings reloaded, remote access {}",
                if settings.remote() { "on" } else { "off" }
            ));
        }
        *self.settings.write().unwrap() = Ok(settings);
        Ok(Some(spec))
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    fn begin_quit(&self) {
        if !self.activity.active().contains(&Busy::Quit)
            && let Ok(ticket) = self.activity.begin(Busy::Quit)
        {
            ticket.keep();
        }
    }

    pub fn request_quit(&self) {
        self.begin_quit();
        self.desk.lock().unwrap().cancel();
    }

    pub fn stop(&self) -> Status {
        self.request_quit();
        let services = self.services.write().unwrap().take();
        match services {
            Some(services) => {
                let last = services.stop();
                *self.last.lock().unwrap() = last.clone();
                last
            }
            None => self.last.lock().unwrap().clone(),
        }
    }

    fn refuse(&self, action: &str, reason: &str) -> Value {
        self.activity.refused(action, reason);
        failed(action, reason)
    }

    fn disabled_reason(&self, action: &Action, menu: &Menu) -> String {
        let id = action.item();
        let exempt = matches!(id, ItemId::OpenBoard | ItemId::ConnectWorker | ItemId::Quit);
        if let Some(busy) = menu.busy.first()
            && !exempt
        {
            return busy.reason().to_string();
        }
        let (request_signature, remote) = self.signature_and_remote();
        match id {
            ItemId::PairDevice if remote => pairing::REMOTE_ON.to_string(),
            ItemId::PairDevice if !request_signature => pairing::SIGNATURE_OFF.to_string(),
            ItemId::OpenBoard | ItemId::BackUpNow | ItemId::ConnectWorker | ItemId::PairDevice => {
                "the API is not running".to_string()
            }
            ItemId::RestartWorker | ItemId::DisconnectWorker | ItemId::CheckWorker => {
                NOT_CONNECTED.to_string()
            }
            _ => "this action is not available now".to_string(),
        }
    }

    pub fn may_open_connect(&self) -> bool {
        let menu = self.menu();
        if menu.item(ItemId::ConnectWorker).enabled {
            return true;
        }
        let action = Action::ConnectWorker {
            token: String::new(),
            data_key: String::new(),
        };
        self.refuse(action.name(), &self.disabled_reason(&action, &menu));
        false
    }

    fn busy_kind(action: &Action) -> Option<Busy> {
        match action {
            Action::BackUpNow => Some(Busy::Backup),
            Action::ConnectWorker { .. } => Some(Busy::Enrolment),
            Action::RestartServer
            | Action::RestartWorker
            | Action::DisconnectWorker
            | Action::CheckWorker => Some(Busy::Recovery),
            Action::OpenBoard | Action::OpenLogs | Action::OpenSettings | Action::PairDevice => {
                None
            }
        }
    }

    pub fn dispatch(self: &Arc<Self>, action: Action) -> Option<Value> {
        let name = action.name();
        let menu = self.menu();
        if !menu.item(action.item()).enabled {
            return Some(self.refuse(name, &self.disabled_reason(&action, &menu)));
        }
        let mut ticket = match Console::busy_kind(&action) {
            Some(kind) => match self.activity.begin(kind) {
                Ok(ticket) => Some(ticket),
                Err(blocking) => return Some(self.refuse(name, blocking.reason())),
            },
            None => None,
        };
        let guard = self.services.read().unwrap();
        let Some(services) = guard.as_ref() else {
            return Some(self.refuse(name, Busy::Quit.reason()));
        };
        match action {
            Action::OpenBoard => Some(match self.settings.read().unwrap().as_ref() {
                Ok(settings) => board_opened(settings, self.runner.as_ref()),
                Err(error) => failed(name, error.to_string()),
            }),
            Action::BackUpNow => {
                let held = ticket.take();
                let me = Arc::clone(self);
                let started = self
                    .desk
                    .lock()
                    .unwrap()
                    .start(services.supervisor().handle(), move |outcome| {
                        me.finish_backup(&outcome, held)
                    });
                match started {
                    Ok(()) => {
                        (self.events)(Event::Changed);
                        None
                    }
                    Err(message) => Some(failed(name, message)),
                }
            }
            Action::RestartServer => match self.reload() {
                Ok(Some(spec)) => {
                    services.supervisor().restart_server_with(spec);
                    (self.events)(Event::Changed);
                    Some(json!({ "type": "action", "action": name, "ok": true }))
                }
                Ok(None) => {
                    services.supervisor().restart_server();
                    Some(json!({ "type": "action", "action": name, "ok": true }))
                }
                Err(message) => {
                    self.log
                        .error(&format!("restart-server refused: {message}"));
                    Some(failed(name, message))
                }
            },
            Action::OpenLogs => Some(opened(
                name,
                opener::open_logs_folder(&self.paths, self.opener.as_ref()),
            )),
            Action::OpenSettings => Some(opened(
                name,
                opener::open_settings_file(&self.paths, self.opener.as_ref()),
            )),
            Action::ConnectWorker { token, data_key } => Some(worker_actions::connect_worker(
                &services.worker,
                &token,
                &data_key,
            )),
            Action::DisconnectWorker => Some(worker_actions::disconnect_worker(&services.worker)),
            Action::RestartWorker => Some(worker_actions::restart_worker(&services.worker)),
            Action::CheckWorker => Some(worker_actions::check_worker(
                &services.worker,
                self.opener.as_ref(),
            )),
            Action::PairDevice => {
                let control = ControlClient::new(self.control_socket.clone());
                Some(match pairing::issue(&control, SystemTime::now()) {
                    Ok(issued) => {
                        self.log.info("pairing code issued");
                        issued.to_json()
                    }
                    Err(message) => {
                        self.log
                            .error(&format!("pairing code not issued: {message}"));
                        failed(name, message)
                    }
                })
            }
        }
    }

    fn finish_backup(&self, outcome: &Outcome, held: Option<crate::activity::Ticket>) {
        self.desk.lock().unwrap().finish(outcome);
        if outcome.resume_failed
            && let Some(services) = self.services.read().unwrap().as_ref()
        {
            services.supervisor().restart_server();
        }
        (self.events)(Event::Reply(backed_up(outcome)));
        drop(held);
        (self.events)(Event::Changed);
    }

    pub fn form_view(&self) -> FormView {
        self.form.lock().unwrap().view()
    }

    pub fn form_set(&self, field: &str, value: &str) -> FormView {
        let mut form = self.form.lock().unwrap();
        match field {
            "token" => form.set_token(value),
            "data-key" => form.set_data_key(value),
            _ => {}
        }
        form.view()
    }

    pub fn form_can_close(&self) -> bool {
        self.form.lock().unwrap().can_close()
    }

    pub fn form_reset(&self) {
        let mut form = self.form.lock().unwrap();
        if form.can_close() {
            *form = EnrolForm::new();
        }
    }

    pub fn form_submit(self: &Arc<Self>) -> FormView {
        let begun = self.form.lock().unwrap().begin();
        if let Some((token, data_key)) = begun {
            let me = Arc::clone(self);
            thread::spawn(move || {
                let reply = me.dispatch(Action::ConnectWorker { token, data_key });
                let outcome = match reply {
                    Some(reply) if reply["ok"] == true => {
                        Ok(reply["machine"].as_str().unwrap_or_default().to_string())
                    }
                    Some(reply) => Err(EnrolError::Refused(
                        reply["message"].as_str().unwrap_or("refused").to_string(),
                    )),
                    None => Err(EnrolError::Failed("no answer".to_string())),
                };
                me.form.lock().unwrap().finish(outcome);
            });
        }
        self.form_view()
    }
}
