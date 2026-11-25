use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::credentials::{ACCOUNTS, CredentialStore};
use crate::launchctl::Launchctl;
use crate::lock::{self, Acquired, InstanceLock};
use crate::login_item;
use crate::paths::{Root, has_parent_component};
use crate::settings::Settings;

pub const QUIT_FIRST: &str = "quit the app first";

pub struct Environment<'a> {
    pub root: &'a Root,
    pub home: Option<&'a Path>,
    pub login_name: &'a str,
    pub launch_agents_dir: &'a Path,
    pub launchctl: &'a dyn Launchctl,
    pub store: &'a dyn CredentialStore,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootState {
    Missing,
    Accepted,
    Refused(String),
}

fn identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).ok().map(|meta| (meta.dev(), meta.ino()))
}

pub fn resolve(path: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(mut resolved) = fs::canonicalize(&current) {
            resolved.extend(tail.iter().rev());
            return resolved;
        }
        match (
            current.file_name().map(|name| name.to_owned()),
            current.parent(),
        ) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

pub fn covers_home(root: &Path, home: &Path) -> bool {
    let Some(root_identity) = identity(root) else {
        return false;
    };
    home.ancestors().any(|ancestor| {
        let Some(ancestor_identity) = identity(ancestor) else {
            return false;
        };
        let relative = ancestor.strip_prefix("/").unwrap_or(ancestor);
        ancestor_identity == root_identity
            || identity(&root.join(relative)) == Some(ancestor_identity)
    })
}

pub fn inspect_root(root: &Path, home: Option<&Path>) -> RootState {
    if has_parent_component(root) {
        return RootState::Refused(format!("{} has a .. component", root.display()));
    }
    let Ok(meta) = fs::symlink_metadata(root) else {
        return RootState::Missing;
    };
    if meta.is_symlink() {
        return RootState::Refused(format!("{} is a symlink", root.display()));
    }
    if !meta.is_dir() {
        return RootState::Refused(format!("{} is not a folder", root.display()));
    }
    let Some(home) = home else {
        return RootState::Refused("the home folder is unknown".to_string());
    };
    if covers_home(root, home) {
        return RootState::Refused(format!(
            "{} is the home folder or contains it",
            root.display()
        ));
    }
    let marker = root.join("settings.json");
    if !fs::symlink_metadata(&marker).is_ok_and(|meta| meta.is_file()) {
        return RootState::Refused(format!(
            "{} has no regular-file settings.json, so it does not look like this app's folder",
            root.display()
        ));
    }
    RootState::Accepted
}

fn outside_notes(env: &Environment, out: &mut dyn Write) -> std::io::Result<()> {
    let paths = env.root.paths();
    let settings = match Settings::load(&paths, env.login_name) {
        Ok(settings) => settings,
        Err(error) => {
            return writeln!(out, "dataDir and backupDir were not checked: {error}");
        }
    };
    let root = resolve(env.root.path());
    for (name, dir) in [
        ("dataDir", &settings.data_dir),
        ("backupDir", &settings.backup_dir),
    ] {
        if !resolve(dir).starts_with(&root) {
            writeln!(
                out,
                "{name} {} is outside the app folder and is left in place",
                dir.display()
            )?;
        }
    }
    Ok(())
}

fn remove_keychain_items(env: &Environment, out: &mut dyn Write) -> std::io::Result<bool> {
    let service = env.root.keychain_service();
    let mut clean = true;
    for account in ACCOUNTS {
        if let Err(error) = env.store.delete(&service, account) {
            writeln!(
                out,
                "could not remove {account} from the credential store: {error}"
            )?;
            clean = false;
        }
    }
    if clean {
        writeln!(out, "removed the worker credentials of {service}")?;
    }
    Ok(clean)
}

pub fn run(env: &Environment, delete_data: bool, out: &mut dyn Write) -> i32 {
    match execute(env, delete_data, out) {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(out, "uninstall failed: {error}");
            1
        }
    }
}

fn execute(env: &Environment, delete_data: bool, out: &mut dyn Write) -> std::io::Result<i32> {
    let root_path = env.root.path();
    let state = inspect_root(root_path, env.home);
    let lock_file = env.root.paths().lock_file();

    let _held: Option<InstanceLock> = match &state {
        RootState::Accepted => match InstanceLock::acquire(&lock_file)? {
            Acquired::Held(lock) => Some(lock),
            Acquired::AlreadyRunning => {
                writeln!(out, "{QUIT_FIRST}")?;
                return Ok(1);
            }
        },
        RootState::Missing | RootState::Refused(_) => {
            if lock::is_held(&lock_file)? {
                writeln!(out, "{QUIT_FIRST}")?;
                return Ok(1);
            }
            None
        }
    };

    let mut code = 0;

    if env.root.is_default() {
        match login_item::remove(env.root, env.launch_agents_dir, env.launchctl) {
            Ok(_) => writeln!(out, "removed the login item")?,
            Err(error) => {
                writeln!(out, "could not remove the login item: {error}")?;
                code = 1;
            }
        }
    } else {
        writeln!(
            out,
            "login item left alone: the root is not the default one"
        )?;
    }

    if !remove_keychain_items(env, out)? {
        code = 1;
    }

    if !delete_data {
        writeln!(out, "data kept in {}", root_path.display())?;
        return Ok(code);
    }

    match state {
        RootState::Missing => writeln!(
            out,
            "nothing to delete: {} does not exist",
            root_path.display()
        )?,
        RootState::Refused(reason) => writeln!(out, "{reason}; not removed")?,
        RootState::Accepted => {
            outside_notes(env, out)?;
            match fs::remove_dir_all(root_path) {
                Ok(()) => writeln!(out, "removed {}", root_path.display())?,
                Err(error) => {
                    writeln!(out, "could not remove {}: {error}", root_path.display())?;
                    code = 1;
                }
            }
        }
    }
    Ok(code)
}
