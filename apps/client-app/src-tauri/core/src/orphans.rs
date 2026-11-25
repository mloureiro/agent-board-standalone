use crate::ids::ServerId;
use crate::ports::{FileStore, SecretStore};
use crate::tokens::{key_service, token_service};

const TAB_FILE_SUFFIX: &str = ".json";

pub fn orphans<'a>(listed: &[ServerId], found: impl IntoIterator<Item = &'a str>) -> Vec<ServerId> {
    let mut orphans: Vec<ServerId> = found
        .into_iter()
        .filter_map(|account| ServerId::parse(account).ok())
        .filter(|id| !listed.contains(id))
        .collect();
    orphans.sort_by_key(ToString::to_string);
    orphans.dedup();
    orphans
}

pub fn tab_file_name(server: ServerId) -> String {
    format!("{server}{TAB_FILE_SUFFIX}")
}

pub fn sweep(
    listed: &[ServerId],
    secrets: &impl SecretStore,
    tab_files: &impl FileStore,
) -> Vec<ServerId> {
    let mut swept = Vec::new();
    for service in [token_service(), key_service()] {
        let accounts = secrets.accounts(&service).unwrap_or_default();
        for id in orphans(listed, accounts.iter().map(String::as_str)) {
            if secrets.delete(&service, &id.to_string()).is_ok() {
                swept.push(id);
            }
        }
    }
    let files = tab_files.list().unwrap_or_default();
    let stems = files
        .iter()
        .filter_map(|name| name.strip_suffix(TAB_FILE_SUFFIX));
    for id in orphans(listed, stems) {
        if tab_files.delete(&tab_file_name(id)).is_ok() {
            swept.push(id);
        }
    }
    swept.sort_by_key(ToString::to_string);
    swept.dedup();
    swept
}
