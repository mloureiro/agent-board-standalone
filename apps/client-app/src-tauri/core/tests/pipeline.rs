mod common;

use agent_board_client_core::bridge::{Bridge, BridgeError, Scope};
use agent_board_client_core::handshake::Handshake;
use agent_board_client_core::ports::{PortError, SecretStore};
use agent_board_client_core::servers::Servers;
use agent_board_client_core::signing::{RequestSigner, canonical_string};
use agent_board_client_core::tokens::{key_service, token_service};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::*;
use futures_util::StreamExt;
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use std::sync::Arc;

const SERVER_URL: &str = "https://board.example.test/";

fn listed() -> MemoryFiles {
    servers_file(&[
        (FIRST_ID, "Alpha", SERVER_URL),
        (SECOND_ID, "Beta", "http://localhost:4000/"),
    ])
}

fn page_headers() -> Vec<(String, String)> {
    vec![("Accept".to_owned(), "application/json".to_owned())]
}

async fn collect(response: agent_board_client_core::bridge::ServerResponse) -> Vec<Vec<u8>> {
    response
        .body
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
}

#[tokio::test]
async fn client_app_049_refuses_a_server_outside_the_calling_webview_scope() {
    let harness = harness([], listed(), true);
    let foreign = [
        (scope_of(FIRST_ID), SECOND_ID),
        (Scope::None, FIRST_ID),
        (Scope::from_label("window-1", &[id(FIRST_ID)]), FIRST_ID),
        (Scope::AllServers(vec![id(FIRST_ID)]), SECOND_ID),
        (scope_of(FIRST_ID), "not-an-id"),
        (scope_of(FIRST_ID), "6BA7B810-9DAD-41D1-80B4-00C04FD430C8"),
    ];
    for (scope, target) in foreign {
        let refused = harness
            .bridge
            .server_fetch(&scope, target, "GET", "/api/tasks", &[], None)
            .await;
        match refused {
            Err(error) => {
                assert_eq!(error, BridgeError::UnknownServer);
                assert_eq!(error.message(), "unknown server");
            }
            Ok(_) => panic!("{scope:?} reached {target}"),
        }
    }
    assert!(harness.http.sent().is_empty());
}

#[tokio::test]
async fn client_app_049_adds_token_and_signature_and_streams_the_answer() {
    let harness = harness(
        [Ok(Canned {
            status: 200,
            headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
            chunks: vec![b"data: 1\n\n".to_vec(), b"data: 2\n\n".to_vec()],
        })],
        listed(),
        true,
    );
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    harness.bridge.record_handshake(
        id(FIRST_ID),
        Handshake {
            request_signature: true,
        },
    );
    let page = vec![
        ("Accept".to_owned(), "text/event-stream".to_owned()),
        ("Authorization".to_owned(), "Bearer page".to_owned()),
        ("X-Board-Sig".to_owned(), "forged".to_owned()),
        ("Cookie".to_owned(), "a=b".to_owned()),
    ];

    let response = harness
        .bridge
        .server_fetch(
            &scope_of(FIRST_ID),
            FIRST_ID,
            "post",
            "/api/tasks?limit=5",
            &page,
            Some("{\"a\":1}"),
        )
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        collect(response).await,
        vec![b"data: 1\n\n".to_vec(), b"data: 2\n\n".to_vec()]
    );

    let sent = harness.http.sent().remove(0);
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, "https://board.example.test/api/tasks?limit=5");
    assert_eq!(sent.body, b"{\"a\":1}");
    assert!(sent.limits.is_none());
    assert_eq!(sent.header("accept"), Some("text/event-stream"));
    assert_eq!(
        sent.header("authorization"),
        Some(format!("Bearer {}", token()).as_str())
    );
    assert_eq!(sent.header("cookie"), None);
    assert_eq!(sent.header("x-board-contract"), Some("1"));
    assert_eq!(sent.header("x-board-client"), Some("web/1.2.3"));
    assert_eq!(
        sent.headers
            .iter()
            .filter(|(k, _)| k == "authorization")
            .count(),
        1
    );

    let stored = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();
    let signer = RequestSigner::from_pkcs8_der(&stored).unwrap();
    assert_eq!(
        sent.header("x-board-key"),
        Some(signer.key_id().unwrap().as_str())
    );
    let digest = sent.header("content-digest").unwrap();
    assert!(digest.starts_with("sha-256=:"));
    let canonical = canonical_string(
        "POST",
        "/api/tasks?limit=5",
        sent.header("x-board-ts").unwrap().parse().unwrap(),
        sent.header("x-board-nonce").unwrap(),
        Some(digest),
    )
    .unwrap();
    let public = VerifyingKey::from_public_key_der(&signer.public_key_der().unwrap()).unwrap();
    let signature = URL_SAFE_NO_PAD
        .decode(sent.header("x-board-sig").unwrap())
        .unwrap();
    public
        .verify(
            canonical.as_bytes(),
            &Signature::from_slice(&signature).unwrap(),
        )
        .unwrap();
}

