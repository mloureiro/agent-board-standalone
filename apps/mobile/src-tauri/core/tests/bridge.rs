use agent_board_bridge_core::bridge::{Bridge, BridgeConfig, BridgeError};
use agent_board_bridge_core::ports::{
    Confirm, Env, Http, HttpRequest, HttpResponse, KeyStore, Store,
};
use agent_board_bridge_core::sign::key_id_of;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey, signature::Signer, signature::Verifier};
use p256::pkcs8::EncodePublicKey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Seen = Arc<Mutex<Vec<(String, String, Vec<(String, String)>, Option<Vec<u8>>)>>>;

#[derive(Clone)]
struct FakeHttp {
    seen: Seen,
    answers: Arc<Mutex<HashMap<String, (u16, String)>>>,
}

impl FakeHttp {
    fn new() -> Self {
        Self {
            seen: Seen::default(),
            answers: Arc::default(),
        }
    }
    fn answer(&self, path: &str, status: u16, body: &str) {
        self.answers
            .lock()
            .unwrap()
            .insert(path.into(), (status, body.into()));
    }
}

impl Http for FakeHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.seen.lock().unwrap().push((
            request.method.clone(),
            request.url.clone(),
            request.headers.clone(),
            request.body.clone(),
        ));
        let path = request
            .url
            .split_once("://")
            .unwrap()
            .1
            .split_once('/')
            .unwrap()
            .1;
        let (status, body) = self
            .answers
            .lock()
            .unwrap()
            .get(&format!("/{path}"))
            .cloned()
            .unwrap_or((200, "{}".into()));
        Ok(HttpResponse {
            status,
            headers: vec![],
            body: Box::pin(futures_util::stream::iter(vec![Ok(body.into_bytes())])),
        })
    }
}

#[derive(Clone)]
struct FakeKeys {
    key: SigningKey,
    tokens: Arc<Mutex<HashMap<String, String>>>,
    deleted_keys: Arc<Mutex<Vec<String>>>,
}

impl FakeKeys {
    fn new() -> Self {
        let secret = [7u8; 32];
        Self {
            key: SigningKey::from_slice(&secret).unwrap(),
            tokens: Arc::default(),
            deleted_keys: Arc::default(),
        }
    }
    fn public(&self) -> String {
        let der = self.key.verifying_key().to_public_key_der().unwrap();
        URL_SAFE_NO_PAD.encode(der.as_bytes())
    }
}

impl KeyStore for FakeKeys {
    fn token(&self, id: &str) -> Option<String> {
        self.tokens.lock().unwrap().get(id).cloned()
    }
    fn set_token(&self, id: &str, token: &str) -> Result<(), String> {
        self.tokens.lock().unwrap().insert(id.into(), token.into());
        Ok(())
    }
    fn delete_token(&self, id: &str) -> Result<(), String> {
        self.tokens.lock().unwrap().remove(id);
        Ok(())
    }
    fn public_key(&self, _id: &str) -> Result<String, String> {
        Ok(self.public())
    }
    fn sign(&self, _id: &str, message: &[u8]) -> Result<String, String> {
        let signature: Signature = self.key.sign(message);
        Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }
    fn delete_key(&self, id: &str) -> Result<(), String> {
        self.deleted_keys.lock().unwrap().push(id.into());
        Ok(())
    }
}

struct Answer(bool);
impl Confirm for Answer {
    fn add_server(&self, _: &str, _: &str) -> bool {
        self.0
    }
    fn remove_server(&self, _: &str) -> bool {
        self.0
    }
}

struct FixedEnv(Mutex<u32>);
impl Env for FixedEnv {
    fn now_secs(&self) -> u64 {
        1_767_225_600
    }
    fn nonce(&self) -> String {
        "AAAAAAAAAAAAAAAAAAAAAA".into()
    }
    fn new_id(&self) -> String {
        let mut n = self.0.lock().unwrap();
        *n += 1;
        format!("00000000-0000-4000-8000-{:012}", *n)
    }
}

