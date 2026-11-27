use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::paths::AppPaths;
use crate::redact::MASK;
use crate::settings::Settings;

pub const API_RELATIVE: &str = "api/rumo-api";
pub const WEB_RELATIVE: &str = "web";
pub const LOCAL_HOSTS: &str = "localhost,127.0.0.1,[::1]";
pub const SIGNUP_TOKEN_ENV: &str = "SIGNUP_TOKEN";

#[derive(Clone, PartialEq, Eq)]
pub struct ChildSpec {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    pub log: PathBuf,
    pub health_port: Option<u16>,
}

impl std::fmt::Debug for ChildSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<(&str, &str)> = self
            .env
            .iter()
            .map(|(key, value)| match key.as_str() {
                SIGNUP_TOKEN_ENV => (key.as_str(), MASK),
                _ => (key.as_str(), value.as_str()),
            })
            .collect();
        f.debug_struct("ChildSpec")
            .field("name", &self.name)
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &env)
            .field("log", &self.log)
            .field("health_port", &self.health_port)
            .finish()
    }
}

pub fn run_dir(paths: &AppPaths) -> PathBuf {
    paths.root().join("run")
}

pub fn control_socket(paths: &AppPaths) -> PathBuf {
    run_dir(paths).join("api.sock")
}

fn host_of(origin: &str) -> &str {
    origin.strip_prefix("https://").unwrap_or(origin)
}

pub fn api_spec(
    settings: &Settings,
    paths: &AppPaths,
    resources: &Path,
    signup_token: Option<&str>,
) -> Result<ChildSpec, String> {
    let program = resources.join(API_RELATIVE);
    if !program.is_file() {
        return Err(format!("API executable missing: {}", program.display()));
    }
    let mut hosts = vec![LOCAL_HOSTS.to_string()];
    let mut env = match &settings.public_url {
        Some(public_url) => {
            hosts.push(host_of(public_url).to_string());
            vec![
                ("AUTH_MODE".to_string(), "login".to_string()),
                ("PUBLIC_URL".to_string(), public_url.clone()),
                ("PASSKEYS".to_string(), "on".to_string()),
            ]
        }
        None => vec![
            ("AUTH_MODE".to_string(), "no-login".to_string()),
            ("NO_LOGIN_USER".to_string(), settings.user_name.clone()),
        ],
    };
    hosts.extend(settings.remote_hosts.iter().cloned());
    env.extend([
        (
            "DATABASE_URL".to_string(),
            format!("pglite://{}", settings.data_dir.display()),
        ),
        ("HOST".to_string(), "127.0.0.1".to_string()),
        ("PORT".to_string(), settings.port.to_string()),
        ("ALLOWED_HOSTS".to_string(), hosts.join(",")),
        (
            "WEB_ROOT".to_string(),
            resources.join(WEB_RELATIVE).display().to_string(),
        ),
        (
            "CONTROL_SOCKET".to_string(),
            control_socket(paths).display().to_string(),
        ),
        (
            "ACCESS_LOG".to_string(),
            paths.access_log().display().to_string(),
        ),
    ]);
    if settings.request_signature {
        env.push(("REQUEST_SIGNATURE".to_string(), "on".to_string()));
    }
    if let (true, Some(token)) = (settings.remote(), signup_token) {
        env.push((SIGNUP_TOKEN_ENV.to_string(), token.to_string()));
        env.push(("CLAIM_USER".to_string(), settings.user_name.clone()));
    }
    Ok(ChildSpec {
        name: "api".to_string(),
        program,
        args: Vec::new(),
        env,
        log: paths.logs_dir().join("api.log"),
        health_port: Some(settings.port),
    })
}