#[tokio::test]
async fn client_app_049_sends_no_signature_unless_the_handshake_asked_for_one() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    harness
        .bridge
        .server_fetch(
            &scope_of(FIRST_ID),
            FIRST_ID,
            "GET",
            "/healthz",
            &page_headers(),
            None,
        )
        .await
        .unwrap();
    let sent = harness.http.sent().remove(0);
    for name in [
        "x-board-key",
        "x-board-sig",
        "x-board-ts",
        "x-board-nonce",
        "authorization",
    ] {
        assert_eq!(sent.header(name), None, "{name}");
    }
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());
}

#[tokio::test]
async fn client_app_049_sends_exactly_the_checked_path_and_refuses_the_rest() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    harness
        .bridge
        .server_fetch(
            &scope_of(FIRST_ID),
            FIRST_ID,
            "GET",
            "/api/a%20b?q=%3F&x=1",
            &[],
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        harness.http.sent()[0].url,
        "https://board.example.test/api/a%20b?q=%3F&x=1"
    );

    for path in ["/api/p%61ir", "/api/pair", "/api/../x", "//evil", "/other"] {
        let refused = harness
            .bridge
            .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", path, &[], None)
            .await;
        assert!(matches!(refused, Err(BridgeError::Path(_))), "{path}");
    }
    let refused = harness
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "TRACE", "/api/x", &[], None)
        .await;
    assert!(matches!(refused, Err(BridgeError::Method)));
    assert_eq!(harness.http.sent().len(), 1);
}

#[tokio::test]
async fn client_app_038_unauthorized_deletes_the_token_only_if_it_was_the_one_sent() {
    let unauthorized = || {
        Ok(Canned::json(
            401,
            r#"{"error":{"code":"unauthorized","message":"x"}}"#,
        ))
    };

    let same = harness([unauthorized()], listed(), true);
    same.secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    let response = same
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert_eq!(response.status, 401);
    let body = collect(response).await.concat();
    assert!(String::from_utf8(body).unwrap().contains("unauthorized"));
    assert!(same.secrets.peek(&token_service(), FIRST_ID).is_none());
    assert!(same.bridge.is_expired(id(FIRST_ID)));

    let replaced = harness([unauthorized()], listed(), true);
    replaced
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    let secrets = Arc::clone(&replaced.secrets);
    replaced
        .http
        .on_send(move || secrets.put(&token_service(), FIRST_ID, other_token().as_bytes()));
    replaced
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert_eq!(
        replaced.secrets.peek(&token_service(), FIRST_ID).as_deref(),
        Some(other_token().as_bytes())
    );
    assert!(!replaced.bridge.is_expired(id(FIRST_ID)));

    let unknown_key = harness(
        [Ok(Canned::json(
            401,
            r#"{"error":{"code":"key-unknown","message":"x"}}"#,
        ))],
        listed(),
        true,
    );
    unknown_key
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    unknown_key
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert!(
        unknown_key
            .secrets
            .peek(&token_service(), FIRST_ID)
            .is_some()
    );
    assert!(!unknown_key.bridge.is_expired(id(FIRST_ID)));
}

