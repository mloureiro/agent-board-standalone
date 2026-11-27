#![allow(dead_code)]

use serde_json::Value;
use std::path::PathBuf;

fn repo_file(relative: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    std::fs::read_to_string(root.join(relative)).unwrap_or_else(|_| {
        panic!("{relative} is missing: run `pnpm --filter @rumo/contract run build`")
    })
}

pub fn repo_json(relative: &str) -> Value {
    serde_json::from_str(&repo_file(relative)).unwrap()
}

use futures_util::{StreamExt, stream};
use rumo_client_core::bridge::{Bridge, Scope};
use rumo_client_core::handshake::ClientInfo;
use rumo_client_core::headers::Header;
use rumo_client_core::ids::ServerId;
use rumo_client_core::ports::{
    Clock, Confirm, FileStore, Http, HttpRequest, HttpResponse, Limits, PortError, SecretStore,
};
use rumo_client_core::servers::{ServerEntry, Servers};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

pub const FIRST_ID: &str = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
pub const SECOND_ID: &str = "0b9e4c1a-7d2f-4a55-9c3e-5f1d8a7b6c42";

pub fn id(text: &str) -> ServerId {
    ServerId::parse(text).unwrap()
}

#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub headers: Vec<Header>,
    pub chunks: Vec<Vec<u8>>,
}

impl Canned {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            chunks: vec![body.as_bytes().to_vec()],
        }
    }

    pub fn version(request_signature: bool) -> Self {
        Self::json(
            200,
            &format!(r#"{{"contract":1,"modules":{{"requestSignature":{request_signature}}}}}"#),
        )
    }
}

#[derive(Clone, Debug)]
pub struct Sent {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Vec<u8>,
    pub limits: Option<Limits>,
}

impl Sent {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

type Hook = Box<dyn Fn() + Send + Sync>;

#[derive(Clone, Default)]
pub struct FakeHttp {
    answers: Arc<Mutex<VecDeque<Result<Canned, String>>>>,
    sent: Arc<Mutex<Vec<Sent>>>,
    before_answer: Arc<Mutex<Option<Arc<Hook>>>>,
}

impl FakeHttp {
    pub fn answering(answers: impl IntoIterator<Item = Result<Canned, String>>) -> Self {
        let fake = Self::default();
        fake.answers.lock().unwrap().extend(answers);
        fake
    }

    pub fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    pub fn on_send(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.before_answer.lock().unwrap() = Some(Arc::new(Box::new(hook)));
    }
}

impl Http for FakeHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, PortError> {
        self.sent.lock().unwrap().push(Sent {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            limits: request.limits,
        });
        let hook = self.before_answer.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook();
        }
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("no canned answer left");
        let canned = answer.map_err(PortError)?;
        Ok(HttpResponse {
            status: canned.status,
            headers: canned.headers,
            body: stream::iter(canned.chunks.into_iter().map(Ok)).boxed(),
        })
    }
}

#[derive(Default)]
pub struct MemorySecrets {
    items: Mutex<BTreeMap<(String, String), Vec<u8>>>,
}

impl MemorySecrets {
    pub fn put(&self, service: &str, account: &str, secret: &[u8]) {
        self.items
            .lock()
            .unwrap()
            .insert((service.to_owned(), account.to_owned()), secret.to_vec());
    }

    pub fn services(&self) -> Vec<String> {
        let mut found: Vec<String> = self
            .items
            .lock()
            .unwrap()
            .keys()
            .map(|(service, _)| service.clone())
            .collect();
        found.dedup();
        found.sort();
        found
    }

    pub fn peek(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        self.items
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, PortError> {
        Ok(self.peek(service, account))
    }

    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), PortError> {
        self.put(service, account, secret);
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), PortError> {
        self.items
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }

    fn accounts(&self, service: &str) -> Result<Vec<String>, PortError> {
        Ok(self
            .items
            .lock()
            .unwrap()
            .keys()
            .filter(|(stored, _)| stored == service)
            .map(|(_, account)| account.clone())
            .collect())
    }
}

#[derive(Clone, Default)]
pub struct MemoryFiles {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl FileStore for MemoryFiles {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, PortError> {
        Ok(self.files.lock().unwrap().get(name).cloned())
    }

    fn write(&self, name: &str, contents: &[u8]) -> Result<(), PortError> {
        self.files
            .lock()
            .unwrap()
            .insert(name.to_owned(), contents.to_vec());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), PortError> {
        self.files.lock().unwrap().remove(name);
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, PortError> {
        Ok(self.files.lock().unwrap().keys().cloned().collect())
    }
}

#[derive(Clone)]
pub struct FakeConfirm {
    answer: bool,
    asked: Arc<Mutex<Vec<String>>>,
}

impl FakeConfirm {
    pub fn answering(answer: bool) -> Self {
        Self {
            answer,
            asked: Arc::default(),
        }
    }

    pub fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

impl Confirm for FakeConfirm {
    fn confirm(&self, message: &str) -> bool {
        self.asked.lock().unwrap().push(message.to_owned());
        self.answer
    }
}

pub struct FakeClock;

impl Clock for FakeClock {
    fn now_secs(&self) -> u64 {
        1_700_000_000
    }

    fn nonce(&self) -> String {
        "bm9uY2Utbm9uY2Utbm9uY2U".to_owned()
    }

    fn new_server_id(&self) -> ServerId {
        ServerId::parse(SECOND_ID).unwrap()
    }
}

pub fn client_info() -> ClientInfo {
    ClientInfo {
        contract: 1,
        version: "1.2.3".to_owned(),
    }
}

pub fn entry(text: &str, name: &str, url: &str) -> ServerEntry {
    ServerEntry {
        id: id(text),
        name: name.to_owned(),
        url: url.to_owned(),
    }
}

pub fn servers_file(entries: &[(&str, &str, &str)]) -> MemoryFiles {
    let files = MemoryFiles::default();
    let list: Vec<_> = entries
        .iter()
        .map(|(id, name, url)| serde_json::json!({"id": id, "name": name, "url": url}))
        .collect();
    files
        .write(
            "servers.json",
            serde_json::json!({"servers": list}).to_string().as_bytes(),
        )
        .unwrap();
    files
}

pub type TestBridge = Bridge<FakeHttp, MemorySecrets, FakeConfirm, FakeClock, MemoryFiles>;

pub struct Harness {
    pub bridge: TestBridge,
    pub http: FakeHttp,
    pub secrets: Arc<MemorySecrets>,
    pub confirm: FakeConfirm,
    pub files: MemoryFiles,
}

pub fn harness(
    answers: impl IntoIterator<Item = Result<Canned, String>>,
    files: MemoryFiles,
    confirm: bool,
) -> Harness {
    let http = FakeHttp::answering(answers);
    let secrets = Arc::new(MemorySecrets::default());
    let confirm = FakeConfirm::answering(confirm);
    let bridge = Bridge::new(
        http.clone(),
        Arc::clone(&secrets),
        confirm.clone(),
        FakeClock,
        Servers::open(files.clone()),
        client_info(),
    );
    Harness {
        bridge,
        http,
        secrets,
        confirm,
        files,
    }
}

pub fn scope_of(text: &str) -> Scope {
    Scope::Server(id(text))
}

pub fn token() -> String {
    format!("abc_{}", "A".repeat(43))
}

pub fn other_token() -> String {
    format!("abc_{}", "B".repeat(43))
}
