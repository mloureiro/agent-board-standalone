use futures_core::Stream;
use std::pin::Pin;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ByteStream,
}

pub trait Http: Send + Sync {
    fn send(
        &self,
        request: HttpRequest,
    ) -> impl std::future::Future<Output = Result<HttpResponse, String>> + Send;
}

pub trait KeyStore: Send + Sync {
    fn token(&self, server_id: &str) -> Option<String>;
    fn set_token(&self, server_id: &str, token: &str) -> Result<(), String>;
    fn delete_token(&self, server_id: &str) -> Result<(), String>;
    fn public_key(&self, server_id: &str) -> Result<String, String>;
    fn sign(&self, server_id: &str, message: &[u8]) -> Result<String, String>;
    fn delete_key(&self, server_id: &str) -> Result<(), String>;
}

pub trait Confirm: Send + Sync {
    fn add_server(&self, name: &str, address: &str) -> bool;
    fn remove_server(&self, name: &str) -> bool;
}

pub trait Env: Send + Sync {
    fn now_secs(&self) -> u64;
    fn nonce(&self) -> String;
    fn new_id(&self) -> String;
}

pub trait Store: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, text: &str) -> Result<(), String>;
}
