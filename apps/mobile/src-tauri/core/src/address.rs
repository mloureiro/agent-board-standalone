use url::{Host, Url};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(ip)) => ip.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(ip)) => ip.is_loopback() && ip.segments() == [0, 0, 0, 0, 0, 0, 0, 1],
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
    Ok(url.to_string())
}
