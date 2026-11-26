use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::redact::redact;

pub const DROPPED_CHECKS: &str = include_str!("dropped_checks.json");
pub const TOOLS: [&str; 2] = ["claude", "gh"];
pub const LOG_FILE: &str = "check-worker.log";

#[derive(Deserialize)]
struct Entry {
    name: String,
    level: String,
    message: String,
    hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub problems: usize,
    pub lines: Vec<String>,
}

impl Report {
    pub fn summary(&self) -> String {
        format!("check: {} problem(s)", self.problems)
    }
}

pub fn dropped_checks() -> Vec<String> {
    serde_json::from_str(DROPPED_CHECKS).unwrap_or_default()
}

pub fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|entry| !entry.is_empty())
        .map(|entry| Path::new(entry).join(name))
        .find(|candidate| {
            fs::metadata(candidate)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

pub fn evaluate(doctor_json: &str, dropped: &[String], path: &str) -> Result<Report, String> {
    let entries: Vec<Entry> = serde_json::from_str(doctor_json.trim())
        .map_err(|error| format!("the doctor report is not valid: {error}"))?;
    let mut problems = 0;
    let mut lines = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| !dropped.contains(&entry.name))
    {
        let mark = match entry.level.as_str() {
            "ok" => "ok  ",
            "warn" => "warn",
            _ => "FAIL",
        };
        if entry.level != "ok" {
            problems += 1;
        }
        lines.push(format!("{mark}  {}: {}", entry.name, entry.message));
        if let Some(hint) = &entry.hint {
            lines.push(format!("          hint: {hint}"));
        }
    }
    for tool in TOOLS {
        match find_on_path(tool, path) {
            Some(found) => lines.push(format!("ok    {tool}: {}", found.display())),
            None => {
                problems += 1;
                lines.push(format!("warn  {tool}: not found on the worker PATH"));
            }
        }
    }
    let lines = lines.iter().map(|line| redact(line)).collect();
    Ok(Report { problems, lines })
}
