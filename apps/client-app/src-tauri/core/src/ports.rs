use crate::headers::Header;
use crate::ids::ServerId;
use futures_util::Stream;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub struct PortError(pub String);

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, PortError>> + Send>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub connect: Duration,
    pub total: Duration,
}

pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Vec<u8>,
    pub limits: Option<Limits>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<Header>,
    pub body: ByteStream,
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
