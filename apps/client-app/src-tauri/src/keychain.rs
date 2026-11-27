use rumo_client_core::ports::{PortError, SecretStore};
use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::os::macos::keychain::SecKeychain;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use std::sync::{Arc, RwLock};

const ITEM_NOT_FOUND: i32 = -25300;

fn unavailable() -> PortError {
    PortError("keychain unavailable".to_owned())
}

#[derive(Default)]
pub struct Keychain {
    interaction: RwLock<()>,
}

impl Keychain {
    fn read<T>(
        &self,
        job: impl FnOnce() -> Result<T, security_framework::base::Error>,
    ) -> Result<Option<T>, PortError> {
        let _shared = self.interaction.read().map_err(|_| unavailable())?;
        match job() {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }

    fn without_prompts<T>(
        &self,
        job: impl FnOnce() -> Result<T, security_framework::base::Error>,
    ) -> Result<Option<T>, PortError> {
        let _exclusive = self.interaction.write().map_err(|_| unavailable())?;
        let _silent = SecKeychain::disable_user_interaction().map_err(|_| unavailable())?;
        match job() {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }
}

fn list_accounts(service: &str) -> Result<Vec<String>, security_framework::base::Error> {
    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .load_attributes(true)
        .limit(Limit::All)
        .search()?;
    Ok(results
        .iter()
        .filter_map(|result| result.simplify_dict())
        .filter_map(|mut attributes| attributes.remove("acct"))
        .collect())
}

impl SecretStore for Keychain {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, PortError> {
        self.read(|| get_generic_password(service, account))
    }

    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), PortError> {
        self.read(|| set_generic_password(service, account, secret))
            .map(|_| ())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), PortError> {
        self.read(|| delete_generic_password(service, account))
            .map(|_| ())
    }

    fn accounts(&self, service: &str) -> Result<Vec<String>, PortError> {
        self.read(|| list_accounts(service))
            .map(Option::unwrap_or_default)
    }
}

pub struct Background(pub Arc<Keychain>);

impl SecretStore for Background {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, PortError> {
        self.0
            .without_prompts(|| get_generic_password(service, account))
    }

    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), PortError> {
        self.0
            .without_prompts(|| set_generic_password(service, account, secret))
            .map(|_| ())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), PortError> {
        self.0
            .without_prompts(|| delete_generic_password(service, account))
            .map(|_| ())
    }

    fn accounts(&self, service: &str) -> Result<Vec<String>, PortError> {
        self.0
            .without_prompts(|| list_accounts(service))
            .map(Option::unwrap_or_default)
    }
}
