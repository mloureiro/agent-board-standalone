use agent_board_client_core::ids::ServerId;
use agent_board_client_core::ports::Clock;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs())
    }

    fn nonce(&self) -> String {
        URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes())
    }

    fn new_server_id(&self) -> ServerId {
        ServerId::generate()
    }
}
