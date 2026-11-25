use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::paths::AppPaths;
use crate::settings::Settings;

pub const API_RELATIVE: &str = "api/agent-board-api";
pub const WEB_RELATIVE: &str = "web";
pub const LOCAL_HOSTS: &str = "localhost,127.0.0.1,[::1]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpec {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(String, String)>,
    pub log: PathBuf,
    pub health_port: Option<u16>,
}

pub fn run_dir(paths: &AppPaths) -> PathBuf {
    paths.root().join("run")
}

pub fn control_socket(paths: &AppPaths) -> PathBuf {
    run_dir(paths).join("api.sock")
}

pub fn api_spec(
    settings: &Settings,
    paths: &AppPaths,
    resources: &Path,
) -> Result<ChildSpec, String> {
    let program = resources.join(API_RELATIVE);
    if !program.is_file() {
        return Err(format!("API executable missing: {}", program.display()));
    }
    let mut hosts = vec![LOCAL_HOSTS.to_string()];
    hosts.extend(settings.remote_hosts.iter().cloned());
    let mut env = vec![
        ("AUTH_MODE".to_string(), "no-login".to_string()),
        ("NO_LOGIN_USER".to_string(), settings.user_name.clone()),
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
    ];
    if settings.request_signature {
        env.push(("REQUEST_SIGNATURE".to_string(), "on".to_string()));
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
