use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
pub const HOLD_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlError(String);

impl ControlError {
    fn new(message: impl Into<String>) -> ControlError {
        ControlError(message.into())
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ControlError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiState {
    Running,
    Held,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub command: Duration,
    pub hold: Duration,
}

impl Default for Timeouts {
    fn default() -> Timeouts {
        Timeouts {
            command: COMMAND_TIMEOUT,
            hold: HOLD_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ControlClient {
    socket: PathBuf,
    timeouts: Timeouts,
}

struct Reply {
    status: u16,
    body: Value,
}

impl ControlClient {
    pub fn new(socket: PathBuf) -> ControlClient {
        ControlClient::with_timeouts(socket, Timeouts::default())
    }

    pub fn with_timeouts(socket: PathBuf, timeouts: Timeouts) -> ControlClient {
        ControlClient { socket, timeouts }
    }

    pub fn hold(&self) -> Result<(), ControlError> {
        self.command("hold", self.timeouts.hold).map(|_| ())
    }

    pub fn resume(&self) -> Result<(), ControlError> {
        self.command("resume", self.timeouts.command).map(|_| ())
    }

    pub fn status(&self) -> Result<ApiState, ControlError> {
        let reply = self.command("status", self.timeouts.command)?;
        match reply.body.get("state").and_then(Value::as_str) {
            Some("running") => Ok(ApiState::Running),
            Some("held") => Ok(ApiState::Held),
            _ => Err(ControlError::new("the API sent an unknown status")),
        }
    }

    pub fn pair_code(&self) -> Result<String, ControlError> {
        let reply = self.command("pair-code", self.timeouts.command)?;
        reply
            .body
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ControlError::new("the API sent no pairing code"))
    }

    fn command(&self, name: &str, limit: Duration) -> Result<Reply, ControlError> {
        let reply = self.exchange(name, limit)?;
        if reply.status == 200 {
            return Ok(reply);
        }
        let reason = reply.body.get("error").and_then(Value::as_str).map_or_else(
            || format!("the API answered {}", reply.status),
            str::to_string,
        );
        Err(ControlError::new(reason))
    }

    fn exchange(&self, name: &str, limit: Duration) -> Result<Reply, ControlError> {
        let started = Instant::now();
        let unreachable = |error: std::io::Error| {
            ControlError::new(format!(
                "the control channel {} did not answer {name}: {error}",
                self.socket.display()
            ))
        };
        let remaining = || {
            limit
                .checked_sub(started.elapsed())
                .filter(|left| !left.is_zero())
                .ok_or_else(|| {
                    ControlError::new(format!(
                        "the control channel did not answer {name} within {} s",
                        limit.as_secs_f32()
                    ))
                })
        };
        let mut stream = UnixStream::connect(&self.socket).map_err(unreachable)?;
        let _ = stream.set_write_timeout(Some(remaining()?));
        let request = format!(
            "POST /{name} HTTP/1.1\r\nHost: api\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|error| match error.kind() {
                ErrorKind::WouldBlock | ErrorKind::TimedOut => {
                    remaining().err().unwrap_or_else(|| unreachable(error))
                }
                _ => unreachable(error),
            })?;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let _ = stream.set_read_timeout(Some(remaining()?));
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => raw.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Err(remaining().err().unwrap_or_else(|| unreachable(error)));
                }
                Err(error) => return Err(unreachable(error)),
            }
        }
        parse(&raw)
    }
}

fn parse(raw: &[u8]) -> Result<Reply, ControlError> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| ControlError::new("the API sent an incomplete answer"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| ControlError::new("the API sent an unreadable status line"))?;
    let body = serde_json::from_slice(&raw[split + 4..]).unwrap_or(Value::Null);
    Ok(Reply { status, body })
}
