use std::marker::PhantomData;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

pub struct BoardNative<R: Runtime>(PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<BoardNative<R>> {
    Ok(BoardNative(PhantomData))
}

impl<R: Runtime> BoardNative<R> {
    fn unavailable<T>() -> crate::Result<T> {
        Err(crate::Error::Native("only available on Android".into()))
    }

    pub fn token_get(&self, _server_id: &str) -> crate::Result<Option<String>> {
        Self::unavailable()
    }

    pub fn token_set(&self, _server_id: &str, _token: &str) -> crate::Result<()> {
        Self::unavailable()
    }

    pub fn token_delete(&self, _server_id: &str) -> crate::Result<()> {
        Self::unavailable()
    }

    pub fn public_key(&self, _server_id: &str) -> crate::Result<String> {
        Self::unavailable()
    }

    pub fn sign(&self, _server_id: &str, _message_b64: &str) -> crate::Result<String> {
        Self::unavailable()
    }

    pub fn delete_key(&self, _server_id: &str) -> crate::Result<()> {
        Self::unavailable()
    }

    pub fn service_start(&self) -> crate::Result<()> {
        Self::unavailable()
    }

    pub fn service_stop(&self) -> crate::Result<()> {
        Self::unavailable()
    }

    pub fn notify(&self, _server_id: &str, _task_id: &str, _text: &str) -> crate::Result<()> {
        Self::unavailable()
    }
}
