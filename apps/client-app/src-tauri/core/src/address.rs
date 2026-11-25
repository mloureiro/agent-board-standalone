use url::{Host, Url};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressProblem {
    Invalid,
    Insecure,
    Credentials,
}

impl AddressProblem {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Insecure => "insecure",
            Self::Credentials => "credentials",
        }
    }
}

pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn check_address(input: &str) -> Result<String, AddressProblem> {
    let url = Url::parse(input.trim()).map_err(|_| AddressProblem::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(AddressProblem::Invalid);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AddressProblem::Credentials);
    }
    if url.scheme() == "http" && !is_loopback(&url) {
        return Err(AddressProblem::Insecure);
    }
    Ok(url.into())
}
