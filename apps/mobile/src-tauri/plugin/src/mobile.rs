use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

const PACKAGE: &str = "com.mloureiro.rumo.boardnative";

pub struct BoardNative<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<BoardNative<R>> {
    let handle = api.register_android_plugin(PACKAGE, "BoardNativePlugin")?;
    Ok(BoardNative(handle))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerArgs<'a> {
    server_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenArgs<'a> {
    server_id: &'a str,
    token: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignArgs<'a> {
    server_id: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyArgs<'a> {
    server_id: &'a str,
    task_id: &'a str,
    text: &'a str,
}

#[derive(Deserialize)]
struct Value {
    value: Option<String>,
}

impl<R: Runtime> BoardNative<R> {
    fn call<A: Serialize, T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        args: A,
    ) -> crate::Result<T> {
        self.0.run_mobile_plugin(command, args).map_err(Into::into)
    }

    pub fn token_get(&self, server_id: &str) -> crate::Result<Option<String>> {
        Ok(self
            .call::<_, Value>("tokenGet", ServerArgs { server_id })?
            .value)
    }

    pub fn token_set(&self, server_id: &str, token: &str) -> crate::Result<()> {
        self.call::<_, serde_json::Value>("tokenSet", TokenArgs { server_id, token })
            .map(drop)
    }

    pub fn token_delete(&self, server_id: &str) -> crate::Result<()> {
        self.call::<_, serde_json::Value>("tokenDelete", ServerArgs { server_id })
            .map(drop)
    }

    pub fn public_key(&self, server_id: &str) -> crate::Result<String> {
        self.call::<_, Value>("publicKey", ServerArgs { server_id })?
            .value
            .ok_or_else(|| crate::Error::Native("no public key".into()))
    }

    pub fn sign(&self, server_id: &str, message_b64: &str) -> crate::Result<String> {
        self.call::<_, Value>(
            "sign",
            SignArgs {
                server_id,
                message: message_b64,
            },
        )?
        .value
        .ok_or_else(|| crate::Error::Native("no signature".into()))
    }

    pub fn delete_key(&self, server_id: &str) -> crate::Result<()> {
        self.call::<_, serde_json::Value>("deleteKey", ServerArgs { server_id })
            .map(drop)
    }

    pub fn service_start(&self) -> crate::Result<()> {
        self.call::<_, serde_json::Value>("serviceStart", ())
            .map(drop)
    }

    pub fn service_stop(&self) -> crate::Result<()> {
        self.call::<_, serde_json::Value>("serviceStop", ())
            .map(drop)
    }

    pub fn notify(&self, server_id: &str, task_id: &str, text: &str) -> crate::Result<()> {
        self.call::<_, serde_json::Value>(
            "notify",
            NotifyArgs {
                server_id,
                task_id,
                text,
            },
        )
        .map(drop)
    }
}
