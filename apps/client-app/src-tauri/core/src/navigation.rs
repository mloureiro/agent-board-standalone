use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Stay,
    External(Url),
    Drop,
}

fn same_origin(target: &Url, app: &Url) -> bool {
    target.scheme() == app.scheme()
        && target.host_str() == app.host_str()
        && target.port_or_known_default() == app.port_or_known_default()
}

pub fn classify(target: &Url, app: &Url) -> Navigation {
    if same_origin(target, app) {
        return Navigation::Stay;
    }
    if matches!(target.scheme(), "http" | "https") && target.host_str().is_some() {
        return Navigation::External(target.clone());
    }
    Navigation::Drop
}

pub fn app_path(target: &Url) -> String {
    match target.query() {
        Some(query) => format!("{}?{query}", target.path()),
        None => target.path().to_owned(),
    }
}
