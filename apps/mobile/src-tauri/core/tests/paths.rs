use agent_board_bridge_core::links::external_link;
use agent_board_bridge_core::paths::{PathRefusal, normalise_path};

#[test]
fn accepts_api_and_healthz() {
    assert_eq!(
        normalise_path("/api/client/attention").unwrap(),
        "/api/client/attention"
    );
    assert_eq!(
        normalise_path("/api/client/tasks?x=1&y=2").unwrap(),
        "/api/client/tasks?x=1&y=2"
    );
    assert_eq!(normalise_path("/healthz").unwrap(), "/healthz");
}

#[test]
fn refuses_traversal_in_any_spelling() {
    for path in [
        "/api/../etc",
        "/api/%2e%2e/x",
        "/api/%2E%2e/x",
        "/api/.%2e/x",
        "/api//x",
        "//api/x",
        "/api\\x",
        "/api/%5Cx",
        "/api/%2Fx",
        "/api/./x",
        "/api/x%00",
        "/api/x\n",
        "/api/x#frag",
        "/api/a b",
    ] {
        assert!(normalise_path(path).is_err(), "{path}");
    }
}

#[test]
fn refuses_paths_outside_the_api() {
    for path in [
        "/",
        "/index.html",
        "/healthzz",
        "api/x",
        "/apix/y",
        "/ap",
        "https://evil.example/api/x",
        "",
    ] {
        assert!(normalise_path(path).is_err(), "{path}");
    }
}

#[test]
fn refuses_credential_routes_whatever_the_case_or_query() {
    for path in [
        "/api/pair",
        "/api/PAIR",
        "/api/pair/",
        "/api/pair?x=1",
        "/api/auth/handoff/finish",
        "/api/auth/oidc/finish",
        "/api/auth/saml/finish",
        "/api/auth/passkey/login",
        "/api/auth/passkey/signup",
        "/api/client/machines/issue",
        "/api/client/account/import",
        "/api/client/passkeys/register",
        "/api/machine/register-key",
        "/api/machine/anything",
    ] {
        assert_eq!(
            normalise_path(path),
            Err(PathRefusal::CredentialRoute),
            "{path}"
        );
    }
    assert!(normalise_path("/api/auth/handoff/start").is_ok());
    assert!(normalise_path("/api/auth/logout").is_ok());
}

#[test]
fn links_open_externally_only_for_safe_schemes() {
    assert!(external_link("https://example.com/a").is_some());
    assert!(external_link("http://example.com").is_some());
    assert!(external_link("mailto:a@example.com").is_some());
    for bad in [
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///etc/passwd",
        "intent://x#Intent;end",
        "content://x",
        "blob:https://x/y",
        "ftp://x",
        "https://u:p@example.com",
        "https://",
        "not a url",
        "",
    ] {
        assert!(external_link(bad).is_none(), "{bad}");
    }
}
