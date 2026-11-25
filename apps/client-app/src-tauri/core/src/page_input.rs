use crate::ids::ServerId;
use url::Url;

pub const TITLE_MAX_CHARS: usize = 200;
pub const TASK_ID_MAX_CHARS: usize = 64;
pub const LINK_MAX_CHARS: usize = 2048;
pub const PATH_MAX_CHARS: usize = 2048;
pub const HEADERS_MAX: usize = 100;
pub const BODY_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const FLOW_MAX_CHARS: usize = 128;
pub const VERIFIER_MAX_CHARS: usize = 128;
pub const PAIRING_CODE_MAX_CHARS: usize = 32;
pub const PAIRING_LABEL_MAX_CHARS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum InputError {
    TaskId,
    NotificationTitle,
    Link,
    TabPath,
    TabTitle,
    TabIntent,
    TabDirection,
    TooManyHeaders,
    BodyTooLarge,
    SignIn,
    Pairing,
}

impl InputError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::TaskId => "refused task id",
            Self::NotificationTitle => "refused notification title",
            Self::Link => "refused link",
            Self::TabPath => "refused tab path",
            Self::TabTitle => "refused tab title",
            Self::TabIntent => "refused tab intent",
            Self::TabDirection => "refused tab direction",
            Self::TooManyHeaders => "too many headers",
            Self::BodyTooLarge => "request body too large",
            Self::SignIn => "refused sign-in input",
            Self::Pairing => "refused pairing input",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Notification {
    pub task_id: String,
    pub title: String,
}

fn plain_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= TASK_ID_MAX_CHARS
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn task_id(text: &str) -> Result<String, InputError> {
    if plain_id(text) || ServerId::parse(text).is_ok() {
        Ok(text.to_owned())
    } else {
        Err(InputError::TaskId)
    }
}

pub fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|character| !character.is_control())
        .take(TITLE_MAX_CHARS)
        .collect()
}

pub fn notification(task_id_text: &str, title: &str) -> Result<Notification, InputError> {
    Ok(Notification {
        task_id: task_id(task_id_text)?,
        title: clean_title(title),
    })
}

pub fn link(text: &str) -> Result<Url, InputError> {
    if text.len() > LINK_MAX_CHARS || text.chars().any(char::is_control) {
        return Err(InputError::Link);
    }
    let url = Url::parse(text).map_err(|_| InputError::Link)?;
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        Ok(url)
    } else {
        Err(InputError::Link)
    }
}

pub struct TabReport {
    pub path: String,
    pub title: String,
}

pub fn tab_report(path: &str, title: &str) -> Result<TabReport, InputError> {
    if !path.starts_with('/')
        || path.len() > PATH_MAX_CHARS
        || path.chars().any(char::is_control)
        || path.starts_with("//")
    {
        return Err(InputError::TabPath);
    }
    if title.chars().any(char::is_control) {
        return Err(InputError::TabTitle);
    }
    Ok(TabReport {
        path: path.to_owned(),
        title: title.chars().take(TITLE_MAX_CHARS).collect(),
    })
}

pub fn fetch_input(header_count: usize, body: Option<&str>) -> Result<(), InputError> {
    if header_count > HEADERS_MAX {
        return Err(InputError::TooManyHeaders);
    }
    if body.is_some_and(|text| text.len() > BODY_MAX_BYTES) {
        return Err(InputError::BodyTooLarge);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabIntent {
    Open,
    Route,
    New,
}

pub fn tab_intent(text: &str) -> Result<TabIntent, InputError> {
    match text {
        "open" => Ok(TabIntent::Open),
        "route" => Ok(TabIntent::Route),
        "new" => Ok(TabIntent::New),
        _ => Err(InputError::TabIntent),
    }
}

pub fn tab_direction(text: &str) -> Result<bool, InputError> {
    match text {
        "next" => Ok(true),
        "previous" => Ok(false),
        _ => Err(InputError::TabDirection),
    }
}

pub fn tab_path(path: &str) -> Result<String, InputError> {
    tab_report(path, "").map(|report| report.path)
}

pub fn tab_title(title: &str) -> Result<String, InputError> {
    tab_report("/", title).map(|report| report.title)
}

fn bounded(text: &str, max_chars: usize) -> bool {
    !text.is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

pub fn sign_in(flow: &str, verifier: &str) -> Result<(), InputError> {
    if bounded(flow, FLOW_MAX_CHARS) && bounded(verifier, VERIFIER_MAX_CHARS) {
        Ok(())
    } else {
        Err(InputError::SignIn)
    }
}

pub fn pairing(code: &str, label: &str) -> Result<(), InputError> {
    if bounded(code, PAIRING_CODE_MAX_CHARS) && bounded(label, PAIRING_LABEL_MAX_CHARS) {
        Ok(())
    } else {
        Err(InputError::Pairing)
    }
}
