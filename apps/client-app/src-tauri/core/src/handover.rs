use crate::address::{check_address, is_loopback};
use crate::ids::ServerId;
use crate::servers::ServerEntry;
use std::sync::Mutex;
use url::Url;

const SCHEME: &str = "rumo";
const VERSION: &str = "1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoverProblem {
    NotHandover,
    UnknownVersion,
    BadUrl,
    NotLoopback,
    Credentials,
}

impl HandoverProblem {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotHandover => "not-handover",
            Self::UnknownVersion => "unknown-version",
            Self::BadUrl => "bad-url",
            Self::NotLoopback => "not-loopback",
            Self::Credentials => "credentials",
        }
    }
}

fn parse_link(link: &str) -> Option<Url> {
    let parsed = Url::parse(link).ok()?;
    let handover =
        parsed.scheme() == SCHEME && parsed.host_str() == Some("open") && parsed.path().is_empty();
    handover.then_some(parsed)
}

fn first_param(link: &Url, name: &str) -> Option<String> {
    link.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

pub fn parse(link: &str) -> Result<String, HandoverProblem> {
    let parsed = parse_link(link).ok_or(HandoverProblem::NotHandover)?;
    if first_param(&parsed, "v").as_deref() != Some(VERSION) {
        return Err(HandoverProblem::UnknownVersion);
    }
    let target = first_param(&parsed, "url")
        .and_then(|value| Url::parse(&value).ok())
        .ok_or(HandoverProblem::BadUrl)?;
    if !target.username().is_empty() || target.password().is_some() {
        return Err(HandoverProblem::Credentials);
    }
    if matches!(target.scheme(), "http" | "https") && is_loopback(&target) {
        return Ok(target.into());
    }
    Err(HandoverProblem::NotLoopback)
}

pub fn first_acceptable<'a>(links: impl IntoIterator<Item = &'a str>) -> Option<String> {
    links.into_iter().find_map(|link| parse(link).ok())
}

pub fn normalise(url: &str) -> Option<String> {
    check_address(url).ok()
}

pub fn server_name(url: &str, taken: &[String]) -> String {
    let base = Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?.to_owned();
            let port = parsed.port_or_known_default()?;
            Some(format!("{host}:{port}"))
        })
        .unwrap_or_else(|| url.to_owned());
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|number| format!("{base} ({number})"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(base)
}

pub const UNKNOWN_VERSION_MESSAGE: &str =
    "That link uses a handover version this app does not understand. Update Rumo and try again.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandoverPlan {
    ShowList { message: Option<String> },
    Open(ServerId),
    Add { name: String, url: String },
}

pub fn plan<'a>(links: impl IntoIterator<Item = &'a str>, listed: &[ServerEntry]) -> HandoverPlan {
    let mut unknown_version = false;
    for link in links {
        match parse(link) {
            Ok(url) => return plan_for(&url, listed),
            Err(problem) => unknown_version |= problem == HandoverProblem::UnknownVersion,
        }
    }
    HandoverPlan::ShowList {
        message: unknown_version.then(|| UNKNOWN_VERSION_MESSAGE.to_owned()),
    }
}

fn plan_for(url: &str, listed: &[ServerEntry]) -> HandoverPlan {
    let wanted = normalise(url).unwrap_or_else(|| url.to_owned());
    let known = listed
        .iter()
        .find(|entry| normalise(&entry.url).unwrap_or_else(|| entry.url.clone()) == wanted);
    if let Some(entry) = known {
        return HandoverPlan::Open(entry.id);
    }
    let taken: Vec<String> = listed.iter().map(|entry| entry.name.clone()).collect();
    HandoverPlan::Add {
        name: server_name(&wanted, &taken),
        url: wanted,
    }
}

#[derive(Debug)]
pub struct EarlyLinks {
    held: Mutex<Option<Vec<String>>>,
}

impl EarlyLinks {
    pub fn holding() -> Self {
        Self {
            held: Mutex::new(Some(Vec::new())),
        }
    }

    pub fn deliver(&self, links: Vec<String>) -> Option<Vec<String>> {
        match self.held.lock().unwrap().as_mut() {
            Some(held) => {
                held.extend(links);
                None
            }
            None => Some(links),
        }
    }

    pub fn release(&self) -> Vec<String> {
        self.held.lock().unwrap().take().unwrap_or_default()
    }
}
