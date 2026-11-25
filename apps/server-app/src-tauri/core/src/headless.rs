use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::app::Running;
use crate::opener::{self, Opener, SystemOpener};

pub fn emit(out: &mut impl Write, event: &Value) {
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

pub fn state(running: &Running) -> Value {
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
    })
}

pub fn serve(running: &Running, input: impl BufRead, out: &mut impl Write) {
    serve_with(running, input, out, &SystemOpener);
}

pub fn serve_with(
    running: &Running,
    input: impl BufRead,
    out: &mut impl Write,
    opener: &dyn Opener,
) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        let action = line.trim();
        match action {
            "" => {}
            "state" => emit(out, &state(running)),
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
            "quit" => break,
            other => emit(
                out,
                &json!({ "type": "error", "message": format!("unknown action: {other}") }),
            ),
        }
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
