use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::cli::SetupCommand;
use crate::credential_flow;
use crate::credentials::{CredentialStore, SIGNUP_TOKEN};
use crate::paths::AppPaths;
use crate::settings::{self, Settings};
use crate::spec::{self, ChildSpec};

pub const APPLY: &str =
    "Restart the server from the tray (Restart server) or quit and reopen the app to apply.";
pub const REMOTE_OFF: &str =
    "remote access is off: turn it on with the tunnel's https address first";
pub const TOKEN_BYTES: usize = 32;
pub const REFUSED_EXIT_CODE: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignIn {
    NoLogin,
    Passkeys,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub remote: bool,
    pub public_url: Option<String>,
    pub sign_in: SignIn,
    pub first_passkey_open: bool,
    pub worker_connected: bool,
    pub user_name: String,
    pub port: u16,
    pub settings_file: PathBuf,
}

#[derive(Clone, PartialEq, Eq)]
pub struct FirstPasskey {
    pub sign_up_url: String,
    pub user_name: String,
    pub token: String,
}

impl std::fmt::Debug for FirstPasskey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FirstPasskey")
            .field("sign_up_url", &self.sign_up_url)
            .field("user_name", &self.user_name)
            .finish_non_exhaustive()
    }
}

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk.iter().enumerate().fold(0u32, |acc, (index, byte)| {
            acc | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..=chunk.len() {
            let sextet = (triple >> (18 - 6 * index)) & 0x3f;
            out.push(char::from(BASE64URL[sextet as usize]));
        }
    }
    out
}

pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|error| format!("no random bytes for the sign-up token: {error}"))?;
    Ok(base64url(&bytes))
}

pub fn sign_up_url(public_url: &str) -> String {
    format!("{public_url}/")
}

fn write_atomically(file: &Path, text: &str) -> std::io::Result<()> {
    let folder = file.parent().unwrap_or(Path::new("."));
    let mut name = file
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}.partial", std::process::id()));
    let temporary = folder.join(name);
    let written = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .and_then(|mut partial| {
            partial.write_all(text.as_bytes())?;
            partial.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, file));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

#[derive(Clone)]
pub struct SetupPlace {
    pub paths: AppPaths,
    pub login_name: String,
    pub service: String,
    pub store: Arc<dyn CredentialStore>,
}

impl SetupPlace {
    pub fn settings(&self) -> Result<Settings, String> {
        Settings::load(&self.paths, &self.login_name).map_err(|error| error.to_string())
    }

    pub fn signup_token(&self) -> Result<Option<String>, String> {
        self.store
            .get(&self.service, SIGNUP_TOKEN)
            .map(|token| token.filter(|token| !token.is_empty()))
            .map_err(|error| error.to_string())
    }

    pub fn worker_connected(&self) -> Result<bool, String> {
        credential_flow::read_pair(self.store.as_ref(), &self.service, false)
            .map(|pair| pair.is_some())
            .map_err(|error| error.to_string())
    }

    pub fn status(&self, worker_connected: bool) -> Result<SetupStatus, String> {
        let settings = self.settings()?;
        Ok(SetupStatus {
            remote: settings.remote(),
            sign_in: if settings.remote() {
                SignIn::Passkeys
            } else {
                SignIn::NoLogin
            },
            first_passkey_open: settings.remote() && self.signup_token()?.is_some(),
            worker_connected,
            user_name: settings.user_name,
            port: settings.port,
            public_url: settings.public_url,
            settings_file: self.paths.settings_file(),
        })
    }

