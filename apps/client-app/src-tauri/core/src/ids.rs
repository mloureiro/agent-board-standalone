use std::fmt;
use uuid::{Uuid, Variant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ServerId(Uuid);

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidServerId;

impl ServerId {
    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn to_bytes(self) -> [u8; 16] {
        *self.0.as_bytes()
    }

    pub fn parse(text: &str) -> Result<Self, InvalidServerId> {
        let uuid = Uuid::try_parse(text).map_err(|_| InvalidServerId)?;
        let canonical = uuid.hyphenated().to_string() == text;
        let version_four = uuid.get_version_num() == 4 && uuid.get_variant() == Variant::RFC4122;
        if canonical && version_four {
            Ok(Self(uuid))
        } else {
            Err(InvalidServerId)
        }
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0.hyphenated())
    }
}
