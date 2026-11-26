use regex::Regex;
use std::sync::LazyLock;

pub const MASK: &str = "[redacted]";

static AUTHORIZATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(authorization["']?\s*[:=]\s*).*"#).expect("authorization pattern")
});
static ISSUED_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9_])(?:abc|abm|abs|abk1)_[A-Za-z0-9_-]+").expect("credential pattern")
});
static HEX_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9a-fA-F]{64,}").expect("hex pattern"));

static PAIRING_CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b").expect("pairing code pattern")
});

pub fn redact(line: &str) -> String {
    let without_header = AUTHORIZATION.replace_all(line, format!("${{1}}{MASK}"));
    let without_credentials =
        ISSUED_CREDENTIAL.replace_all(&without_header, format!("${{1}}{MASK}"));
    let without_hex = HEX_SECRET.replace_all(&without_credentials, MASK);
    PAIRING_CODE.replace_all(&without_hex, MASK).into_owned()
}
