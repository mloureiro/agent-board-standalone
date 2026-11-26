use std::fs;
use std::path::Path;

pub const API_VERSION_FILE: &str = "api/version";
pub const CLI_VERSION_FILE: &str = "cli/version";
pub const UNKNOWN: &str = "unknown";
const MAX_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Versions {
    pub app: String,
    pub api: String,
    pub cli: String,
}

fn valid(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_LENGTH
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| valid(text))
        .unwrap_or_else(|| UNKNOWN.to_string())
}

impl Versions {
    pub fn read(resources: &Path) -> Versions {
        Versions {
            app: env!("CARGO_PKG_VERSION").to_string(),
            api: read(&resources.join(API_VERSION_FILE)),
            cli: read(&resources.join(CLI_VERSION_FILE)),
        }
    }

    pub fn line(&self) -> String {
        format!(
            "server app {} \u{b7} API {} \u{b7} CLI {}",
            self.app, self.api, self.cli
        )
    }
}
