use crate::navigation::{self, Navigation};
use crate::page_input;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Navigation,
    NewWindow,
    ModifiedClick,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    Stay,
    Tab(String),
    External(String),
    Drop,
}

pub fn classify(requested: &str, app: &Url, trigger: Trigger) -> Link {
    let Ok(url) = Url::parse(requested) else {
        return Link::Drop;
    };
    match navigation::classify(&url, app) {
        Navigation::Stay => match trigger {
            Trigger::Navigation => Link::Stay,
            Trigger::NewWindow | Trigger::ModifiedClick => Link::Tab(navigation::app_path(&url)),
        },
        Navigation::External(_) => match page_input::link(requested) {
            Ok(external) => Link::External(external.to_string()),
            Err(_) => Link::Drop,
        },
        Navigation::Drop => Link::Drop,
    }
}
