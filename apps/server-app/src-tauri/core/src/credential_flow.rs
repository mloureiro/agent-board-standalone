use std::io::Write;

use crate::app::Host;
use crate::credentials::{
    CredentialError, CredentialStore, PENDING_WORKER_DATA_KEY, PENDING_WORKER_TOKEN,
    WORKER_DATA_KEY, WORKER_TOKEN, open_store,
};

pub const TOKEN_VARIABLE: &str = "RUMO_TOKEN";
pub const DATA_KEY_VARIABLE: &str = "RUMO_DATA_KEY";

#[derive(Clone, PartialEq, Eq)]
pub struct Pair {
    pub token: String,
    pub data_key: String,
}

impl std::fmt::Debug for Pair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pair(..)")
    }
}

pub fn accounts(pending: bool) -> (&'static str, &'static str) {
    if pending {
        (PENDING_WORKER_TOKEN, PENDING_WORKER_DATA_KEY)
    } else {
        (WORKER_TOKEN, WORKER_DATA_KEY)
    }
}

pub fn read_pair(
    store: &dyn CredentialStore,
    service: &str,
    pending: bool,
) -> Result<Option<Pair>, CredentialError> {
    let (token_account, key_account) = accounts(pending);
    let token = store.get(service, token_account)?;
    let data_key = store.get(service, key_account)?;
    Ok(match (token, data_key) {
        (Some(token), Some(data_key)) if !token.is_empty() && !data_key.is_empty() => {
            Some(Pair { token, data_key })
        }
        _ => None,
    })
}

pub fn write_pair(
    store: &dyn CredentialStore,
    service: &str,
    pending: bool,
    pair: &Pair,
) -> Result<(), CredentialError> {
    let (token_account, key_account) = accounts(pending);
    store.set(service, token_account, &pair.token)?;
    store.set(service, key_account, &pair.data_key)
}

pub fn clear_pair(
    store: &dyn CredentialStore,
    service: &str,
    pending: bool,
) -> Result<(), CredentialError> {
    let (token_account, key_account) = accounts(pending);
    let token = store.delete(service, token_account);
    let data_key = store.delete(service, key_account);
    token.and(data_key)
}

pub fn render_command_output(pair: &Pair) -> String {
    format!(
        "{TOKEN_VARIABLE}={}\n{DATA_KEY_VARIABLE}={}\n",
        pair.token, pair.data_key
    )
}

pub fn normalize_secret(value: &str, variable: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let prefix = format!("{variable}=");
    let bare = trimmed.strip_prefix(&prefix).unwrap_or(trimmed).trim();
    if bare.contains(['\n', '\r']) {
        return Err(format!("the {label} must be a single line"));
    }
    if bare.is_empty() {
        return Err(format!("the {label} is empty"));
    }
    Ok(bare.to_string())
}

pub fn run_command(host: &Host, pending: bool, out: &mut impl Write) -> i32 {
    let root = match host.root() {
        Ok(root) => root,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    let store = open_store(&host.overrides);
    match read_pair(store.as_ref(), &root.keychain_service(), pending) {
        Ok(Some(pair)) => {
            let _ = out.write_all(render_command_output(&pair).as_bytes());
            let _ = out.flush();
            0
        }
        Ok(None) => {
            eprintln!("no worker credentials are stored");
            1
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
