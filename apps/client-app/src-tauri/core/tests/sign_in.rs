mod common;

use common::*;
use rumo_client_core::bridge::{Bridge, BridgeError, HandoffStatus};
use rumo_client_core::handshake::Handshake;
use rumo_client_core::ports::SecretStore;
use rumo_client_core::servers::Servers;
use rumo_client_core::signing::RequestSigner;
use rumo_client_core::tokens::{key_service, token_service};
use serde_json::{Value, json};
use std::sync::Arc;

const SERVER_URL: &str = "https://board.example.test/";
const FLOW: &str = "flow-0001";

fn verifier() -> String {
    "v".repeat(43)
}

fn listed() -> MemoryFiles {
    servers_file(&[
        (FIRST_ID, "Alpha", SERVER_URL),
        (SECOND_ID, "Beta", "http://localhost:4000/"),
    ])
}

fn signs(harness: &Harness, on: bool) {
    harness.bridge.record_handshake(
        id(FIRST_ID),
        Handshake {
            request_signature: on,
        },
    );
}

fn signed_in(token: &str) -> Result<Canned, String> {
    Ok(Canned::json(
        200,
        &json!({"status": "signed-in", "token": token}).to_string(),
    ))
}

fn pending() -> Result<Canned, String> {
    Ok(Canned::json(200, r#"{"status":"pending"}"#))
}

fn refusal(status: u16) -> Result<Canned, String> {
    Ok(Canned::json(
        status,
        r#"{"error":{"code":"forbidden","message":"no"}}"#,
    ))
}

fn unauthorized() -> Result<Canned, String> {
    Ok(Canned::json(
        401,
        r#"{"error":{"code":"unauthorized","message":"x"}}"#,
    ))
}

fn key_unknown() -> Result<Canned, String> {
    Ok(Canned::json(
        401,
        r#"{"error":{"code":"key-unknown","message":"x"}}"#,
    ))
}

fn sent_json(harness: &Harness, index: usize) -> Value {
    serde_json::from_slice(&harness.http.sent()[index].body).unwrap()
}

fn stored_signer(harness: &Harness) -> RequestSigner {
    let der = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();
    RequestSigner::from_pkcs8_der(&der).unwrap()
}

async fn finish(harness: &Harness) -> Result<HandoffStatus, BridgeError> {
    harness
        .bridge
        .handoff_finish(&scope_of(FIRST_ID), FIRST_ID, FLOW, &verifier())
        .await
}

async fn fetch_me(harness: &Harness) -> u16 {
    harness
        .bridge
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap()
        .status
}

#[tokio::test]
async fn client_app_052_handoff_finish_sends_the_keychain_public_key_when_signatures_are_on() {
    let harness = harness([signed_in(&token())], listed(), true);
    signs(&harness, true);

    assert_eq!(finish(&harness).await, Ok(HandoffStatus::SignedIn));

    let sent = harness.http.sent().remove(0);
    assert_eq!(sent.method, "POST");
    assert_eq!(
        sent.url,
        "https://board.example.test/api/auth/handoff/finish"
    );
    assert_eq!(sent.header("authorization"), None);
    assert_eq!(sent.header("x-board-sig"), None);
    assert_eq!(sent.header("content-type"), Some("application/json"));
    assert_eq!(sent.header("x-board-contract"), Some("1"));
    let public_key = stored_signer(&harness).public_key().unwrap();
    assert_eq!(
        sent_json(&harness, 0),
        json!({
            "flow": FLOW,
            "verifier": verifier(),
            "tokenKind": "client",
            "publicKey": public_key,
        })
    );
    assert_eq!(
        harness.secrets.peek(&token_service(), FIRST_ID),
        Some(token().into_bytes())
    );
}

#[tokio::test]
async fn client_app_052_handoff_finish_sends_no_key_and_makes_none_when_signatures_are_off() {
    let harness = harness([signed_in(&token())], listed(), true);
    signs(&harness, false);

    assert_eq!(finish(&harness).await, Ok(HandoffStatus::SignedIn));

    assert_eq!(
        sent_json(&harness, 0),
        json!({"flow": FLOW, "verifier": verifier(), "tokenKind": "client"})
    );
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_some());
}

#[tokio::test]
async fn client_app_052_a_pending_handoff_stores_nothing_and_a_failed_one_drops_its_new_key() {
    let harness = harness(
        [pending(), refusal(403), signed_in("abc_not-a-token")],
        listed(),
        true,
    );
    signs(&harness, true);

    assert_eq!(finish(&harness).await, Ok(HandoffStatus::Pending));
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_some());

    harness.secrets.delete(&key_service(), FIRST_ID).unwrap();
    assert!(finish(&harness).await.is_err());
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());

    assert!(finish(&harness).await.is_err());
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
}

