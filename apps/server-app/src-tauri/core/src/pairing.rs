use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use crate::control::ControlClient;
use crate::timestamp;

pub const VALIDITY: Duration = Duration::from_secs(10 * 60);
pub const SIGNATURE_OFF: &str = "pairing needs the request signature: set requestSignature to true in settings.json and reopen the app";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issued {
    pub code: String,
    pub expires_at: String,
}

pub fn issue(control: &ControlClient, now: SystemTime) -> Result<Issued, String> {
    let code = control.pair_code().map_err(|error| error.to_string())?;
    Ok(Issued {
        code,
        expires_at: timestamp::format(now + VALIDITY),
    })
}

impl Issued {
    pub fn to_json(&self) -> Value {
        json!({
            "type": "pair-code",
            "code": self.code,
            "expiresAt": self.expires_at,
            "validForSeconds": VALIDITY.as_secs(),
        })
    }
}
