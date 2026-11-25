mod common;

use agent_board_client_core::headers::{page_headers, with_client_headers};
use agent_board_client_core::ids::{InvalidServerId, ServerId};
use agent_board_client_core::paths::{CREDENTIAL_ROUTES, Refusal, normalise};
use common::repo_json;
use std::collections::BTreeSet;

fn contract_credential_routes() -> BTreeSet<String> {
    let spec = repo_json("packages/contract/dist/openapi.json");
    spec["paths"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, operations)| {
            operations
                .as_object()
                .unwrap()
                .values()
                .any(|operation| operation["x-issues-credential"] == true)
        })
        .map(|(path, _)| path.clone())
        .collect()
}

#[test]
fn client_app_049_refuses_dot_segments_in_any_encoding() {
    for path in [
        "/api/../x",
        "/api/./x",
        "/api/x/..",
        "/api/x/.",
        "/api/%2e/x",
        "/api/%2E/x",
        "/api/%2e%2e/x",
        "/api/%2E%2E/x",
        "/api/%2e%2E/x",
        "/api/.%2e/x",
        "/api/..%2fx",
        "/healthz/..",
    ] {
        assert!(normalise(path).is_err(), "{path}");
    }
    assert_eq!(normalise("/api/../x"), Err(Refusal::DotSegment));
    assert_eq!(normalise("/api/%2E%2e/x"), Err(Refusal::EncodedSeparator));
}

#[test]
fn client_app_049_refuses_double_slash_backslash_and_encoded_separators() {
    for path in [
        "//api/x",
        "/api//x",
        "/api/x//",
        "//evil.example/api/x",
        "/api\\x",
        "/api/x\\y",
        "/api/a%2fb",
        "/api/a%2Fb",
        "/api/a%5cb",
        "/api/a%5Cb",
        "/api/a%00b",
        "/api/a\u{0}b",
        "/api/a\nb",
        "/api/a\tb",
        "/api/x#frag",
    ] {
        assert!(normalise(path).is_err(), "{path:?}");
    }
}

#[test]
fn client_app_049_refuses_paths_outside_api_and_healthz() {
    for path in [
        "",
        "/",
        "/x",
        "/apix",
        "/api",
        "/API/tasks",
        "/healthz/x",
        "/healthz/",
        "/_native/list.html",
        "api/x",
        "https://evil.example/api/x",
    ] {
        assert!(normalise(path).is_err(), "{path:?}");
    }
    assert_eq!(normalise("/x"), Err(Refusal::OutsideApi));
    assert_eq!(normalise("/healthz"), Ok("/healthz".to_owned()));
    assert_eq!(normalise("/api/tasks"), Ok("/api/tasks".to_owned()));
}

#[test]
fn client_app_049_refuses_every_credential_route_in_the_contract() {
    let contract = contract_credential_routes();
    assert!(contract.len() >= 8, "{contract:?}");

    let mut routes: BTreeSet<String> = contract.clone();
    routes.extend([
        "/api/auth/handoff/finish".to_owned(),
        "/api/pair".to_owned(),
        "/api/machine/register-key".to_owned(),
        "/api/machine/anything/else".to_owned(),
        "/api/machine".to_owned(),
    ]);
    for route in &routes {
        for variant in [
            route.clone(),
            format!("{route}/"),
            format!("{route}?x=1"),
            route.to_ascii_uppercase(),
            format!("{}/", route.to_ascii_uppercase()),
        ] {
            assert_eq!(
                normalise(&variant),
                Err(Refusal::CredentialRoute),
                "{variant}"
            );
        }
    }

    for route in &contract {
        assert!(CREDENTIAL_ROUTES.contains(&route.as_str()), "{route}");
    }
}

#[test]
fn client_app_049_refuses_credential_routes_spelled_with_encoded_unreserved_characters() {
    for path in [
        "/api/p%61ir",
        "/api/%70air",
        "/api/P%41IR",
        "/api/machin%65/register-key",
        "/api/auth/handoff/finis%68",
        "/api/tasks/%7Ex",
        "/api/tasks/a%5Fb",
        "/api/tasks/a%2Db",
        "/api/tasks/%31",
        "/api/tasks/%zz",
        "/api/tasks/%2",
        "/api/tasks/%",
    ] {
        assert_eq!(normalise(path), Err(Refusal::EncodedUnreserved), "{path}");
    }
    for path in ["/api/tasks/a%20b", "/api/tasks/%C3%A9", "/api/tasks/a%3Fb"] {
        assert_eq!(normalise(path), Ok(path.to_owned()), "{path}");
    }
}

#[test]
fn client_app_049_strips_page_credentials_and_signature_headers() {
    let page = [
        ("Authorization", "Bearer abm_page"),
        ("Cookie", "board-session=abs_page"),
        ("Host", "evil.example"),
        ("Content-Length", "1"),
        ("X-Board-Key", "k"),
        ("X-Board-Ts", "1"),
        ("X-Board-Nonce", "n"),
        ("X-Board-Sig", "forged"),
        ("Content-Digest", "d"),
        ("Content-Type", "application/json"),
        ("Accept", "text/event-stream"),
    ]
    .map(|(name, value)| (name.to_owned(), value.to_owned()));

    let kept = page_headers(&page);
    assert_eq!(
        kept,
        vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("accept".to_owned(), "text/event-stream".to_owned()),
        ]
    );

    let sent = with_client_headers(kept, "1", "client-app/0.0.0");
    assert!(sent.contains(&("x-board-contract".to_owned(), "1".to_owned())));
    assert!(sent.contains(&("x-board-client".to_owned(), "client-app/0.0.0".to_owned())));

    let page_supplied = vec![("x-board-contract".to_owned(), "7".to_owned())];
    let sent = with_client_headers(page_supplied, "1", "client-app/0.0.0");
    assert_eq!(
        sent.iter()
            .filter(|(name, _)| name == "x-board-contract")
            .collect::<Vec<_>>(),
        vec![&("x-board-contract".to_owned(), "7".to_owned())]
    );
}

#[test]
fn client_app_049_keeps_the_query_as_sent() {
    for path in [
        "/api/tasks?limit=20&q=a%2Fb",
        "/api/tasks?x=%2e%2e&y=\\",
        "/api/tasks?",
        "/healthz?probe=1",
    ] {
        assert_eq!(normalise(path), Ok(path.to_owned()));
    }
}

#[test]
fn client_app_049_server_ids_are_only_canonical_v4_uuids() {
    let id = ServerId::generate();
    assert_eq!(ServerId::parse(&id.to_string()), Ok(id));

    for text in [
        "",
        "not-a-uuid",
        "123e4567-e89b-12d3-a456-426614174000",
        "6BA7B810-9DAD-41D1-80B4-00C04FD430C8",
        "6ba7b8109dad41d180b400c04fd430c8",
        "{6ba7b810-9dad-41d1-80b4-00c04fd430c8}",
        "urn:uuid:6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "6ba7b810-9dad-41d1-80b4-00c04fd430c8/../x",
    ] {
        assert_eq!(ServerId::parse(text), Err(InvalidServerId), "{text}");
    }
    assert!(ServerId::parse("6ba7b810-9dad-41d1-80b4-00c04fd430c8").is_ok());
}
