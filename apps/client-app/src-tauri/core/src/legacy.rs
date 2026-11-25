use crate::BUNDLE_ID;
use crate::ids::ServerId;
use crate::ports::SecretStore;
use uuid::Uuid;

pub const TABS_DIRECTORY: &str = "tabs";

pub fn session_service() -> String {
    format!("{BUNDLE_ID}.session")
}

pub fn stores_to_delete(found: impl IntoIterator<Item = [u8; 16]>) -> Vec<ServerId> {
    let mut stores: Vec<ServerId> = found
        .into_iter()
        .filter_map(|bytes| ServerId::parse(&Uuid::from_bytes(bytes).hyphenated().to_string()).ok())
        .collect();
    stores.sort_by_key(ToString::to_string);
    stores.dedup();
    stores
}

pub fn sweep_sessions(secrets: &impl SecretStore) -> usize {
    let service = session_service();
    secrets
        .accounts(&service)
        .unwrap_or_default()
        .iter()
        .filter(|account| secrets.delete(&service, account).is_ok())
        .count()
}