#[tokio::test]
async fn client_app_052_a_failed_handoff_keeps_a_key_an_earlier_request_created() {
    let harness = harness([Ok(Canned::json(200, "{}")), refusal(403)], listed(), true);
    signs(&harness, true);
    fetch_me(&harness).await;
    let earlier = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();

    assert!(finish(&harness).await.is_err());

    assert_eq!(
        harness.secrets.peek(&key_service(), FIRST_ID),
        Some(earlier)
    );
    assert_eq!(
        sent_json(&harness, 1)["publicKey"],
        json!(stored_signer(&harness).public_key().unwrap())
    );
}

#[tokio::test]
async fn client_app_052_a_new_sign_in_clears_the_expired_state() {
    let harness = harness([unauthorized(), signed_in(&other_token())], listed(), true);
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    assert_eq!(fetch_me(&harness).await, 401);
    assert!(harness.bridge.is_expired(id(FIRST_ID)));

    assert_eq!(finish(&harness).await, Ok(HandoffStatus::SignedIn));

    assert!(!harness.bridge.is_expired(id(FIRST_ID)));
}

#[tokio::test]
async fn client_app_052_pair_posts_the_code_label_and_public_key_and_leaves_nothing_on_failure() {
    let harness = harness(
        [
            Ok(Canned::json(200, r#"{"keyId":"k"}"#)),
            refusal(403),
            Err("connection refused".to_owned()),
            Ok(Canned::json(200, "{}")),
            refusal(403),
        ],
        listed(),
        true,
    );
    let scope = scope_of(FIRST_ID);

    harness
        .bridge
        .pair(&scope, FIRST_ID, "ABCD-2345", "My Mac")
        .await
        .unwrap();
    let sent = harness.http.sent().remove(0);
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, "https://board.example.test/api/pair");
    assert_eq!(sent.header("authorization"), None);
    let public_key = stored_signer(&harness).public_key().unwrap();
    assert_eq!(
        sent_json(&harness, 0),
        json!({"code": "ABCD-2345", "label": "My Mac", "publicKey": public_key})
    );

    harness.secrets.delete(&key_service(), FIRST_ID).unwrap();
    for _ in 0..2 {
        let failed = harness
            .bridge
            .pair(&scope, FIRST_ID, "ABCD-2345", "My Mac")
            .await;
        assert!(failed.is_err());
        assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());
        assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
    }

    signs(&harness, true);
    fetch_me(&harness).await;
    let earlier = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();
    assert!(
        harness
            .bridge
            .pair(&scope, FIRST_ID, "ABCD-2345", "My Mac")
            .await
            .is_err()
    );
    assert_eq!(
        harness.secrets.peek(&key_service(), FIRST_ID),
        Some(earlier)
    );
    assert_eq!(
        sent_json(&harness, 4)["publicKey"],
        json!(stored_signer(&harness).public_key().unwrap())
    );
}

