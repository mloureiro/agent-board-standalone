use crate::headers::{Header, with_client_headers};
use crate::ports::{Http, HttpRequest, Limits, PortError};
use futures_util::StreamExt;
use serde::Deserialize;
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
pub const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

const BODY_CAP: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct ClientInfo {
    pub contract: u32,
    pub version: String,
}

impl ClientInfo {
    pub fn headers(&self) -> Vec<Header> {
        with_client_headers(
            Vec::new(),
            &self.contract.to_string(),
            &format!("web/{}", self.version),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Handshake {
    pub request_signature: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandshakeFailure {
    Unreachable(String),
    Status(u16),
    NotABoard,
}

impl HandshakeFailure {
    pub fn text(&self) -> String {
        match self {
            Self::Unreachable(detail) => format!("The server could not be reached ({detail})."),
            Self::Status(status) => format!("The server answered with status {status}."),
            Self::NotABoard => "The address did not answer like an Rumo server.".to_owned(),
        }
    }

    fn transient(&self) -> bool {
        match self {
            Self::Unreachable(_) => true,
            Self::Status(status) => matches!(status, 502..=504),
            Self::NotABoard => false,
        }
    }
}

#[derive(Deserialize)]
struct VersionDocument {
    modules: Modules,
}

#[derive(Deserialize)]
struct Modules {
    #[serde(rename = "requestSignature")]
    request_signature: bool,
}

pub fn version_url(base: &str) -> String {
    format!("{}/api/version", base.trim_end_matches('/'))
}

async fn read_capped(mut body: crate::ports::ByteStream) -> Result<Vec<u8>, PortError> {
    let mut collected = Vec::new();
    while let Some(chunk) = body.next().await {
        collected.extend(chunk?);
        if collected.len() > BODY_CAP {
            return Err(PortError("answer too large".to_owned()));
        }
    }
    Ok(collected)
}

async fn attempt(
    http: &impl Http,
    base: &str,
    client: &ClientInfo,
) -> Result<Handshake, HandshakeFailure> {
    let request = HttpRequest {
        method: "GET".to_owned(),
        url: version_url(base),
        headers: client.headers(),
        body: Vec::new(),
        limits: Some(Limits {
            connect: CONNECT_TIMEOUT,
            total: TOTAL_TIMEOUT,
        }),
    };
    let response = http
        .send(request)
        .await
        .map_err(|error| HandshakeFailure::Unreachable(error.0))?;
    if response.status != 200 {
        return Err(HandshakeFailure::Status(response.status));
    }
    let body = read_capped(response.body)
        .await
        .map_err(|error| HandshakeFailure::Unreachable(error.0))?;
    serde_json::from_slice::<VersionDocument>(&body)
        .map(|document| Handshake {
            request_signature: document.modules.request_signature,
        })
        .map_err(|_| HandshakeFailure::NotABoard)
}

pub async fn handshake(
    http: &impl Http,
    base: &str,
    client: &ClientInfo,
) -> Result<Handshake, HandshakeFailure> {
    let mut delays = RETRY_DELAYS.iter();
    loop {
        match attempt(http, base, client).await {
            Err(failure) if failure.transient() => match delays.next() {
                Some(delay) => tokio::time::sleep(*delay).await,
                None => return Err(failure),
            },
            outcome => return outcome,
        }
    }
}
