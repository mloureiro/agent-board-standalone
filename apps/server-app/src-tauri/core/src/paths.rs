use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

pub const PRODUCT_NAME: &str = "Agent Board Server";
pub const IDENTIFIER: &str = "dev.mloureiro.agent-board-server";
pub const ROOT_ENV: &str = "AGENT_BOARD_SERVER_ROOT";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootError(String);

impl fmt::Display for RootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RootError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    path: PathBuf,
    is_default: bool,
}

pub fn default_root_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support").join(PRODUCT_NAME)
}

pub fn has_parent_component(path: &Path) -> bool {
    path.components().any(|part| part == Component::ParentDir)
}

impl Root {
    pub fn resolve(env_value: Option<&OsStr>, home: &Path) -> Result<Root, RootError> {
        let default = default_root_path(home);
        let Some(value) = env_value.filter(|value| !value.is_empty()) else {
            return Ok(Root {
                path: default,
                is_default: true,
            });
        };
        let requested: PathBuf = Path::new(value).components().collect();
        if !requested.is_absolute() {
            return Err(RootError(format!(
                "{ROOT_ENV} must be an absolute path, got {}",
                requested.display()
            )));
        }
        let is_default = requested == default;
        Ok(Root {
            path: requested,
            is_default,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_default(&self) -> bool {
        self.is_default
    }

    pub fn paths(&self) -> AppPaths {
        AppPaths {
            root: self.path.clone(),
        }
    }

    pub fn keychain_service(&self) -> String {
        if self.is_default {
            IDENTIFIER.to_string()
        } else {
            format!("{IDENTIFIER}.root:{}", self.path.display())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    pub fn new(root: &Path) -> AppPaths {
        AppPaths {
            root: root.to_path_buf(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join("app.lock")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn app_log(&self) -> PathBuf {
        self.logs_dir().join("app.log")
    }

    pub fn access_log(&self) -> PathBuf {
        self.logs_dir().join("access.log")
    }

    pub fn default_data_dir(&self) -> PathBuf {
        self.root.join("data")
    }

    pub fn default_backup_dir(&self) -> PathBuf {
        self.root.join("backups")
    }
}