#[tokio::test]
async fn client_app_052_an_unpaired_server_gets_signed_requests_so_the_page_sees_key_unknown() {
    let harness = harness([key_unknown()], listed(), true);
    signs(&harness, true);

    let response = harness
        .bridge
        .server_fetch(
            &scope_of(FIRST_ID),
            FIRST_ID,
            "GET",
            "/api/tasks",
            &[],
            None,
        )
        .await
        .unwrap();

    assert_eq!(response.status, 401);
    let sent = harness.http.sent().remove(0);
    let signer = stored_signer(&harness);
    assert_eq!(
        sent.header("x-board-key"),
        Some(signer.key_id().unwrap().as_str())
    );
    assert!(sent.header("x-board-sig").is_some());
    assert!(!harness.bridge.is_expired(id(FIRST_ID)));
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_some());
}

#[tokio::test]
async fn client_app_037_the_token_never_appears_in_any_answer_to_the_page() {
    use futures_util::StreamExt;

    let leak = token();
    let harness = harness(
        [
            signed_in(&leak),
            Ok(Canned::json(200, r#"{"me":"x"}"#)),
            Ok(Canned::json(
                200,
                &json!({"status": "signed-in", "token": format!("{leak}!")}).to_string(),
            )),
            Err("offline".to_owned()),
            Ok(Canned::json(200, "{}")),
            Ok(Canned::json(200, "{}")),
        ],
        listed(),
        true,
    );
    signs(&harness, true);
    let scope = scope_of(FIRST_ID);
    let mut answers: Vec<String> = Vec::new();

    answers.push(
        finish(&harness)
            .await
            .map(|status| status.as_str().to_owned())
            .unwrap(),
    );
    let response = harness
        .bridge
        .server_fetch(&scope, FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();
    answers.push(format!("{} {:?}", response.status, response.headers));
    for chunk in response.body.collect::<Vec<_>>().await {
        answers.push(String::from_utf8(chunk.unwrap()).unwrap());
    }
    answers.push(finish(&harness).await.unwrap_err().message());
    answers.push(
        harness
            .bridge
            .server_fetch(&scope, FIRST_ID, "GET", "/api/me", &[], None)
            .await
            .err()
            .unwrap()
            .message(),
    );
    answers.push(
        harness
            .bridge
            .pair(&scope, FIRST_ID, "ABCD-2345", "Mac")
            .await
            .map(|()| "paired".to_owned())
            .unwrap(),
    );
    harness.bridge.sign_out(&scope, FIRST_ID).await.unwrap();
    answers.push(serde_json::to_string(&harness.bridge.list_servers(&scope)).unwrap());
    answers.push(BridgeError::UnknownServer.message());

    for answer in &answers {
        assert!(!answer.contains(&leak), "{answer}");
        assert!(!answer.contains("abc_"), "{answer}");
    }
    assert!(answers.len() >= 7);
}

#[tokio::test]
async fn client_app_038_a_malformed_keychain_entry_is_deleted_on_read() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    signs(&harness, true);
    harness.secrets.put(&key_service(), FIRST_ID, b"not-a-key");
    harness
        .secrets
        .put(&token_service(), FIRST_ID, b"not-a-token");

    fetch_me(&harness).await;

    let sent = harness.http.sent().remove(0);
    assert_eq!(sent.header("authorization"), None);
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
    let replacement = harness.secrets.peek(&key_service(), FIRST_ID).unwrap();
    assert_ne!(replacement, b"not-a-key");
    assert!(RequestSigner::from_pkcs8_der(&replacement).is_ok());
}

#[tokio::test]
async fn client_app_038_unauthorized_also_deletes_the_key_it_signed_with_only_if_unchanged() {
    let same = harness([unauthorized()], listed(), true);
    signs(&same, true);
    same.secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    assert_eq!(fetch_me(&same).await, 401);
    assert!(same.secrets.peek(&token_service(), FIRST_ID).is_none());
    assert!(same.secrets.peek(&key_service(), FIRST_ID).is_none());

    let replaced = harness([unauthorized()], listed(), true);
    signs(&replaced, true);
    replaced
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    let secrets = Arc::clone(&replaced.secrets);
    let newer = RequestSigner::generate().to_pkcs8_der().unwrap();
    let expected = newer.clone();
    replaced.http.on_send(move || {
        secrets.put(&token_service(), FIRST_ID, other_token().as_bytes());
        secrets.put(&key_service(), FIRST_ID, &newer);
    });
    assert_eq!(fetch_me(&replaced).await, 401);
    assert!(replaced.secrets.peek(&token_service(), FIRST_ID).is_some());
    assert_eq!(
        replaced.secrets.peek(&key_service(), FIRST_ID),
        Some(expected)
    );
}

#[tokio::test]
async fn client_app_039_sign_out_deletes_token_and_signing_key_and_calls_logout() {
    let harness = harness([Ok(Canned::json(200, "{}"))], listed(), true);
    signs(&harness, true);
    harness
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    harness.secrets.put(
        &key_service(),
        FIRST_ID,
        &RequestSigner::generate().to_pkcs8_der().unwrap(),
    );
    harness
        .secrets
        .put(&token_service(), SECOND_ID, other_token().as_bytes());

    harness
        .bridge
        .sign_out(&scope_of(FIRST_ID), FIRST_ID)
        .await
        .unwrap();

    let sent = harness.http.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].method, "POST");
    assert_eq!(sent[0].url, "https://board.example.test/api/auth/logout");
    assert_eq!(
        sent[0].header("authorization"),
        Some(format!("Bearer {}", token()).as_str())
    );
    assert!(harness.secrets.peek(&token_service(), FIRST_ID).is_none());
    assert!(harness.secrets.peek(&key_service(), FIRST_ID).is_none());
    assert!(harness.secrets.peek(&token_service(), SECOND_ID).is_some());
}

