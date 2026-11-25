use crate::ids::ServerId;
use url::Url;

pub const TITLE_MAX_CHARS: usize = 200;
pub const TASK_ID_MAX_CHARS: usize = 64;
pub const LINK_MAX_CHARS: usize = 2048;
pub const PATH_MAX_CHARS: usize = 2048;
pub const HEADERS_MAX: usize = 100;
pub const BODY_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum InputError {
    TaskId,
    Link,
    TabPath,
    TabTitle,
    TabIntent,
    TabDirection,
    TooManyHeaders,
    BodyTooLarge,
}

impl InputError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::TaskId => "refused task id",
            Self::Link => "refused link",
            Self::TabPath => "refused tab path",
            Self::TabTitle => "refused tab title",
            Self::TabIntent => "refused tab intent",
            Self::TabDirection => "refused tab direction",
            Self::TooManyHeaders => "too many headers",
            Self::BodyTooLarge => "request body too large",
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

pub fn notification(task_id: &str, title: &str) -> Result<Notification, InputError> {
    if !plain_id(task_id) && ServerId::parse(task_id).is_err() {
        return Err(InputError::TaskId);
    }
    let title: String = title
        .chars()
        .filter(|character| !character.is_control())
        .take(TITLE_MAX_CHARS)
        .collect();
    Ok(Notification {
        task_id: task_id.to_owned(),
        title,
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
