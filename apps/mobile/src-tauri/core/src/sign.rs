use crate::ports::{Env, KeyStore};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

pub fn canonical_string(
    method: &str,
    path_with_query: &str,
    ts: u64,
    nonce: &str,
    digest: Option<&str>,
) -> String {
    [
        method.to_ascii_uppercase().as_str(),
        path_with_query,
        ts.to_string().as_str(),
        nonce,
        digest.unwrap_or(""),
    ]
    .join("\n")
}

pub fn content_digest(body: &[u8]) -> String {
    format!("sha-256=:{}:", STANDARD.encode(Sha256::digest(body)))
}

pub fn signing_headers(
    keys: &impl KeyStore,
    env: &impl Env,
    server_id: &str,
    method: &str,
    path_with_query: &str,
    body: Option<&[u8]>,
) -> Result<Vec<(String, String)>, String> {
    let ts = env.now_secs();
    let nonce = env.nonce();
    let digest = body.filter(|bytes| !bytes.is_empty()).map(content_digest);
    let canonical = canonical_string(method, path_with_query, ts, &nonce, digest.as_deref());
    let signature = keys.sign(server_id, canonical.as_bytes())?;
    let key_id = key_id_of(&keys.public_key(server_id)?)?;
    let mut headers = vec![
        ("x-board-key".to_string(), key_id),
        ("x-board-ts".to_string(), ts.to_string()),
        ("x-board-nonce".to_string(), nonce),
        ("x-board-sig".to_string(), signature),
    ];
    if let Some(digest) = digest {
        headers.push(("content-digest".to_string(), digest));
    }
    Ok(headers)
}

pub fn key_id_of(public_key: &str) -> Result<String, String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let der = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| "the public key is not valid".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(der)))
}
