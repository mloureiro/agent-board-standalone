use crate::address::AddressProblem;
use crate::attention::parse_attention;
use crate::links::external_link;
use crate::paths::{PathRefusal, normalise_path};
use crate::ports::{Confirm, Env, Http, HttpRequest, HttpResponse, KeyStore, Store};
use crate::servers::{ServerEntry, ServerList};
use crate::sign::signing_headers;
use serde::Deserialize;
use std::sync::Mutex;

pub const CONTRACT_LEVEL: u32 = 1;

const FORWARDED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "cache-control",
    "content-type",
    "if-none-match",
    "last-event-id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    UnknownServer,
    Address(AddressProblem),
    Path(PathRefusal),
    Link,
    Pending,
    Transport(String),
    Rejected(u16),
    Native(String),
}

impl BridgeError {
    pub fn message(&self) -> String {
        match self {
            Self::UnknownServer => "unknown-server".into(),
            Self::Address(problem) => format!("address-{}", problem.code()),
            Self::Path(PathRefusal::CredentialRoute) => "refused-credential-route".into(),
            Self::Path(_) => "refused-path".into(),
            Self::Link => "refused-link".into(),
            Self::Pending => "pending".into(),
            Self::Transport(text) => format!("transport: {text}"),
            Self::Rejected(status) => format!("rejected-{status}"),
            Self::Native(text) => text.clone(),
        }
    }
}

pub struct BridgeConfig {
    pub contract: u32,
    pub client_version: String,
}

pub struct Bridge<H, K, C, E, S> {
    http: H,
    keys: K,
    confirm: C,
    env: E,
    store: S,
    config: BridgeConfig,
    list: Mutex<ServerList>,
}

#[derive(Deserialize)]
struct VersionDocument {
    modules: VersionModules,
}

#[derive(Deserialize)]
struct VersionModules {
    #[serde(rename = "requestSignature")]
    request_signature: bool,
}

#[derive(Deserialize)]
struct Finished {
    status: String,
    token: Option<String>,
}

impl<H: Http, K: KeyStore, C: Confirm, E: Env, S: Store> Bridge<H, K, C, E, S> {
    pub fn new(http: H, keys: K, confirm: C, env: E, store: S, config: BridgeConfig) -> Self {
        let list = store
            .load()
            .map(|text| ServerList::parse(&text))
            .unwrap_or_default();
        Self {
            http,
            keys,
            confirm,
            env,
            store,
            config,
            list: Mutex::new(list),
        }
    }

    fn entry(&self, server_id: &str) -> Result<ServerEntry, BridgeError> {
        self.list
            .lock()
            .unwrap()
            .get(server_id)
            .cloned()
            .ok_or(BridgeError::UnknownServer)
    }

    fn persist(&self, list: &ServerList) -> Result<(), BridgeError> {
        self.store
            .save(&list.to_json())
            .map_err(BridgeError::Native)
    }

    fn base_headers(&self) -> Vec<(String, String)> {
        vec![
            ("x-board-contract".into(), self.config.contract.to_string()),
            (
                "x-board-client".into(),
                format!("web/{}", self.config.client_version),
            ),
        ]
    }

    fn url_for(entry: &ServerEntry, path: &str) -> String {
        format!("{}{}", entry.url.trim_end_matches('/'), path)
    }

    pub fn list_servers(&self) -> Vec<ServerEntry> {
        self.list.lock().unwrap().servers.clone()
    }

    pub fn add_server(
        &self,
        name: &str,
        address: &str,
    ) -> Result<Option<ServerEntry>, BridgeError> {
        crate::address::check_address(address).map_err(BridgeError::Address)?;
        if !self.confirm.add_server(name, address) {
            return Ok(None);
        }
        let mut list = self.list.lock().unwrap();
        let entry = list
            .add(self.env.new_id(), name, address)
            .map_err(BridgeError::Address)?;
        self.persist(&list)?;
        Ok(Some(entry))
    }

    pub fn rename_server(&self, server_id: &str, name: &str) -> Result<(), BridgeError> {
        let mut list = self.list.lock().unwrap();
        if !list.rename(server_id, name) {
            return Err(BridgeError::UnknownServer);
        }
        self.persist(&list)
    }

    pub fn remove_server(&self, server_id: &str) -> Result<bool, BridgeError> {
        let entry = self.entry(server_id)?;
        if !self.confirm.remove_server(&entry.name) {
            return Ok(false);
        }
        let mut list = self.list.lock().unwrap();
        list.remove(server_id);
        self.persist(&list)?;
        let _ = self.keys.delete_token(server_id);
        let _ = self.keys.delete_key(server_id);
        Ok(true)
    }

    pub fn set_notifications(&self, server_id: &str, enabled: bool) -> Result<(), BridgeError> {
        let mut list = self.list.lock().unwrap();
        if !list.set_notifications(server_id, enabled) {
            return Err(BridgeError::UnknownServer);
        }
        self.persist(&list)
    }

    pub fn notifying_servers(&self) -> Vec<ServerEntry> {
        let list = self.list.lock().unwrap();
        list.servers
            .iter()
            .filter(|entry| entry.notifications)
            .cloned()
            .collect()
    }

    pub async fn attention(&self, server_id: &str) -> Result<Vec<String>, BridgeError> {
        let response = self
            .server_fetch(server_id, "GET", "/api/client/attention", &[], None)
            .await?;
        let status = response.status;
        let body = collect(response).await?;
        if status >= 400 {
            return Err(BridgeError::Rejected(status));
        }
        parse_attention(&body).map_err(BridgeError::Native)
    }

