use std::io::{BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::actions::Action;
use crate::app::Running;
use crate::backup_desk::BackupView;
use crate::console::{Console, Event};
use crate::handover::{CommandRunner, SystemRunner};
use crate::opener::{Opener, SystemOpener};
use crate::settings::{Settings, SettingsError};
use crate::signals;
use crate::status::Status;

const POLL: Duration = Duration::from_millis(25);

pub fn emit(out: &mut impl Write, event: &Value) {
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

pub fn state(
    running: &Running,
    settings: &Result<Settings, SettingsError>,
    status: &Status,
    backup: &BackupView,
) -> Value {
    let settings = match settings {
        Ok(settings) => json!({
            "status": "loaded",
            "userName": settings.user_name,
            "port": settings.port,
            "dataDir": settings.data_dir,
            "backupDir": settings.backup_dir,
            "startAtLogin": settings.start_at_login,
            "remoteHosts": settings.remote_hosts,
            "requestSignature": settings.request_signature,
            "publicUrl": settings.public_url,
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
    serve_with(
        running,
        input,
        out,
        Arc::new(SystemOpener::new(running.open_program.clone())),
        Arc::new(SystemRunner::new(running.open_program.clone())),
        &signals::received,
    );
}

enum Input {
    Line(String),
    Closed,
    Status,
    Reply(Value),
}

pub fn serve_with(
    running: &Running,
    input: impl BufRead + Send + 'static,
    out: &mut impl Write,
    opener: Arc<dyn Opener>,
    runner: Arc<dyn CommandRunner>,
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
    let changes = Mutex::new(sender);
    let console = Console::start(
        running,
        opener,
        runner,
        Arc::new(move |event| {
            let message = match event {
                Event::Changed => Input::Status,
                Event::Reply(reply) => Input::Reply(reply),
                Event::Menu => return,
            };
            let _ = changes.lock().unwrap().send(message);
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
                emit(
                    out,
                    &state(
                        running,
                        &console.settings(),
                        &console.status(),
                        &console.backup_view(),
                    ),
                );
                continue;
            }
            Input::Reply(reply) => {
                emit(out, &reply);
                continue;
            }
            Input::Closed => break,
            Input::Line(line) => line,
        };
        let action = line.trim();
        match action.split_whitespace().next().unwrap_or("") {
            "" => {}
            "state" => emit(
                out,
                &state(
                    running,
                    &console.settings(),
                    &console.status(),
                    &console.backup_view(),
                ),
            ),
            "menu" => emit(out, &console.menu().to_json()),
            "quit" => break,
            _ => match Action::parse(action) {
                Ok(action) => {
                    if let Some(reply) = console.dispatch(action) {
                        emit(out, &reply);
                    }
                }
                Err(reply) => emit(out, &reply),
            },
        }
    }
    let last = console.stop();
    let changed = inbox
        .try_iter()
        .any(|received| matches!(received, Input::Status));
    if changed {
        emit(
            out,
            &state(running, &console.settings(), &last, &console.backup_view()),
        );
    }
    running.app_log.info("quit");
    emit(out, &json!({ "type": "quit" }));
}
