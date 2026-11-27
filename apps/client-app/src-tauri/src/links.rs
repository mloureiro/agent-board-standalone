use rumo_client_core::links::{Link, Trigger, classify};
use std::process::{Command, Stdio};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Runtime, Url};

pub fn open_in_default_browser(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg("--")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "the link could not be opened".to_owned())
}

fn route(
    url: &Url,
    origin: &Url,
    trigger: Trigger,
    open_external: &dyn Fn(&str),
    open_tab: &dyn Fn(String),
) -> bool {
    match classify(url.as_str(), origin, trigger) {
        Link::Stay => true,
        Link::External(external) => {
            open_external(&external);
            false
        }
        Link::Tab(path) => {
            open_tab(path);
            false
        }
        Link::Drop => false,
    }
}

fn launch(url: &str) {
    let _ = open_in_default_browser(url);
}

pub fn guard(origin: Url) -> impl Fn(&Url) -> bool + Send + 'static {
    move |target| route(target, &origin, Trigger::Navigation, &launch, &|_| {})
}

pub fn on_new_window<R: Runtime>(
    origin: Url,
    open_tab: impl Fn(String) + Send + 'static,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
    move |target, _| {
        route(&target, &origin, Trigger::NewWindow, &launch, &open_tab);
        NewWindowResponse::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn origin() -> Url {
        Url::parse("tauri://localhost").unwrap()
    }

    fn run(target: &str, trigger: Trigger) -> (bool, Vec<String>, Vec<String>) {
        let (externals, tabs) = (RefCell::new(vec![]), RefCell::new(vec![]));
        let stays = route(
            &Url::parse(target).unwrap(),
            &origin(),
            trigger,
            &|url| externals.borrow_mut().push(url.to_owned()),
            &|path| tabs.borrow_mut().push(path),
        );
        (stays, externals.into_inner(), tabs.into_inner())
    }

    #[test]
    fn client_app_031_an_external_origin_opens_outside_and_never_navigates_the_tab() {
        for trigger in [Trigger::Navigation, Trigger::NewWindow] {
            let (stays, externals, tabs) = run("https://github.com/o/r/pull/1", trigger);
            assert!(!stays);
            assert_eq!(externals, ["https://github.com/o/r/pull/1"]);
            assert!(tabs.is_empty());
        }
    }

    #[test]
    fn client_app_033_an_app_path_stays_on_navigation_and_opens_a_tab_from_a_new_window() {
        assert_eq!(
            run("tauri://localhost/tasks/1", Trigger::Navigation),
            (true, vec![], vec![])
        );
        assert_eq!(
            run("tauri://localhost/tasks/1?x=1", Trigger::NewWindow),
            (false, vec![], vec!["/tasks/1?x=1".to_owned()])
        );
    }

    #[test]
    fn client_app_032_dropped_schemes_reach_neither_the_browser_nor_a_tab() {
        for target in [
            "mailto:a@example.test",
            "file:///etc/hosts",
            "javascript:alert(1)",
            "data:text/html,x",
            "about:blank",
        ] {
            for trigger in [Trigger::Navigation, Trigger::NewWindow] {
                assert_eq!(run(target, trigger), (false, vec![], vec![]), "{target}");
            }
        }
    }
}
