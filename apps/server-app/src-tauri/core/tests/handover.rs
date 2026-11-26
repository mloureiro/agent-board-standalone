mod common;

use std::io;
use std::sync::Mutex;

use agent_board_server_core::handover::{
    CLIENT_APP_BUNDLE_ID, CommandRunner, Problem, build_link, check_target, open_board,
};
use common::repo_json;
use serde_json::Value;
use url::Url;

struct Scripted {
    exits: Mutex<Vec<io::Result<i32>>>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl Scripted {
    fn new(exits: Vec<io::Result<i32>>) -> Scripted {
        Scripted {
            exits: Mutex::new(exits),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for Scripted {
    fn run(&self, args: &[String]) -> io::Result<i32> {
        self.calls.lock().unwrap().push(args.to_vec());
        self.exits.lock().unwrap().remove(0)
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

#[test]
fn server_app_014_the_bundle_id_is_the_one_the_contract_names() {
    let contract = repo_json("packages/contract/dist/cases/bundle-id.json");
    assert_eq!(CLIENT_APP_BUNDLE_ID, text(&contract, "bundleId"));
}

#[test]
fn server_app_014_the_links_match_the_contract_build_cases() {
    let cases = repo_json("packages/contract/dist/cases/handover.json");
    let mut built = 0;
    for case in cases.as_array().unwrap() {
        if case.get("expect").is_none() {
            assert_eq!(
                build_link(text(case, "url")).as_deref(),
                Ok(text(case, "link"))
            );
            built += 1;
        }
    }
    assert!(built >= 3, "only {built} build cases were checked");
}

#[test]
fn server_app_014_the_targets_the_contract_rejects_are_never_handed_over() {
    let cases = repo_json("packages/contract/dist/cases/handover.json");
    let mut checked = 0;
    for case in cases.as_array().unwrap() {
        let Some(expect) = case.get("expect") else {
            continue;
        };
        let link = Url::parse(text(case, "link")).ok();
        let target = link.as_ref().and_then(|link| {
            link.query_pairs()
                .find(|(key, _)| key == "url")
                .map(|(_, value)| value.into_owned())
        });
        let Some(target) = target else { continue };
        if link
            .as_ref()
            .is_none_or(|link| link.scheme() != "agentboard")
        {
            continue;
        }
        let got = check_target(&target);
        if expect["ok"].as_bool().unwrap() {
            assert_eq!(got, Ok(()), "{target}");
        } else {
            let problem = text(expect, "problem");
            if matches!(problem, "credentials" | "not-loopback" | "bad-url") {
                assert_eq!(got.map_err(Problem::code), Err(problem), "{target}");
            }
        }
        checked += 1;
    }
    assert!(checked >= 8, "only {checked} cases were checked");
}

#[test]
fn server_app_014_open_board_runs_open_with_the_bundle_id_and_the_link() {
    let runner = Scripted::new(vec![Ok(0)]);
    let opened = open_board("http://127.0.0.1:4785/", &runner);

    let link = "agentboard://open?v=1&url=http%3A%2F%2F127.0.0.1%3A4785%2F";
    let expected = vec![
        "-b".to_string(),
        CLIENT_APP_BUNDLE_ID.to_string(),
        link.to_string(),
    ];
    assert_eq!(runner.calls(), vec![expected.clone()]);
    assert!(opened.in_client_app);
    assert_eq!(opened.failure, None);
    assert_eq!(
        opened.commands,
        [["open".to_string()]
            .into_iter()
            .chain(expected)
            .collect::<Vec<_>>()]
    );
}

#[test]
fn server_app_014_a_failing_handover_falls_back_to_the_default_browser() {
    for first in [Ok(1), Ok(-1), Err(io::Error::other("no such app"))] {
        let runner = Scripted::new(vec![first, Ok(0)]);
        let opened = open_board("http://localhost:4785/", &runner);

        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][0], "-b");
        assert_eq!(calls[1], ["http://localhost:4785/"]);
        assert!(!opened.in_client_app);
        assert_eq!(opened.failure, None);
        assert_eq!(opened.commands.len(), 2);
    }
}

#[test]
fn server_app_014_a_fallback_that_fails_too_reports_the_failure() {
    let runner = Scripted::new(vec![Ok(1), Ok(3)]);
    let opened = open_board("http://127.0.0.1:4785/", &runner);
    assert_eq!(opened.failure.as_deref(), Some("open exited with 3"));
    assert!(!opened.in_client_app);
}

#[test]
fn server_app_014_an_address_that_is_not_loopback_or_carries_credentials_runs_nothing() {
    for target in [
        "http://192.168.1.10:4000/",
        "https://board.example.com/",
        "http://user:secret@localhost:4000/",
        "ftp://localhost/",
        "not a url",
    ] {
        let runner = Scripted::new(vec![]);
        let opened = open_board(target, &runner);
        assert!(runner.calls().is_empty(), "{target}");
        assert!(opened.commands.is_empty());
        assert!(opened.failure.unwrap().contains("cannot be handed over"));
    }
}
