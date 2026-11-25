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
