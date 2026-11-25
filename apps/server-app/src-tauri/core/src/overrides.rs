use std::path::PathBuf;

use crate::durations::{Durations, TIMINGS_ENV};

pub const CREDENTIAL_STORE_ENV: &str = "AGENT_BOARD_CREDENTIAL_STORE";
pub const LAUNCH_AGENTS_ENV: &str = "AGENT_BOARD_LAUNCH_AGENTS_DIR";
pub const RESOURCES_ENV: &str = "AGENT_BOARD_SERVER_RESOURCES";
pub const E2E_ENV: &str = "AGENT_BOARD_E2E";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Overrides {
    pub credential_store_file: Option<PathBuf>,
    pub launch_agents_dir: Option<PathBuf>,
    pub resources_dir: Option<PathBuf>,
    pub durations: Option<Durations>,
}

pub fn overrides_allowed(release: bool, get: &dyn Fn(&str) -> Option<String>) -> bool {
    !release || get(E2E_ENV).as_deref() == Some("1")
}

impl Overrides {
    pub fn from_env(release: bool, get: &dyn Fn(&str) -> Option<String>) -> Overrides {
        if !overrides_allowed(release, get) {
            return Overrides::default();
        }
        let absolute = |name: &str| {
            get(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        Overrides {
            credential_store_file: get(CREDENTIAL_STORE_ENV)
                .and_then(|value| value.strip_prefix("file:").map(PathBuf::from))
                .filter(|path| path.is_absolute()),
            launch_agents_dir: absolute(LAUNCH_AGENTS_ENV),
            resources_dir: absolute(RESOURCES_ENV),
            durations: get(TIMINGS_ENV).and_then(|value| Durations::parse(&value)),
        }
    }
}