#[tokio::test]
async fn client_app_039_sign_out_ignores_errors_and_a_missing_session_makes_no_call() {
    let failing = harness([Err("offline".to_owned())], listed(), true);
    failing
        .secrets
        .put(&token_service(), FIRST_ID, token().as_bytes());
    failing.secrets.put(&key_service(), FIRST_ID, b"whatever");
    failing
        .bridge
        .sign_out(&scope_of(FIRST_ID), FIRST_ID)
        .await
        .unwrap();
    assert!(failing.secrets.peek(&token_service(), FIRST_ID).is_none());
    assert!(failing.secrets.peek(&key_service(), FIRST_ID).is_none());

    let signed_out = harness([], listed(), true);
    signed_out
        .bridge
        .sign_out(&scope_of(FIRST_ID), FIRST_ID)
        .await
        .unwrap();
    assert!(signed_out.http.sent().is_empty());

    let foreign = signed_out
        .bridge
        .sign_out(&scope_of(FIRST_ID), SECOND_ID)
        .await;
    assert_eq!(foreign, Err(BridgeError::UnknownServer));
}

#[tokio::test]
async fn client_app_035_a_stored_token_is_used_after_a_restart() {
    let first = harness([signed_in(&token())], listed(), true);
    assert_eq!(finish(&first).await, Ok(HandoffStatus::SignedIn));

    let http = FakeHttp::answering([Ok(Canned::json(200, "{}"))]);
    let restarted = Bridge::new(
        http.clone(),
        Arc::clone(&first.secrets),
        FakeConfirm::answering(true),
        FakeClock,
        Servers::open(first.files.clone()),
        client_info(),
    );
    restarted
        .server_fetch(&scope_of(FIRST_ID), FIRST_ID, "GET", "/api/me", &[], None)
        .await
        .unwrap();

    assert_eq!(
        http.sent()[0].header("authorization"),
        Some(format!("Bearer {}", token()).as_str())
    );
    assert!(!restarted.is_expired(id(FIRST_ID)));
}
