use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use crate::account;
use crate::credentials;
use crate::durations::Durations;
use crate::launchctl::SystemLaunchctl;
use crate::lock::{Acquired, InstanceLock};
use crate::log_file::{AppLog, LogFile};
use crate::login_item::{self, Build};
use crate::overrides::Overrides;
use crate::paths::{AppPaths, ROOT_ENV, Root};
use crate::settings::{Settings, SettingsError};
use crate::spec;
use crate::supervisor::Plan;
use crate::uninstall;

pub struct Host {
    pub home: PathBuf,
    pub login_name: String,
    pub root_env: Option<OsString>,
    pub overrides: Overrides,
    pub build: Build,
    pub executable: PathBuf,
}

impl Host {
    pub fn from_process() -> Result<Host, String> {
        let home = account::home_dir().ok_or("the home folder is unknown")?;
        let login_name = account::login_name().ok_or("the macOS login name is unknown")?;
        let build = Build::current();
        let get = |name: &str| std::env::var(name).ok();
        Ok(Host {
            home,
            login_name,
            root_env: std::env::var_os(ROOT_ENV),
            overrides: Overrides::from_env(build == Build::Release, &get),
            build,
            executable: std::env::current_exe().map_err(|error| error.to_string())?,
        })
    }

    pub fn root(&self) -> Result<Root, String> {
        Root::resolve(self.root_env.as_deref(), &self.home).map_err(|error| error.to_string())
    }

    pub fn resources_dir(&self) -> PathBuf {
        self.overrides.resources_dir.clone().unwrap_or_else(|| {
            self.executable
                .parent()
                .map_or_else(|| PathBuf::from("resources"), |dir| dir.join("resources"))
        })
    }

    pub fn launch_agents_dir(&self) -> PathBuf {
        self.overrides
            .launch_agents_dir
            .clone()
            .unwrap_or_else(|| self.home.join("Library/LaunchAgents"))
    }
}

pub struct Running {
    pub root: Root,
    pub paths: AppPaths,
    pub settings: Result<Settings, SettingsError>,
    pub app_log: AppLog,
    pub access_log: LogFile,
    pub plan: Plan,
    _lock: InstanceLock,
}

pub enum Start {
    Running(Box<Running>),
    AlreadyRunning,
}

pub fn start(host: &Host) -> io::Result<Start> {
    let root = host.root().map_err(io::Error::other)?;
    let paths = root.paths();
    let lock = match InstanceLock::acquire(&paths.lock_file())? {
        Acquired::Held(lock) => lock,
        Acquired::AlreadyRunning => return Ok(Start::AlreadyRunning),
    };
    let app_log = AppLog::new(LogFile::new(paths.app_log()));
    let access_log = LogFile::new(paths.access_log());
    app_log.info(&format!("starting, root {}", root.path().display()));
    let _ = access_log.rotate_if_full();

    let settings = Settings::load_or_create(&paths, &host.login_name);
    match &settings {
        Ok(settings) => {
            app_log.info(&format!("settings loaded, port {}", settings.port));
            match login_item::sync(
                &root,
                host.build,
                settings.start_at_login,
                &host.launch_agents_dir(),
                &host.executable,
            ) {
                Ok(outcome) => app_log.info(&format!("login item {outcome:?}")),
                Err(error) => app_log.error(&format!("login item failed: {error}")),
            }
        }
        Err(error) => app_log.error(&format!("settings refused: {error}")),
    }

    let plan = Plan {
        api: match &settings {
            Ok(settings) => spec::api_spec(settings, &paths, &host.resources_dir()),
            Err(error) => Err(error.to_string()),
        },
        worker: None,
        durations: host
            .overrides
            .durations
            .clone()
            .unwrap_or_else(Durations::production),
        run_dir: spec::run_dir(&paths),
    };

    Ok(Start::Running(Box::new(Running {
        root,
        paths,
        settings,
        app_log,
        access_log,
        plan,
        _lock: lock,
    })))
}

pub fn run_uninstall(host: &Host, delete_data: bool, out: &mut dyn Write) -> i32 {
    let root = match host.root() {
        Ok(root) => root,
        Err(message) => {
            let _ = writeln!(out, "{message}");
            return 1;
        }
    };
    let store = credentials::open_store(&host.overrides);
    let launch_agents_dir = host.launch_agents_dir();
    let environment = uninstall::Environment {
        root: &root,
        home: Some(&host.home),
        login_name: &host.login_name,
        launch_agents_dir: &launch_agents_dir,
        launchctl: &SystemLaunchctl,
        store: store.as_ref(),
    };
    uninstall::run(&environment, delete_data, out)
}

pub fn run_headless(
    host: &Host,
    input: impl BufRead + Send + 'static,
    out: &mut impl Write,
) -> i32 {
    match start(host) {
        Ok(Start::Running(running)) => {
            crate::headless::serve(&running, input, out);
            0
        }
        Ok(Start::AlreadyRunning) => {
            crate::headless::emit(out, &serde_json::json!({ "type": "already-running" }));
            0
        }
        Err(error) => {
            crate::headless::emit(
                out,
                &serde_json::json!({ "type": "error", "message": error.to_string() }),
            );
            1
        }
    }
}
