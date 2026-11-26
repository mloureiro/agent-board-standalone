use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use url::{Host, Url};

use crate::opener::OPEN_PROGRAM;

pub const SCHEME: &str = "agentboard";
pub const VERSION: u32 = 1;
pub const CLIENT_APP_BUNDLE_ID: &str = "dev.mloureiro.agent-board-client";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    BadUrl,
    NotLoopback,
    Credentials,
}

impl Problem {
    pub fn code(self) -> &'static str {
        match self {
            Problem::BadUrl => "bad-url",
            Problem::NotLoopback => "not-loopback",
            Problem::Credentials => "credentials",
        }
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn check_target(target: &str) -> Result<(), Problem> {
    let url = Url::parse(target).map_err(|_| Problem::BadUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Problem::Credentials);
    }
    if matches!(url.scheme(), "http" | "https") && is_loopback(&url) {
        return Ok(());
    }
    Err(Problem::NotLoopback)
}

fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn build_link(target: &str) -> Result<String, Problem> {
    check_target(target)?;
    Ok(format!(
        "{SCHEME}://open?v={VERSION}&url={}",
        encode_component(target)
    ))
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, args: &[String]) -> io::Result<i32>;
}

pub struct SystemRunner {
    program: PathBuf,
}

impl SystemRunner {
    pub fn new(program: Option<PathBuf>) -> SystemRunner {
        SystemRunner {
            program: program.unwrap_or_else(|| PathBuf::from(OPEN_PROGRAM)),
        }
    }
}

impl CommandRunner for SystemRunner {
    fn run(&self, args: &[String]) -> io::Result<i32> {
        let status = Command::new(&self.program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        Ok(status.code().unwrap_or(-1))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub commands: Vec<Vec<String>>,
    pub in_client_app: bool,
    pub failure: Option<String>,
}

fn displayed(args: &[String]) -> Vec<String> {
    std::iter::once("open".to_string())
        .chain(args.iter().cloned())
        .collect()
}

pub fn open_board(target: &str, browser: &str, runner: &dyn CommandRunner) -> Opened {
    let link = match build_link(target) {
        Ok(link) => link,
        Err(problem) => {
            return Opened {
                commands: Vec::new(),
                in_client_app: false,
                failure: Some(format!(
                    "the board address cannot be handed over: {}",
                    problem.code()
                )),
            };
        }
    };
    let handover = vec!["-b".to_string(), CLIENT_APP_BUNDLE_ID.to_string(), link];
    let mut commands = vec![displayed(&handover)];
    if matches!(runner.run(&handover), Ok(0)) {
        return Opened {
            commands,
            in_client_app: true,
            failure: None,
        };
    }
    let browser = vec![browser.to_string()];
    commands.push(displayed(&browser));
    let failure = match runner.run(&browser) {
        Ok(0) => None,
        Ok(code) => Some(format!("open exited with {code}")),
        Err(error) => Some(format!("open failed: {error}")),
    };
    Opened {
        commands,
        in_client_app: false,
        failure,
    }
}
