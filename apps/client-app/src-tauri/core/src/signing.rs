use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SigningError {
    NewlineInValue,
    InvalidKey,
}

pub fn canonical_string(
    method: &str,
    path_with_query: &str,
    ts: u64,
    nonce: &str,
    digest: Option<&str>,
) -> Result<String, SigningError> {
    let method = method.to_ascii_uppercase();
    let ts = ts.to_string();
    let parts = [
        method.as_str(),
        path_with_query,
        ts.as_str(),
        nonce,
        digest.unwrap_or(""),
    ];
    if parts.iter().any(|part| part.contains('\n')) {
        return Err(SigningError::NewlineInValue);
    }
    Ok(parts.join("\n"))
}

pub fn content_digest(body: &[u8]) -> String {
    format!("sha-256=:{}:", STANDARD.encode(Sha256::digest(body)))
}

pub fn key_id(spki_der: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(spki_der))
}

pub struct RequestSigner {
    key: SigningKey,
}

impl RequestSigner {
    pub fn generate() -> Self {
        Self {
            key: SigningKey::random(&mut OsRng),
        }
    }

    pub fn from_pkcs8_der(der: &[u8]) -> Result<Self, SigningError> {
        SigningKey::from_pkcs8_der(der)
            .map(|key| Self { key })
            .map_err(|_| SigningError::InvalidKey)
    }

    pub fn to_pkcs8_der(&self) -> Result<Vec<u8>, SigningError> {
        self.key
            .to_pkcs8_der()
            .map(|document| document.as_bytes().to_vec())
            .map_err(|_| SigningError::InvalidKey)
    }

    pub fn public_key_der(&self) -> Result<Vec<u8>, SigningError> {
        self.key
            .verifying_key()
            .to_public_key_der()
            .map(|document| document.as_bytes().to_vec())
            .map_err(|_| SigningError::InvalidKey)
    }

    pub fn public_key(&self) -> Result<String, SigningError> {
        self.public_key_der().map(|der| URL_SAFE_NO_PAD.encode(der))
    }

    pub fn key_id(&self) -> Result<String, SigningError> {
        self.public_key_der().map(|der| key_id(&der))
    }

    pub fn sign(&self, canonical: &str) -> String {
        let signature: Signature = self.key.sign(canonical.as_bytes());
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    }
}
