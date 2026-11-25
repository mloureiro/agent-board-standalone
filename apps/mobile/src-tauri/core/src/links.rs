use url::Url;

pub fn external_link(input: &str) -> Option<String> {
    let url = Url::parse(input.trim()).ok()?;
    match url.scheme() {
        "http" | "https" => {
            if url.host_str().is_none_or(str::is_empty)
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            Some(url.to_string())
        }
        "mailto" => Some(url.to_string()),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    External(String),
    Drop,
}

pub fn navigation(target: &str, app_hosts: &[&str]) -> Navigation {
    let Ok(url) = Url::parse(target) else {
        return Navigation::Drop;
    };
    let own = match url.scheme() {
        "tauri" => true,
        "http" | "https" => url.host_str().is_some_and(|host| app_hosts.contains(&host)),
        _ => false,
    };
    if own {
        return Navigation::Allow;
    }
    match external_link(target) {
        Some(link) => Navigation::External(link),
        None => Navigation::Drop,
    }
}
