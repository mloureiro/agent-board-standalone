use crate::address::AddressProblem;
use crate::handshake::{ClientInfo, Handshake};
use crate::headers::{Header, page_headers, with_client_headers};
use crate::ids::ServerId;
use crate::opening::{WindowAction, window_error};
use crate::paths::{self, Refusal};
use crate::ports::{
    ByteStream, Clock, Confirm, FileStore, Http, HttpRequest, HttpResponse, PortError, SecretStore,
};
use crate::removal::{Effect, Removal};
use crate::servers::{ServerEntry, ServerError, Servers};
use crate::signing::{RequestSigner, canonical_string, content_digest};
use crate::tokens::{
    delete_secret, key_service, read_secret, read_token, token_service, write_secret,
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const UNAUTHORIZED_BODY_CAP: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Server(ServerId),
    AllServers(Vec<ServerId>),
    None,
}

const ALL_SERVERS_LABEL: &str = "all-servers";
const TAB_PREFIX: &str = "tab-";

impl Scope {
    pub fn from_label(label: &str, open_windows: &[ServerId]) -> Self {
        if label == ALL_SERVERS_LABEL {
            return Self::AllServers(open_windows.to_vec());
        }
        let server = label
            .strip_prefix(TAB_PREFIX)
            .and_then(|rest| rest.rsplit_once('-'))
            .filter(|(_, number)| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|(id, _)| ServerId::parse(id).ok());
        match server {
            Some(id) => Self::Server(id),
            None => Self::None,
        }
    }

    pub fn allows(&self, id: ServerId) -> bool {
        match self {
            Self::Server(own) => *own == id,
            Self::AllServers(open) => open.contains(&id),
            Self::None => false,
        }
    }

