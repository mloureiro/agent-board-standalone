use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::app::Running;
use crate::backup::Outcome;
use crate::backup_desk::Desk;
use crate::opener::{self, Opener, SystemOpener};
use crate::services::Services;
use crate::signals;
use crate::status::Status;
use crate::worker_actions;

const NOT_IMPLEMENTED: [&str; 2] = ["open-board", "pair-device"];

const POLL: Duration = Duration::from_millis(25);

pub fn emit(out: &mut impl Write, event: &Value) {
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

pub fn state(running: &Running, status: &Status, backup: &Value) -> Value {
    let settings = match &running.settings {
        Ok(settings) => json!({
            "status": "loaded",
            "userName": settings.user_name,
            "port": settings.port,
            "dataDir": settings.data_dir,
            "backupDir": settings.backup_dir,
            "startAtLogin": settings.start_at_login,
            "remoteHosts": settings.remote_hosts,
            "requestSignature": settings.request_signature,
        }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    };
    json!({
        "type": "state",
        "pid": std::process::id(),
        "root": running.root.path(),
        "defaultRoot": running.root.is_default(),
        "keychainService": running.root.keychain_service(),
        "settings": settings,
        "supervision": status,
        "backup": backup,
    })
}

pub fn serve(running: &Running, input: impl BufRead + Send + 'static, out: &mut impl Write) {
    signals::install();
    serve_with(running, input, out, &SystemOpener, &signals::received);
}

enum Input {
    Line(String),
    Closed,
    Status,
    Backup(Outcome),
}

pub fn serve_with(
    running: &Running,
    input: impl BufRead + Send + 'static,
    out: &mut impl Write,
    opener: &dyn Opener,
    interrupted: &dyn Fn() -> Option<i32>,
) {
    let (sender, inbox) = mpsc::channel();
    let lines = sender.clone();
    thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if lines.send(Input::Line(line)).is_err() {
                return;
            }
        }
        let _ = lines.send(Input::Closed);
    });
    let reports = sender.clone();
    let changes = sender;
    let mut desk = Desk::new(running);
    let services = Services::start(
        running,
        Arc::new(move || {
            let _ = changes.send(Input::Status);
        }),
    );

    loop {
        if let Some(signal) = interrupted() {
            running
                .app_log
                .info(&format!("{} received, stopping", signals::name(signal)));
            break;
        }
        let received = match inbox.recv_timeout(POLL) {
            Ok(received) => received,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let line = match received {
            Input::Status => {
                emit(out, &state(running, &services.status(), &desk.view()));
                continue;
            }
            Input::Backup(outcome) => {
                desk.finish(&outcome);
                if outcome.resume_failed {
                    services.supervisor().restart_server();
                }
                emit(out, &backed_up(&outcome));
                emit(out, &state(running, &services.status(), &desk.view()));
                continue;
            }
            Input::Closed => break,
            Input::Line(line) => line,
        };
        let action = line.trim();
        let name = action.split_whitespace().next().unwrap_or("");
        match name {
            "" => {}
            "state" => emit(out, &state(running, &services.status(), &desk.view())),
            "backup-now" => {
                let report = reports.clone();
                match desk.start(services.supervisor().handle(), move |outcome| {
                    let _ = report.send(Input::Backup(outcome));
                }) {
                    Ok(()) => emit(out, &state(running, &services.status(), &desk.view())),
                    Err(message) => emit(
                        out,
                        &json!({
                            "type": "action",
                            "action": "backup-now",
                            "ok": false,
                            "message": message,
                        }),
                    ),
                }
            }
            "restart-server" => {
                services.supervisor().restart_server();
                emit(
                    out,
                    &json!({ "type": "action", "action": "restart-server", "ok": true }),
                );
            }
            "open-logs" => emit(
                out,
                &opened(
                    "open-logs",
                    opener::open_logs_folder(&running.paths, opener),
                ),
            ),
            "open-settings" => emit(
                out,
                &opened(
                    "open-settings",
                    opener::open_settings_file(&running.paths, opener),
                ),
            ),
            "connect-worker" => {
                let mut parts = action.split_whitespace().skip(1);
                let event = match (parts.next(), parts.next(), parts.next()) {
                    (Some(token), Some(data_key), None) => {
                        worker_actions::connect_worker(&services.worker, token, data_key)
                    }
                    _ => json!({
                        "type": "action",
                        "action": "connect-worker",
                        "ok": false,
                        "message": "connect-worker needs a token and a data key",
                    }),
                };
                emit(out, &event);
            }
            "disconnect-worker" => emit(out, &worker_actions::disconnect_worker(&services.worker)),
            "restart-worker" => emit(out, &worker_actions::restart_worker(&services.worker)),
            "check-worker" => emit(out, &worker_actions::check_worker(&services.worker, opener)),
            "quit" => break,
            deferred if NOT_IMPLEMENTED.contains(&deferred) => emit(
                out,
                &json!({
                    "type": "error",
                    "action": deferred,
                    "message": format!("{deferred} is not implemented in this build"),
                }),
            ),
            other => emit(
                out,
                &json!({ "type": "error", "message": format!("unknown action: {other}") }),
            ),
        }
    }
    desk.cancel();
    let last = services.stop();
    let changed = inbox
        .try_iter()
        .any(|received| matches!(received, Input::Status));
    if changed {
        emit(out, &state(running, &last, &desk.view()));
    }
    running.app_log.info("quit");
    emit(out, &json!({ "type": "quit" }));
}

fn opened(action: &str, result: std::io::Result<()>) -> Value {
    match result {
        Ok(()) => json!({ "type": "action", "action": action, "ok": true }),
        Err(error) => {
            json!({ "type": "action", "action": action, "ok": false, "message": error.to_string() })
        }
    }
}

fn backed_up(outcome: &Outcome) -> Value {
    match &outcome.result {
        Ok(name) => json!({ "type": "action", "action": "backup-now", "ok": true, "name": name }),
        Err(message) => {
            json!({ "type": "action", "action": "backup-now", "ok": false, "message": message })
        }
    }
}
