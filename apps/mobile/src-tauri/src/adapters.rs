use agent_board_bridge_core::ports::{
    Confirm, Env, Http, HttpRequest, HttpResponse, KeyStore, Store,
};
use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_board_native::BoardNativeExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub struct ReqwestHttp(reqwest::Client);

impl ReqwestHttp {
    pub fn new() -> Result<Self, String> {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self(client))
    }
}

impl Http for ReqwestHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut builder = self.0.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let body = response
            .bytes_stream()
            .map(|chunk| {
                chunk
                    .map(|bytes| bytes.to_vec())
                    .map_err(|error| error.to_string())
            })
            .boxed();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

pub struct PluginKeys<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> KeyStore for PluginKeys<R> {
    fn token(&self, server_id: &str) -> Option<String> {
        self.0.board_native().token_get(server_id).ok().flatten()
    }

    fn set_token(&self, server_id: &str, token: &str) -> Result<(), String> {
        self.0
            .board_native()
            .token_set(server_id, token)
            .map_err(|error| error.to_string())
    }

    fn delete_token(&self, server_id: &str) -> Result<(), String> {
        self.0
            .board_native()
            .token_delete(server_id)
            .map_err(|error| error.to_string())
    }

    fn public_key(&self, server_id: &str) -> Result<String, String> {
        self.0
            .board_native()
            .public_key(server_id)
            .map_err(|error| error.to_string())
    }

    fn sign(&self, server_id: &str, message: &[u8]) -> Result<String, String> {
        self.0
            .board_native()
            .sign(server_id, &STANDARD.encode(message))
            .map_err(|error| error.to_string())
    }

    fn delete_key(&self, server_id: &str) -> Result<(), String> {
        self.0
            .board_native()
            .delete_key(server_id)
            .map_err(|error| error.to_string())
    }
}

pub struct DialogConfirm<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> DialogConfirm<R> {
    fn ask(&self, title: &str, message: String, accept: &str) -> bool {
        self.0
            .dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                accept.to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show()
    }
}

impl<R: Runtime> Confirm for DialogConfirm<R> {
    fn add_server(&self, name: &str, address: &str) -> bool {
        self.ask("Add server", format!("Add \"{name}\" at {address}?"), "Add")
    }

    fn remove_server(&self, name: &str) -> bool {
        self.ask(
            "Remove server",
            format!("Remove \"{name}\" and forget its sign-in on this phone?"),
            "Remove",
        )
    }
}

pub struct SystemEnv;

impl Env for SystemEnv {
    fn now_secs(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0)
    }

    fn nonce(&self) -> String {
        URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes())
    }

    fn new_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

pub struct FileStore(pub PathBuf);

impl Store for FileStore {
    fn load(&self) -> Option<String> {
        std::fs::read_to_string(&self.0).ok()
    }

    fn save(&self, text: &str) -> Result<(), String> {
        if let Some(parent) = self.0.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temp = self.0.with_extension("tmp");
        std::fs::write(&temp, text).map_err(|error| error.to_string())?;
        std::fs::rename(&temp, &self.0).map_err(|error| error.to_string())
    }
}
