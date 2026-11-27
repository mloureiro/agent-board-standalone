use std::path::{Path, PathBuf};

pub const PROFILE: &str = "server-app";
pub const INHERITED: [&str; 7] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "SSH_AUTH_SOCK",
];
pub const CREDENTIALS_COMMAND_ENV: &str = "RUMO_CREDENTIALS_COMMAND";
pub const TICK_RESULT_FILE: &str = "dispatch-result.json";

const FALLBACK_TAIL: [&str; 7] = [
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPaths {
    dir: PathBuf,
}

impl WorkerPaths {
    pub fn new(root: &Path) -> WorkerPaths {
        WorkerPaths {
            dir: root.join("worker"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn config(&self) -> PathBuf {
        self.dir.join("config")
    }

    pub fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    pub fn run(&self) -> PathBuf {
        self.dir.join("run")
    }

    pub fn bin(&self) -> PathBuf {
        self.dir.join("bin")
    }

    pub fn libexec(&self) -> PathBuf {
        self.dir.join("libexec")
    }

    pub fn cli_link(&self) -> PathBuf {
        self.bin().join("rumo-cli")
    }

    pub fn wrapper(&self) -> PathBuf {
        self.bin().join("rumo")
    }

    pub fn credentials_script(&self, pending: bool) -> PathBuf {
        self.libexec().join(if pending {
            "credentials-pending"
        } else {
            "credentials"
        })
    }

    pub fn tick_result(&self) -> PathBuf {
        self.state().join(TICK_RESULT_FILE)
    }

    pub fn server_file(&self) -> PathBuf {
        self.config().join("server.json")
    }

    pub fn profile_config(&self) -> PathBuf {
        self.config().join("config.yaml")
    }
}

pub fn fallback_tail(home: &Path) -> String {
    FALLBACK_TAIL
        .iter()
        .map(|entry| match entry.strip_prefix("~/") {
            Some(rest) => home.join(rest).display().to_string(),
            None => (*entry).to_string(),
        })
        .collect::<Vec<_>>()
        .join(":")
}

pub fn path_value(paths: &WorkerPaths, entries: &[PathBuf], tail: &str) -> String {
    let mut parts = vec![paths.bin().display().to_string()];
    parts.extend(entries.iter().map(|entry| entry.display().to_string()));
    parts.push(tail.to_string());
    parts.join(":")
}

pub fn worker_env(
    paths: &WorkerPaths,
    entries: &[PathBuf],
    tail: &str,
    get: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("RUMO_PROFILE".to_string(), PROFILE.to_string()),
        (
            "RUMO_CONFIG_DIR".to_string(),
            paths.config().display().to_string(),
        ),
        (
            "RUMO_STATE_DIR".to_string(),
            paths.state().display().to_string(),
        ),
        (
            "RUMO_RUN_DIR".to_string(),
            paths.run().display().to_string(),
        ),
        (
            CREDENTIALS_COMMAND_ENV.to_string(),
            paths.credentials_script(false).display().to_string(),
        ),
        ("PATH".to_string(), path_value(paths, entries, tail)),
    ];
    for name in INHERITED {
        if let Some(value) = get(name).filter(|value| !value.is_empty()) {
            env.push((name.to_string(), value));
        }
    }
    env
}

pub fn replace_env(env: &mut Vec<(String, String)>, name: &str, value: String) {
    env.retain(|(key, _)| key != name);
    env.push((name.to_string(), value));
}
