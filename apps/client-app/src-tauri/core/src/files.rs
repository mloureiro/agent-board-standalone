use crate::ports::{FileStore, PortError};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub struct DirStore {
    root: PathBuf,
}

const TEMP_SUFFIX: &str = ".tmp";

fn failure(error: &std::io::Error) -> PortError {
    PortError(format!("file store: {}", error.kind()))
}

fn valid_name(name: &str) -> Result<(), PortError> {
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(TEMP_SUFFIX)
        && !name.contains(['/', '\\', '\0']);
    if plain {
        Ok(())
    } else {
        Err(PortError("file store: invalid name".to_owned()))
    }
}

impl DirStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl FileStore for DirStore {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, PortError> {
        valid_name(name)?;
        match fs::read(self.root.join(name)) {
            Ok(contents) => Ok(Some(contents)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(failure(&error)),
        }
    }

    fn write(&self, name: &str, contents: &[u8]) -> Result<(), PortError> {
        valid_name(name)?;
        fs::create_dir_all(&self.root).map_err(|error| failure(&error))?;
        let temporary = self.root.join(format!("{name}{TEMP_SUFFIX}"));
        fs::write(&temporary, contents).map_err(|error| failure(&error))?;
        fs::rename(&temporary, self.root.join(name)).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            failure(&error)
        })
    }

    fn delete(&self, name: &str) -> Result<(), PortError> {
        valid_name(name)?;
        match fs::remove_file(self.root.join(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failure(&error)),
        }
    }

    fn list(&self) -> Result<Vec<String>, PortError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(failure(&error)),
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| valid_name(name).is_ok())
            .collect();
        names.sort();
        Ok(names)
    }
}
