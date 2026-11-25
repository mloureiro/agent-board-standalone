use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

pub const SUPPORTED_SCHEMA: u64 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRecipe {
    schema: u64,
    path: String,
    units: Vec<RawUnit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUnit {
    name: String,
    program: String,
    args: Vec<String>,
    every_seconds: Option<u64>,
    limit_seconds: Option<u64>,
    grace_seconds: Option<u64>,
    lock_held_exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tick {
    pub command: Command,
    pub every: Duration,
    pub limit: Duration,
    pub grace: Duration,
    pub lock_held_exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipe {
    pub path_tail: String,
    pub dispatch: Tick,
    pub listen: Command,
    pub watch: Command,
}

fn command(unit: &RawUnit) -> Command {
    Command {
        program: PathBuf::from(&unit.program),
        args: unit.args.iter().map(OsString::from).collect(),
    }
}

pub fn parse(text: &str) -> Result<Recipe, String> {
    let raw: RawRecipe = serde_json::from_str(text.trim())
        .map_err(|error| format!("the unit recipe is not valid: {error}"))?;
    if raw.schema != SUPPORTED_SCHEMA {
        return Err(format!(
            "the unit recipe has schema {}, this app reads schema {SUPPORTED_SCHEMA}",
            raw.schema
        ));
    }
    let unit = |name: &str| {
        raw.units
            .iter()
            .find(|unit| unit.name == name)
            .ok_or_else(|| format!("the unit recipe has no {name} unit"))
    };
    let dispatch = unit("dispatch")?;
    let seconds = |value: Option<u64>, field: &str| {
        value
            .filter(|value| *value > 0)
            .map(Duration::from_secs)
            .ok_or_else(|| format!("the dispatch unit has no {field}"))
    };
    Ok(Recipe {
        path_tail: raw.path.clone(),
        dispatch: Tick {
            command: command(dispatch),
            every: seconds(dispatch.every_seconds, "everySeconds")?,
            limit: seconds(dispatch.limit_seconds, "limitSeconds")?,
            grace: seconds(dispatch.grace_seconds, "graceSeconds")?,
            lock_held_exit_code: dispatch
                .lock_held_exit_code
                .ok_or("the dispatch unit has no lockHeldExitCode")?,
        },
        listen: command(unit("listen")?),
        watch: command(unit("watch")?),
    })
}