    pub fn resolve(&self, id: &str) -> Result<ServerId, BridgeError> {
        ServerId::parse(id)
            .ok()
            .filter(|parsed| self.allows(*parsed))
            .ok_or(BridgeError::UnknownServer)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum BridgeError {
    UnknownServer,
    Path(Refusal),
    Method,
    Address(AddressProblem),
    BlankName,
    Transport(String),
    Native(String),
}

impl BridgeError {
    pub fn message(&self) -> String {
        match self {
            Self::UnknownServer => "unknown server".to_owned(),
            Self::Path(Refusal::CredentialRoute) => "refused: credential route".to_owned(),
            Self::Path(refusal) => format!("refused path: {}", refusal.reason()),
            Self::Method => "refused method".to_owned(),
            Self::Address(problem) => format!("address {}", problem.code()),
            Self::BlankName => "the name is blank".to_owned(),
            Self::Transport(detail) => format!("request failed: {detail}"),
            Self::Native(detail) => detail.clone(),
        }
    }
}

impl From<ServerError> for BridgeError {
    fn from(error: ServerError) -> Self {
        match error {
            ServerError::Address(problem) => Self::Address(problem),
            ServerError::BlankName => Self::BlankName,
            ServerError::Unknown => Self::UnknownServer,
            ServerError::Write(PortError(detail)) => Self::Native(detail),
        }
    }
}

pub struct ServerResponse {
    pub status: u16,
    pub headers: Vec<Header>,
    pub body: ByteStream,
}

#[derive(Debug)]
pub struct RenameReport {
    pub entry: ServerEntry,
    pub retitle_warning: Option<String>,
}

#[derive(Deserialize)]
struct ErrorDocument {
    error: ErrorCode,
}

#[derive(Deserialize)]
struct ErrorCode {
    code: String,
}

fn url_for(entry: &ServerEntry, path: &str) -> String {
    format!("{}{path}", entry.url.trim_end_matches('/'))
}

pub struct Bridge<H, S, C, K, F> {
    http: H,
    secrets: Arc<S>,
    confirm: C,
    clock: K,
    servers: Servers<F>,
    client: ClientInfo,
    signing: Mutex<HashMap<ServerId, bool>>,
    expired: Mutex<HashSet<ServerId>>,
}

impl<H, S, C, K, F> Bridge<H, S, C, K, F>
where
    H: Http,
    S: SecretStore + 'static,
    C: Confirm,
    K: Clock,
    F: FileStore,
{
    pub fn new(
        http: H,
        secrets: Arc<S>,
        confirm: C,
        clock: K,
        servers: Servers<F>,
        client: ClientInfo,
    ) -> Self {
        Self {
            http,
            secrets,
            confirm,
            clock,
            servers,
            client,
            signing: Mutex::new(HashMap::new()),
            expired: Mutex::new(HashSet::new()),
        }
    }

    pub fn servers(&self) -> &Servers<F> {
        &self.servers
    }

    pub fn record_handshake(&self, server: ServerId, outcome: Handshake) {
        self.signing
            .lock()
            .unwrap()
            .insert(server, outcome.request_signature);
    }

    pub fn is_expired(&self, server: ServerId) -> bool {
        self.expired.lock().unwrap().contains(&server)
    }

    pub fn list_servers(&self, scope: &Scope) -> Vec<ServerEntry> {
        self.servers
            .list()
            .into_iter()
            .filter(|entry| scope.allows(entry.id))
            .collect()
    }

    fn entry(&self, scope: &Scope, server_id: &str) -> Result<ServerEntry, BridgeError> {
        let id = scope.resolve(server_id)?;
        self.servers.get(id).ok_or(BridgeError::UnknownServer)
    }

    pub fn page_add_server(
        &self,
        scope: &Scope,
        name: &str,
        address: &str,
    ) -> Result<Option<ServerEntry>, BridgeError> {
        if *scope == Scope::None {
            return Err(BridgeError::UnknownServer);
        }
        let url = crate::address::check_address(address).map_err(BridgeError::Address)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(BridgeError::BlankName);
        }
        if !self
            .confirm
            .confirm(&format!("Add the server \"{name}\" at {url}?"))
        {
            return Ok(None);
        }
        let entry = self
            .servers
            .add(self.clock.new_server_id(), name, address)?;
        Ok(Some(entry))
    }

    pub fn page_remove_server(
        &self,
        scope: &Scope,
        server_id: &str,
    ) -> Result<Option<(Removal, Vec<Effect>)>, BridgeError> {
        let entry = self.entry(scope, server_id)?;
        let question = format!(
            "Remove the server \"{}\"? Its window closes and its stored data is deleted.",
            entry.name
        );
        if !self.confirm.confirm(&question) {
            return Ok(None);
        }
        self.servers.remove(entry.id)?;
        Ok(Some(Removal::start(entry.id, &entry.name)))
    }

    pub fn rename_server(
        &self,
        scope: &Scope,
        server_id: &str,
        name: &str,
        retitle: impl FnOnce(&ServerEntry) -> Result<(), PortError>,
    ) -> Result<RenameReport, BridgeError> {
        let id = scope.resolve(server_id)?;
        let entry = self.servers.rename(id, name)?;
        let retitle_warning = retitle(&entry)
            .err()
            .map(|PortError(detail)| window_error(WindowAction::Rename, &entry.name, &detail));
        Ok(RenameReport {
            entry,
            retitle_warning,
        })
    }

    async fn signer(&self, server: ServerId) -> Result<RequestSigner, BridgeError> {
        let failed = || BridgeError::Native("signing key unavailable".to_owned());
        if let Some(stored) = read_secret(&self.secrets, key_service(), server).await
            && let Ok(signer) = RequestSigner::from_pkcs8_der(&stored)
        {
            return Ok(signer);
        }
        let signer = RequestSigner::generate();
        let der = signer.to_pkcs8_der().map_err(|_| failed())?;
        write_secret(&self.secrets, key_service(), server, der)
            .await
            .map_err(|_| failed())?;
        Ok(signer)
    }

    fn signature_headers(
        &self,
        signer: &RequestSigner,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Result<Vec<Header>, BridgeError> {
        let failed = || BridgeError::Native("request could not be signed".to_owned());
        let timestamp = self.clock.now_secs();
        let nonce = self.clock.nonce();
        let digest = (!body.is_empty()).then(|| content_digest(body));
        let canonical = canonical_string(method, path, timestamp, &nonce, digest.as_deref())
            .map_err(|_| failed())?;
        let mut headers = vec![
            (
                "x-board-key".to_owned(),
                signer.key_id().map_err(|_| failed())?,
            ),
            ("x-board-ts".to_owned(), timestamp.to_string()),
            ("x-board-nonce".to_owned(), nonce),
            ("x-board-sig".to_owned(), signer.sign(&canonical)),
        ];
        if let Some(digest) = digest {
            headers.push(("content-digest".to_owned(), digest));
        }
        Ok(headers)
    }

    pub async fn server_fetch(
        &self,
        scope: &Scope,
        server_id: &str,
        method: &str,
        path: &str,
        headers: &[Header],
        body: Option<&str>,
    ) -> Result<ServerResponse, BridgeError> {
        let entry = self.entry(scope, server_id)?;
        let path = paths::normalise(path).map_err(BridgeError::Path)?;
        let method = method.to_ascii_uppercase();
        if !METHODS.contains(&method.as_str()) {
            return Err(BridgeError::Method);
        }
        let body = body
            .map(|text| text.as_bytes().to_vec())
            .unwrap_or_default();
        let mut outgoing = with_client_headers(
            page_headers(headers),
            &self.client.contract.to_string(),
            &format!("web/{}", self.client.version),
        );
        let sent_token = read_token(&self.secrets, entry.id).await;
        if let Some(token) = &sent_token {
            outgoing.push(("authorization".to_owned(), format!("Bearer {token}")));
        }
        let signs = self
            .signing
            .lock()
            .unwrap()
            .get(&entry.id)
            .copied()
            .unwrap_or(false);
        if signs {
            let signer = self.signer(entry.id).await?;
            outgoing.extend(self.signature_headers(&signer, &method, &path, &body)?);
        }
        let response = self
            .http
            .send(HttpRequest {
                method,
                url: url_for(&entry, &path),
                headers: outgoing,
                body,
                limits: None,
            })
            .await
            .map_err(|PortError(detail)| BridgeError::Transport(detail))?;
        let response = if response.status == 401 {
            self.handle_unauthorized(entry.id, sent_token, response)
                .await
        } else {
            response
        };
        Ok(ServerResponse {
            status: response.status,
            headers: response.headers,
            body: response.body,
        })
    }

    async fn handle_unauthorized(
        &self,
        server: ServerId,
        sent_token: Option<String>,
        response: HttpResponse,
    ) -> HttpResponse {
        let HttpResponse {
            status,
            headers,
            mut body,
        } = response;
        let mut buffered: Vec<Result<Vec<u8>, PortError>> = Vec::new();
        let mut collected: Vec<u8> = Vec::new();
        let mut ended = false;
        while collected.len() <= UNAUTHORIZED_BODY_CAP {
            match body.next().await {
                Some(Ok(chunk)) => {
                    collected.extend_from_slice(&chunk);
                    buffered.push(Ok(chunk));
                }
                Some(Err(error)) => {
                    buffered.push(Err(error));
                    ended = true;
                    break;
                }
                None => {
                    ended = true;
                    break;
                }
            }
        }
        if ended && collected.len() <= UNAUTHORIZED_BODY_CAP {
            let unauthorized = serde_json::from_slice::<ErrorDocument>(&collected)
                .is_ok_and(|document| document.error.code == "unauthorized");
            if unauthorized && let Some(sent) = sent_token {
                self.expire_if_unchanged(server, &sent).await;
            }
        }
        let replay = futures_util::stream::iter(buffered);
        let body = if ended {
            replay.boxed()
        } else {
            replay.chain(body).boxed()
        };
        HttpResponse {
            status,
            headers,
            body,
        }
    }

    async fn expire_if_unchanged(&self, server: ServerId, sent: &str) {
        let current = read_token(&self.secrets, server).await;
        if current.as_deref() == Some(sent)
            && delete_secret(&self.secrets, token_service(), server)
                .await
                .is_ok()
        {
            self.expired.lock().unwrap().insert(server);
        }
    }
}