#[tokio::test]
async fn client_app_038_a_malformed_entry_is_deleted_on_read() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    harness
        .secrets
        .put(&token_service(), FIRST_ID, b"not-a-token");
    harness
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert_eq!(harness.http.sent()[0].header("authorization"), None);
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
}

#[tokio::test]
async fn client_app_049_signs_exactly_the_path_put_on_the_wire() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    harness.bridge.record_handshake(
        id(FIRST_ID),
        Handshake {
            request_signature: true,
        },
    );
    harness
        .bridge
        .server_fetch(
            &scope_of(FIRST_ID),
            FIRST_ID,
            "GET",
            "/api/a b?q=it's \"x\"&r=%3F",
            &[],
            None,
        )
        .await
        .unwrap();

    let sent = harness.http.sent().remove(0);
    let wire = "/api/a%20b?q=it%27s%20%22x%22&r=%3F";
    assert_eq!(sent.url, format!("https://board.example.test{wire}"));
    let reparsed = url::Url::parse(&sent.url).unwrap();
    assert_eq!(&reparsed[url::Position::BeforePath..], wire);

    let stored = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();
    let signer = RequestSigner::from_pkcs8_der(&stored).unwrap();
    let canonical = canonical_string(
        "GET",
        wire,
        sent.header("x-board-ts").unwrap().parse().unwrap(),
        sent.header("x-board-nonce").unwrap(),
        None,
    )
    .unwrap();
    let public = VerifyingKey::from_public_key_der(&signer.public_key_der().unwrap()).unwrap();
    let signature = URL_SAFE_NO_PAD
        .decode(sent.header("x-board-sig").unwrap())
        .unwrap();
    public
        .verify(
            canonical.as_bytes(),
            &Signature::from_slice(&signature).unwrap(),
        )
        .unwrap();
}

#[derive(Default)]
struct KeyReadDenied {
    inner: MemorySecrets,
}

impl SecretStore for KeyReadDenied {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, PortError> {
        if service == key_service() {
            return Err(PortError("denied".to_owned()));
        }
        self.inner.get(service, account)
    }
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), PortError> {
        self.inner.set(service, account, secret)
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), PortError> {
        self.inner.delete(service, account)
    }
    fn accounts(&self, service: &str) -> Result<Vec<String>, PortError> {
        self.inner.accounts(service)
    }
}

#[tokio::test]
async fn client_app_052_a_denied_key_read_never_replaces_the_stored_key() {
    let http = FakeHttp::answering([]);
    let secrets = Arc::new(KeyReadDenied::default());
    let paired = RequestSigner::generate().to_pkcs8_der().unwrap();
    secrets.inner.put(&key_service(), FIRST_ID, &paired);
    let bridge = Bridge::new(
        http.clone(),
        Arc::clone(&secrets),
        FakeConfirm::answering(true),
        FakeClock,
        Servers::open(listed()),
        client_info(),
    );
    bridge.record_handshake(
        id(FIRST_ID),
        Handshake {
            request_signature: true,
        },
    );

    let refused = bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await;

    assert!(matches!(refused, Err(BridgeError::Native(_))));
    assert!(http.sent().is_empty());
    assert_eq!(
        secrets.inner.peek(&key_service(), FIRST_ID).as_deref(),
        Some(paired.as_slice())
    );
}

struct DeniedSecrets;

impl SecretStore for DeniedSecrets {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, PortError> {
        Err(PortError("denied".to_owned()))
    }
    fn set(&self, _: &str, _: &str, _: &[u8]) -> Result<(), PortError> {
        Err(PortError("denied".to_owned()))
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), PortError> {
        Err(PortError("denied".to_owned()))
    }
    fn accounts(&self, _: &str) -> Result<Vec<String>, PortError> {
        Err(PortError("denied".to_owned()))
    }
}

#[tokio::test]
async fn client_app_038_a_denied_keychain_read_counts_as_absent() {
    let http = FakeHttp::answering([Ok(Canned::json(200, "{}"))]);
    let bridge = Bridge::new(
        http.clone(),
        Arc::new(DeniedSecrets),
        FakeConfirm::answering(true),
        FakeClock,
        Servers::open(listed()),
        client_info(),
    );
    bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    assert_eq!(http.sent()[0].header("authorization"), None);
}