#[derive(Clone, Default)]
struct MemoryStore(Arc<Mutex<Option<String>>>);
impl Store for MemoryStore {
    fn load(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn save(&self, text: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(text.into());
        Ok(())
    }
}

type TestBridge = Bridge<FakeHttp, FakeKeys, Answer, FixedEnv, MemoryStore>;

fn setup(confirm: bool) -> (TestBridge, FakeHttp, FakeKeys, MemoryStore) {
    let http = FakeHttp::new();
    let keys = FakeKeys::new();
    let store = MemoryStore::default();
    let bridge = Bridge::new(
        http.clone(),
        keys.clone(),
        Answer(confirm),
        FixedEnv(Mutex::new(0)),
        store.clone(),
        BridgeConfig {
            contract: 1,
            client_version: "1.0.0".into(),
        },
    );
    (bridge, http, keys, store)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

fn add(bridge: &TestBridge) -> String {
    bridge
        .add_server("Home", "https://board.example.com")
        .unwrap()
        .unwrap()
        .id
}

#[tokio::test]
async fn adding_a_server_needs_confirmation_and_a_valid_address() {
    let (bridge, ..) = setup(false);
    assert_eq!(
        bridge.add_server("x", "https://board.example.com"),
        Ok(None)
    );
    assert!(bridge.list_servers().is_empty());
    let (bridge, ..) = setup(true);
    assert!(matches!(
        bridge.add_server("x", "http://board.example.com"),
        Err(BridgeError::Address(_))
    ));
    assert!(matches!(
        bridge.add_server("x", "https://u:p@board.example.com"),
        Err(BridgeError::Address(_))
    ));
    let entry = bridge
        .add_server(" Home ", "https://board.example.com")
        .unwrap()
        .unwrap();
    assert_eq!(entry.name, "Home");
    assert_eq!(entry.url, "https://board.example.com/");
    assert_eq!(bridge.list_servers().len(), 1);
}

#[tokio::test]
async fn two_entries_for_one_address_get_separate_ids() {
    let (bridge, ..) = setup(true);
    let first = add(&bridge);
    let second = add(&bridge);
    assert_ne!(first, second);
}

#[tokio::test]
async fn the_server_list_survives_a_restart() {
    let (bridge, _, keys, store) = setup(true);
    let id = add(&bridge);
    let again = Bridge::new(
        FakeHttp::new(),
        keys,
        Answer(true),
        FixedEnv(Mutex::new(5)),
        store,
        BridgeConfig {
            contract: 1,
            client_version: "1.0.0".into(),
        },
    );
    assert_eq!(again.list_servers()[0].id, id);
}

#[tokio::test]
async fn fetch_adds_the_credential_and_drops_the_pages_own() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    keys.set_token(&id, "abc_token").unwrap();
    let headers = vec![
        ("Authorization".to_string(), "Bearer stolen".to_string()),
        ("Cookie".to_string(), "abs_x=1".to_string()),
        ("x-board-sig".to_string(), "forged".to_string()),
        ("x-board-key".to_string(), "forged".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Host".to_string(), "evil.example".to_string()),
    ];
    bridge
        .server_fetch(
            &id,
            "post",
            "/api/client/tasks/create",
            &headers,
            Some("{}"),
        )
        .await
        .unwrap();
    let seen = http.seen.lock().unwrap();
    let (method, url, sent, _) = &seen[0];
    assert_eq!(method, "POST");
    assert_eq!(url, "https://board.example.com/api/client/tasks/create");
    assert_eq!(header(sent, "authorization"), Some("Bearer abc_token"));
    assert_eq!(header(sent, "cookie"), None);
    assert_eq!(header(sent, "host"), None);
    assert_ne!(header(sent, "x-board-sig"), Some("forged"));
    assert_ne!(header(sent, "x-board-key"), Some("forged"));
    assert_eq!(
        sent.iter()
            .filter(|(name, _)| name == "x-board-sig")
            .count(),
        1
    );
    assert_eq!(header(sent, "x-board-contract"), Some("1"));
    assert_eq!(header(sent, "x-board-client"), Some("web/1.0.0"));
    assert_eq!(header(sent, "content-type"), Some("application/json"));
}

#[tokio::test]
async fn fetch_refuses_bad_paths_credential_routes_and_unknown_servers() {
    let (bridge, http, ..) = setup(true);
    let id = add(&bridge);
    for path in [
        "/api/pair",
        "/api/auth/handoff/finish",
        "/api/../x",
        "/index.html",
    ] {
        assert!(
            bridge
                .server_fetch(&id, "GET", path, &[], None)
                .await
                .is_err(),
            "{path}"
        );
    }
    assert!(matches!(
        bridge
            .server_fetch("nope", "GET", "/healthz", &[], None)
            .await,
        Err(BridgeError::UnknownServer)
    ));
    assert!(
        bridge
            .server_fetch(&id, "TRACE", "/healthz", &[], None)
            .await
            .is_err()
    );
    assert!(http.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pairing_binds_the_key_and_later_requests_are_signed() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    http.answer("/api/pair", 200, r#"{"keyId":"x"}"#);
    bridge.pair(&id, "ABCD-1234", "Pixel").await.unwrap();
    {
        let seen = http.seen.lock().unwrap();
        let body: serde_json::Value = serde_json::from_slice(seen[0].3.as_ref().unwrap()).unwrap();
        assert_eq!(body["code"], "ABCD-1234");
        assert_eq!(body["label"], "Pixel");
        assert_eq!(body["publicKey"], keys.public());
    }
    bridge
        .server_fetch(
            &id,
            "POST",
            "/api/client/tasks/create?a=1",
            &[],
            Some("{\"t\":1}"),
        )
        .await
        .unwrap();
    let seen = http.seen.lock().unwrap();
    let sent = &seen[1].2;
    assert_eq!(
        header(sent, "x-board-key"),
        Some(key_id_of(&keys.public()).unwrap().as_str())
    );
    let digest = header(sent, "content-digest").unwrap();
    let canonical =
        format!("POST\n/api/client/tasks/create?a=1\n1767225600\nAAAAAAAAAAAAAAAAAAAAAA\n{digest}");
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header(sent, "x-board-sig").unwrap())
            .unwrap(),
    )
    .unwrap();
    VerifyingKey::from(&keys.key)
        .verify(canonical.as_bytes(), &signature)
        .unwrap();
}

#[tokio::test]
async fn client_routes_are_signed_before_pairing_so_the_server_can_ask_for_it() {
    let (bridge, http, ..) = setup(true);
    let id = add(&bridge);
    http.answer("/api/pair", 403, "{}");
    assert_eq!(
        bridge.pair(&id, "ABCD-1234", "Pixel").await,
        Err(BridgeError::Rejected(403))
    );
    bridge
        .server_fetch(&id, "GET", "/api/client/me", &[], None)
        .await
        .unwrap();
    bridge
        .server_fetch(&id, "GET", "/healthz", &[], None)
        .await
        .unwrap();
    bridge
        .server_fetch(&id, "GET", "/api/version", &[], None)
        .await
        .unwrap();
    let seen = http.seen.lock().unwrap();
    assert!(header(&seen[1].2, "x-board-sig").is_some());
    assert_eq!(header(&seen[2].2, "x-board-sig"), None);
    assert_eq!(header(&seen[3].2, "x-board-sig"), None);
}

#[tokio::test]
async fn handoff_finish_stores_the_token_and_sends_the_key_only_when_signatures_are_required() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    http.answer(
        "/api/version",
        200,
        r#"{"modules":{"requestSignature":true}}"#,
    );
    http.answer(
        "/api/auth/handoff/finish",
        200,
        r#"{"status":"signed-in","token":"abc_new"}"#,
    );
    bridge
        .handoff_finish(&id, "flow-1", &"v".repeat(43))
        .await
        .unwrap();
    assert_eq!(keys.token(&id).as_deref(), Some("abc_new"));
    {
        let seen = http.seen.lock().unwrap();
        let body: serde_json::Value = serde_json::from_slice(seen[1].3.as_ref().unwrap()).unwrap();
        assert_eq!(body["tokenKind"], "client");
        assert_eq!(body["publicKey"], keys.public());
    }

    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    http.answer(
        "/api/version",
        200,
        r#"{"modules":{"requestSignature":false}}"#,
    );
    http.answer(
        "/api/auth/handoff/finish",
        200,
        r#"{"status":"signed-in","token":"abc_new"}"#,
    );
    bridge
        .handoff_finish(&id, "flow-1", &"v".repeat(43))
        .await
        .unwrap();
    let seen = http.seen.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(seen[1].3.as_ref().unwrap()).unwrap();
    assert!(body.get("publicKey").is_none());
    assert_eq!(keys.token(&id).as_deref(), Some("abc_new"));
}

#[tokio::test]
async fn a_pending_handoff_stores_nothing() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    http.answer(
        "/api/version",
        200,
        r#"{"modules":{"requestSignature":false}}"#,
    );
    http.answer("/api/auth/handoff/finish", 200, r#"{"status":"pending"}"#);
    assert_eq!(
        bridge.handoff_finish(&id, "f", &"v".repeat(43)).await,
        Err(BridgeError::Pending)
    );
    assert_eq!(keys.token(&id), None);
}

#[tokio::test]
async fn sign_out_logs_out_then_forgets_the_token() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    keys.set_token(&id, "abc_t").unwrap();
    bridge.sign_out(&id).await.unwrap();
    assert_eq!(keys.token(&id), None);
    let seen = http.seen.lock().unwrap();
    assert!(seen[0].1.ends_with("/api/auth/logout"));
    assert_eq!(header(&seen[0].2, "authorization"), Some("Bearer abc_t"));
}

