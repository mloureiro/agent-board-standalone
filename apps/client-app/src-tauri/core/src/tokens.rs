use crate::BUNDLE_ID;
use crate::ids::ServerId;
use crate::ports::{PortError, SecretStore};
use std::sync::Arc;

const TOKEN_PREFIX: &str = "abc_";
const TOKEN_BODY_LENGTH: usize = 43;

pub fn token_service() -> String {
    format!("{BUNDLE_ID}.client-token")
}

pub fn key_service() -> String {
    format!("{BUNDLE_ID}.signing-key")
}

pub fn is_token(text: &str) -> bool {
    text.strip_prefix(TOKEN_PREFIX).is_some_and(|body| {
        body.len() == TOKEN_BODY_LENGTH
            && body
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

async fn off_thread<S, T>(
    secrets: &Arc<S>,
    job: impl FnOnce(&S) -> Result<T, PortError> + Send + 'static,
) -> Result<T, PortError>
where
    S: SecretStore + 'static,
    T: Send + 'static,
{
    let secrets = Arc::clone(secrets);
    tokio::task::spawn_blocking(move || job(&secrets))
        .await
        .unwrap_or_else(|_| Err(PortError("secret store task failed".to_owned())))
}

pub async fn read_secret<S: SecretStore + 'static>(
    secrets: &Arc<S>,
    service: String,
    server: ServerId,
) -> Result<Option<Vec<u8>>, PortError> {
    off_thread(secrets, move |store| {
        store.get(&service, &server.to_string())
    })
    .await
}

pub async fn write_secret<S: SecretStore + 'static>(
    secrets: &Arc<S>,
    service: String,
    server: ServerId,
    secret: Vec<u8>,
) -> Result<(), PortError> {
    off_thread(secrets, move |store| {
        store.set(&service, &server.to_string(), &secret)
    })
    .await
}

pub async fn delete_secret<S: SecretStore + 'static>(
    secrets: &Arc<S>,
    service: String,
    server: ServerId,
) -> Result<(), PortError> {
    off_thread(secrets, move |store| {
        store.delete(&service, &server.to_string())
    })
    .await
}

pub async fn read_token<S: SecretStore + 'static>(
    secrets: &Arc<S>,
    server: ServerId,
) -> Option<String> {
    let stored = read_secret(secrets, token_service(), server)
        .await
        .ok()
        .flatten()?;
    match String::from_utf8(stored) {
        Ok(token) if is_token(&token) => Some(token),
        _ => {
            let _ = delete_secret(secrets, token_service(), server).await;
            None
        }
    }
}
