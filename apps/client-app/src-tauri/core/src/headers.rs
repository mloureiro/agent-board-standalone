pub type Header = (String, String);

const STRIPPED: [&str; 9] = [
    "authorization",
    "cookie",
    "host",
    "content-length",
    "x-board-key",
    "x-board-ts",
    "x-board-nonce",
    "x-board-sig",
    "content-digest",
];

pub const CONTRACT_HEADER: &str = "x-board-contract";
pub const CLIENT_HEADER: &str = "x-board-client";

pub fn page_headers(headers: &[Header]) -> Vec<Header> {
    headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .filter(|(name, _)| !STRIPPED.contains(&name.as_str()))
        .collect()
}

pub fn with_client_headers(mut headers: Vec<Header>, contract: &str, client: &str) -> Vec<Header> {
    for (name, value) in [(CONTRACT_HEADER, contract), (CLIENT_HEADER, client)] {
        if !headers.iter().any(|(existing, _)| existing == name) {
            headers.push((name.to_owned(), value.to_owned()));
        }
    }
    headers
}
