pub const CREDENTIAL_ROUTES: [&str; 10] = [
    "/api/auth/handoff/finish",
    "/api/pair",
    "/api/machine/register-key",
    "/api/client/passkeys/register",
    "/api/client/machines/issue",
    "/api/client/account/import",
    "/api/auth/oidc/finish",
    "/api/auth/saml/finish",
    "/api/auth/passkey/login",
    "/api/auth/passkey/signup",
];

const MACHINE_PREFIX: &str = "/api/machine";
const ENCODED_FORBIDDEN: [&str; 4] = ["%2e", "%2f", "%5c", "%00"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    ControlCharacter,
    Fragment,
    NotAbsolute,
    Backslash,
    EncodedSeparator,
    EmptySegment,
    DotSegment,
    CredentialRoute,
    OutsideApi,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::ControlCharacter => "control character",
            Self::Fragment => "fragment",
            Self::NotAbsolute => "path must start with a single /",
            Self::Backslash => "backslash",
            Self::EncodedSeparator => "encoded separator",
            Self::EmptySegment => "empty segment",
            Self::DotSegment => "dot segment",
            Self::CredentialRoute => "credential route",
            Self::OutsideApi => "outside /api/",
        }
    }
}

fn is_credential_route(lowercase_route: &str) -> bool {
    let machine = lowercase_route == MACHINE_PREFIX
        || lowercase_route.starts_with(&format!("{MACHINE_PREFIX}/"));
    machine || CREDENTIAL_ROUTES.contains(&lowercase_route)
}

pub fn normalise(path: &str) -> Result<String, Refusal> {
    if path.chars().any(char::is_control) {
        return Err(Refusal::ControlCharacter);
    }
    if path.contains('#') {
        return Err(Refusal::Fragment);
    }
    let pathname = path.split_once('?').map_or(path, |(before, _)| before);
    if !pathname.starts_with('/') {
        return Err(Refusal::NotAbsolute);
    }
    if pathname.contains('\\') {
        return Err(Refusal::Backslash);
    }
    let lowercase = pathname.to_ascii_lowercase();
    if ENCODED_FORBIDDEN
        .iter()
        .any(|code| lowercase.contains(code))
    {
        return Err(Refusal::EncodedSeparator);
    }
    if pathname.contains("//") {
        return Err(Refusal::EmptySegment);
    }
    if pathname
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(Refusal::DotSegment);
    }
    if is_credential_route(lowercase.trim_end_matches('/')) {
        return Err(Refusal::CredentialRoute);
    }
    if pathname != "/healthz" && !pathname.starts_with("/api/") {
        return Err(Refusal::OutsideApi);
    }
    Ok(path.to_owned())
}
