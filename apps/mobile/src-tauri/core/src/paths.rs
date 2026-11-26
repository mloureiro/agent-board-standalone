#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRefusal {
    Malformed,
    Traversal,
    OutsideApi,
    CredentialRoute,
}

const CREDENTIAL_ROUTES: &[&str] = &[
    "/api/auth/oidc/finish",
    "/api/auth/saml/finish",
    "/api/auth/passkey/login",
    "/api/auth/passkey/signup",
    "/api/auth/handoff/approve",
    "/api/auth/handoff/finish",
    "/api/pair",
    "/api/machine/register-key",
    "/api/client/account/import",
    "/api/client/machines/issue",
    "/api/client/passkeys/register",
];

fn has_encoded_unreserved_or_malformed_escape(route: &str) -> bool {
    let bytes = route.as_bytes();
    bytes.iter().enumerate().any(|(index, &byte)| {
        if byte != b'%' {
            return false;
        }
        let escape = bytes
            .get(index + 1..index + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        escape.is_none_or(|decoded| {
            decoded.is_ascii_alphanumeric() || matches!(decoded, b'-' | b'.' | b'_' | b'~')
        })
    })
}

pub fn normalise_path(path: &str) -> Result<String, PathRefusal> {
    if path
        .chars()
        .any(|c| c.is_control() || c == '\\' || c == '#' || c == ' ')
    {
        return Err(PathRefusal::Malformed);
    }
    let (route, query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    let lowered = route.to_ascii_lowercase();
    if lowered.contains("%2e")
        || lowered.contains("%2f")
        || lowered.contains("%5c")
        || lowered.contains("%00")
    {
        return Err(PathRefusal::Traversal);
    }
    if has_encoded_unreserved_or_malformed_escape(route) {
        return Err(PathRefusal::Malformed);
    }
    if route.contains("//")
        || route
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
    {
        return Err(PathRefusal::Traversal);
    }
    if !(route == "/healthz" || route.starts_with("/api/")) {
        return Err(PathRefusal::OutsideApi);
    }
    let comparable = lowered.trim_end_matches('/');
    if CREDENTIAL_ROUTES.contains(&comparable)
        || comparable == "/api/machine"
        || comparable.starts_with("/api/machine/")
    {
        return Err(PathRefusal::CredentialRoute);
    }
    Ok(match query {
        Some(query) => format!("{route}?{query}"),
        None => route.to_string(),
    })
}
