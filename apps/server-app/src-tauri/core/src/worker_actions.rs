use std::fs;

use serde_json::{Value, json};

use crate::check_worker::{self, LOG_FILE};
use crate::credential_flow::read_pair;
use crate::enrol::Enrolment;
use crate::opener::Opener;
use crate::worker::{NOT_CONNECTED, Worker, pause_grace_seconds};
use crate::worker_paths::path_value;

fn result(action: &str, outcome: Result<String, String>) -> Value {
    match outcome {
        Ok(message) => {
            json!({ "type": "action", "action": action, "ok": true, "message": message })
        }
        Err(message) => {
            json!({ "type": "action", "action": action, "ok": false, "message": message })
        }
    }
}

fn connected(worker: &Worker) -> Result<(), String> {
    let setup = worker.setup();
    match read_pair(setup.store.as_ref(), &setup.service, false) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(NOT_CONNECTED.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

fn with_enrolment<T>(worker: &Worker, act: impl FnOnce(&Enrolment) -> T) -> T {
    let setup = worker.setup();
    let lifecycle = worker.lifecycle();
    let profile_config = setup.paths.profile_config();
    act(&Enrolment {
        store: setup.store.as_ref(),
        service: &setup.service,
        cli: worker.cli().as_ref(),
        lifecycle: &lifecycle,
        profile_config: &profile_config,
        pause_grace_seconds: pause_grace_seconds(setup),
        log: &setup.log,
    })
}

pub fn connect_worker(worker: &Worker, token: &str, data_key: &str) -> Value {
    match with_enrolment(worker, |enrolment| enrolment.connect(token, data_key)) {
        Ok(machine) => json!({
            "type": "action",
            "action": "connect-worker",
            "ok": true,
            "machine": machine,
            "message": format!("Connected as {machine}"),
        }),
        Err(error) => result("connect-worker", Err(error.reason().to_string())),
    }
}

pub fn disconnect_worker(worker: &Worker) -> Value {
    result(
        "disconnect-worker",
        with_enrolment(worker, |enrolment| enrolment.disconnect())
            .map(|()| NOT_CONNECTED.to_string()),
    )
}

pub fn restart_worker(worker: &Worker) -> Value {
    let outcome = connected(worker).map(|()| {
        worker.restart();
        "restarted".to_string()
    });
    result("restart-worker", outcome)
}

pub fn check_worker(worker: &Worker, opener: &dyn Opener) -> Value {
    result("check-worker", run_check(worker, opener))
}

fn run_check(worker: &Worker, opener: &dyn Opener) -> Result<String, String> {
    connected(worker)?;
    let setup = worker.setup();
    let recipe = worker.cli().recipe()?;
    let doctor = worker.cli().doctor(&recipe)?;
    let path = path_value(&setup.paths, &setup.path_entries, &recipe.path_tail);
    let report = check_worker::evaluate(&doctor, &check_worker::dropped_checks(), &path)?;
    let log = setup.app_paths.logs_dir().join(LOG_FILE);
    fs::create_dir_all(setup.app_paths.logs_dir()).map_err(|error| error.to_string())?;
    fs::write(
        &log,
        format!("{}\n{}\n", report.lines.join("\n"), report.summary()),
    )
    .map_err(|error| error.to_string())?;
    if let Err(error) = opener.open(&log) {
        setup.log.error(&format!("check log not opened: {error}"));
    }
    Ok(report.summary())
}