    pub fn edit(&self, change: impl FnOnce(&mut Map<String, Value>)) -> Result<Settings, String> {
        Settings::create_if_missing(&self.paths, &self.login_name)
            .map_err(|error| error.to_string())?;
        let file = self.paths.settings_file();
        let text = fs::read_to_string(&file).map_err(|error| {
            format!("settings.json cannot be read ({}): {error}", file.display())
        })?;
        let mut document: Value = serde_json::from_str(&text)
            .map_err(|error| format!("settings.json is not valid: {error}"))?;
        let Some(object) = document.as_object_mut() else {
            return Err("settings.json is not valid: it must hold one object".to_string());
        };
        change(object);
        let edited = serde_json::to_string_pretty(&document)
            .map(|text| format!("{text}\n"))
            .map_err(|error| error.to_string())?;
        let settings = Settings::parse(&edited, &self.paths, &self.login_name)
            .map_err(|error| error.to_string())?;
        write_atomically(&file, &edited).map_err(|error| {
            format!(
                "settings.json cannot be written ({}): {error}",
                file.display()
            )
        })?;
        Ok(settings)
    }

    pub fn remote_on(&self, address: &str) -> Result<Settings, String> {
        let origin = settings::public_url(address.trim()).map_err(|error| error.to_string())?;
        self.edit(|document| {
            document.insert("publicUrl".to_string(), Value::String(origin));
        })
    }

    pub fn remote_off(&self) -> Result<Settings, String> {
        let settings = self.edit(|document| {
            document.remove("publicUrl");
            document.remove("remoteHosts");
        })?;
        self.first_passkey_close()?;
        Ok(settings)
    }

    pub fn first_passkey_open(&self) -> Result<FirstPasskey, String> {
        let settings = self.settings()?;
        let Some(public_url) = settings.public_url else {
            return Err(REMOTE_OFF.to_string());
        };
        let token = new_token()?;
        self.store
            .set(&self.service, SIGNUP_TOKEN, &token)
            .map_err(|error| error.to_string())?;
        Ok(FirstPasskey {
            sign_up_url: sign_up_url(&public_url),
            user_name: settings.user_name,
            token,
        })
    }

    pub fn first_passkey_close(&self) -> Result<(), String> {
        self.store
            .delete(&self.service, SIGNUP_TOKEN)
            .map_err(|error| error.to_string())
    }

    pub fn api_plan(
        &self,
        running: &Settings,
        resources: &Path,
    ) -> Result<(Settings, ChildSpec), String> {
        let fresh = self.settings()?;
        let settings = Settings {
            public_url: fresh.public_url,
            remote_hosts: fresh.remote_hosts,
            request_signature: fresh.request_signature,
            ..running.clone()
        };
        let token = if settings.remote() {
            self.signup_token()?
        } else {
            None
        };
        let spec = spec::api_spec(&settings, &self.paths, resources, token.as_deref())?;
        Ok((settings, spec))
    }
}

fn command_lines(place: &SetupPlace, command: &SetupCommand) -> Result<Vec<String>, String> {
    let apply = APPLY.to_string();
    match command {
        SetupCommand::Status => {
            let status = place.status(place.worker_connected()?)?;
            let json = serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?;
            Ok(vec![json])
        }
        SetupCommand::RemoteOn { public_url } => {
            let settings = place.remote_on(public_url)?;
            let origin = settings.public_url.unwrap_or_default();
            Ok(vec![
                format!("Remote access on at {origin}: the board now needs sign-in with passkeys."),
                apply,
            ])
        }
        SetupCommand::RemoteOff => {
            place.remote_off()?;
            Ok(vec![
                "Remote access off: the board runs without sign-in on this Mac only.".to_string(),
                apply,
            ])
        }
        SetupCommand::FirstPasskeyOpen => {
            let opened = place.first_passkey_open()?;
            Ok(vec![
                opened.sign_up_url,
                opened.user_name,
                opened.token,
                apply,
            ])
        }
        SetupCommand::FirstPasskeyDone => {
            place.first_passkey_close()?;
            Ok(vec!["The first-passkey step is closed.".to_string(), apply])
        }
    }
}

pub fn run_command(
    place: &SetupPlace,
    command: &SetupCommand,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command_lines(place, command) {
        Ok(lines) => {
            for line in lines {
                let _ = writeln!(out, "{line}");
            }
            0
        }
        Err(message) => {
            let _ = writeln!(err, "{message}");
            REFUSED_EXIT_CODE
        }
    }
}
