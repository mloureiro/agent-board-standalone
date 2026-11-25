use crate::headers::Header;
use crate::ids::ServerId;
use std::future::Future;

#[derive(Debug, PartialEq, Eq)]
pub struct PortError(pub String);

pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Vec<u8>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<Header>,
    pub body: Vec<u8>,
}

pub trait Http: Send + Sync {
    fn send(
        &self,
        request: HttpRequest,
    ) -> impl Future<Output = Result<HttpResponse, PortError>> + Send;
}

pub trait SecretStore: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, PortError>;
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), PortError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), PortError>;
    fn accounts(&self, service: &str) -> Result<Vec<String>, PortError>;
}

pub trait Confirm: Send + Sync {
    fn confirm(&self, message: &str) -> bool;
}

pub trait Clock: Send + Sync {
    fn now_secs(&self) -> u64;
    fn nonce(&self) -> String;
    fn new_server_id(&self) -> ServerId;
}

pub trait FileStore: Send + Sync {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, PortError>;
    fn write(&self, name: &str, contents: &[u8]) -> Result<(), PortError>;
    fn delete(&self, name: &str) -> Result<(), PortError>;
    fn list(&self) -> Result<Vec<String>, PortError>;
}
