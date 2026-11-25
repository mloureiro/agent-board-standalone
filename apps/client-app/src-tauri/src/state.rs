use crate::clock::SystemClock;
use crate::confirm::NativeConfirm;
use crate::fetches::Fetches;
use crate::keychain::Keychain;
use crate::removals::Removals;
use agent_board_client_core::bridge::Bridge;
use agent_board_client_core::files::DirStore;
use agent_board_client_core::handshake::ClientInfo;
use agent_board_client_core::http::ReqwestHttp;
use serde::Serialize;
use std::sync::{Arc, Mutex};

pub const CONTRACT: u32 = 1;

pub type ShellBridge = Bridge<ReqwestHttp, Keychain, NativeConfirm, SystemClock, DirStore>;

#[derive(Clone, Debug, Serialize)]
pub struct OpenFailure {
    pub name: String,
    pub text: String,
}

pub struct AppState {
    pub bridge: ShellBridge,
    pub secrets: Arc<Keychain>,
    pub client: ClientInfo,
    pub http: ReqwestHttp,
    pub tab_files: Arc<DirStore>,
    pub fetches: Fetches,
    pub removals: Removals,
    pub open_failures: Mutex<Vec<OpenFailure>>,
}

impl AppState {
    pub fn queue_open_failure(&self, failure: OpenFailure) {
        self.open_failures.lock().unwrap().push(failure);
    }

    pub fn take_open_failures(&self) -> Vec<OpenFailure> {
        std::mem::take(&mut *self.open_failures.lock().unwrap())
    }
}