    pub fn open_link(&self, url: &str) -> Result<String, BridgeError> {
        external_link(url).ok_or(BridgeError::Link)
    }

    pub async fn server_fetch(
        &self,
        server_id: &str,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: Option<&str>,
    ) -> Result<HttpResponse, BridgeError> {
        let entry = self.entry(server_id)?;
        let path = normalise_path(path).map_err(BridgeError::Path)?;
        let method = method.to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
            return Err(BridgeError::Path(PathRefusal::Malformed));
        }
        let body_bytes = body.map(|text| text.as_bytes().to_vec());
        let mut out: Vec<(String, String)> = headers
            .iter()
            .filter(|(name, _)| FORWARDED_HEADERS.contains(&name.to_ascii_lowercase().as_str()))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
            .collect();
        out.extend(self.base_headers());
        if let Some(token) = self.keys.token(server_id) {
            out.push(("authorization".into(), format!("Bearer {token}")));
        }
        if signs(&path) {
            out.extend(
                signing_headers(
                    &self.keys,
                    &self.env,
                    server_id,
                    &method,
                    &path,
                    body_bytes.as_deref(),
                )
                .map_err(BridgeError::Native)?,
            );
        }
        self.http
            .send(HttpRequest {
                method,
                url: Self::url_for(&entry, &path),
                headers: out,
                body: body_bytes,
            })
            .await
            .map_err(BridgeError::Transport)
    }

    async fn post_json(
        &self,
        entry: &ServerEntry,
        path: &str,
        payload: serde_json::Value,
        authorised: Option<&str>,
    ) -> Result<(u16, Vec<u8>), BridgeError> {
        let mut headers = self.base_headers();
        headers.push(("content-type".into(), "application/json".into()));
        if let Some(token) = authorised {
            headers.push(("authorization".into(), format!("Bearer {token}")));
        }
        let response = self
            .http
            .send(HttpRequest {
                method: "POST".into(),
                url: Self::url_for(entry, path),
                headers,
                body: Some(payload.to_string().into_bytes()),
            })
            .await
            .map_err(BridgeError::Transport)?;
        Ok((response.status, collect(response).await?))
    }

    async fn requires_signature(&self, entry: &ServerEntry) -> Result<bool, BridgeError> {
        let response = self
            .http
            .send(HttpRequest {
                method: "GET".into(),
                url: Self::url_for(entry, "/api/version"),
                headers: self.base_headers(),
                body: None,
            })
            .await
            .map_err(BridgeError::Transport)?;
        let status = response.status;
        let bytes = collect(response).await?;
        if status >= 400 {
            return Err(BridgeError::Rejected(status));
        }
        Ok(serde_json::from_slice::<VersionDocument>(&bytes)
            .map(|doc| doc.modules.request_signature)
            .unwrap_or(false))
    }

    pub async fn handoff_finish(
        &self,
        server_id: &str,
        flow: &str,
        verifier: &str,
    ) -> Result<(), BridgeError> {
        let entry = self.entry(server_id)?;
        let signed = self.requires_signature(&entry).await?;
        let mut payload =
            serde_json::json!({ "flow": flow, "verifier": verifier, "tokenKind": "client" });
        if signed {
            let key = self
                .keys
                .public_key(server_id)
                .map_err(BridgeError::Native)?;
            payload["publicKey"] = serde_json::Value::String(key);
        }
        let (status, body) = self
            .post_json(&entry, "/api/auth/handoff/finish", payload, None)
            .await?;
        if status >= 400 {
            return Err(BridgeError::Rejected(status));
        }
        let finished: Finished = serde_json::from_slice(&body)
            .map_err(|_| BridgeError::Native("invalid-answer".into()))?;
        match (finished.status.as_str(), finished.token) {
            ("signed-in", Some(token)) => {
                self.keys
                    .set_token(server_id, &token)
                    .map_err(BridgeError::Native)?;
                Ok(())
            }
            ("pending", _) => Err(BridgeError::Pending),
            _ => Err(BridgeError::Native("invalid-answer".into())),
        }
    }

    pub async fn pair(&self, server_id: &str, code: &str, label: &str) -> Result<(), BridgeError> {
        let entry = self.entry(server_id)?;
        let key = self
            .keys
            .public_key(server_id)
            .map_err(BridgeError::Native)?;
        let payload = serde_json::json!({ "code": code, "publicKey": key, "label": label });
        let (status, _) = self.post_json(&entry, "/api/pair", payload, None).await?;
        if status >= 400 {
            return Err(BridgeError::Rejected(status));
        }
        Ok(())
    }

    pub async fn sign_out(&self, server_id: &str) -> Result<(), BridgeError> {
        let entry = self.entry(server_id)?;
        if let Some(token) = self.keys.token(server_id) {
            let _ = self
                .post_json(
                    &entry,
                    "/api/auth/logout",
                    serde_json::json!({}),
                    Some(&token),
                )
                .await;
        }
        self.keys
            .delete_token(server_id)
            .map_err(BridgeError::Native)
    }
}

fn signs(path: &str) -> bool {
    path.starts_with("/api/client/") || path.starts_with("/api/auth/logout")
}

async fn collect(response: HttpResponse) -> Result<Vec<u8>, BridgeError> {
    use futures_util::StreamExt;
    let mut stream = response.body;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk.map_err(BridgeError::Transport)?);
    }
    Ok(bytes)
}