#[tokio::test]
async fn removing_a_server_needs_confirmation_and_deletes_its_credentials() {
    let (bridge, _, keys, _) = setup(true);
    let id = add(&bridge);
    keys.set_token(&id, "abc_t").unwrap();
    assert_eq!(bridge.remove_server(&id), Ok(true));
    assert_eq!(keys.token(&id), None);
    assert_eq!(
        keys.deleted_keys.lock().unwrap().as_slice(),
        std::slice::from_ref(&id)
    );
    assert!(bridge.list_servers().is_empty());

    let (_, _, keys, store) = setup(false);
    store
        .save(r#"{"servers":[{"id":"s1","name":"a","url":"https://a.example.com/"}]}"#)
        .unwrap();
    let bridge = Bridge::new(
        FakeHttp::new(),
        keys.clone(),
        Answer(false),
        FixedEnv(Mutex::new(0)),
        store,
        BridgeConfig {
            contract: 1,
            client_version: "1.0.0".into(),
        },
    );
    keys.set_token("s1", "abc_t").unwrap();
    assert_eq!(bridge.remove_server("s1"), Ok(false));
    assert_eq!(keys.token("s1").as_deref(), Some("abc_t"));
    assert_eq!(bridge.list_servers().len(), 1);
}

#[tokio::test]
async fn attention_is_read_with_the_native_credential_and_signed() {
    let (bridge, http, keys, _) = setup(true);
    let id = add(&bridge);
    keys.set_token(&id, "abc_t").unwrap();
    http.answer(
        "/api/client/attention",
        200,
        r#"{"tasks":[{"id":"t1","projectId":"p","since":"2026-01-01T00:00:00Z"}]}"#,
    );
    assert_eq!(bridge.attention(&id).await, Ok(vec!["t1".to_string()]));
    let seen = http.seen.lock().unwrap();
    assert_eq!(header(&seen[0].2, "authorization"), Some("Bearer abc_t"));
    assert!(header(&seen[0].2, "x-board-sig").is_some());
    assert!(seen[0].1.ends_with("/api/client/attention"));
}

#[tokio::test]
async fn a_rejected_attention_poll_is_an_error_and_notification_settings_persist() {
    let (bridge, http, ..) = setup(true);
    let id = add(&bridge);
    http.answer("/api/client/attention", 401, "{}");
    assert_eq!(bridge.attention(&id).await, Err(BridgeError::Rejected(401)));
    assert!(bridge.notifying_servers().is_empty());
    bridge.set_notifications(&id, true).unwrap();
    assert_eq!(bridge.notifying_servers().len(), 1);
    assert_eq!(
        bridge.set_notifications("nope", true),
        Err(BridgeError::UnknownServer)
    );
    bridge.set_notifications(&id, false).unwrap();
    assert!(bridge.notifying_servers().is_empty());
}
