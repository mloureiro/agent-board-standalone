use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub fn probe(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let remaining = |from: Instant| {
        timeout
            .saturating_sub(from.elapsed())
            .max(Duration::from_millis(1))
    };
    let _ = stream.set_write_timeout(Some(remaining(started)));
    let request =
        format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    let mut filled = 0;
    while filled < head.len() {
        let _ = stream.set_read_timeout(Some(remaining(started)));
        match stream.read(&mut head[filled..]) {
            Ok(0) | Err(_) => return false,
            Ok(count) => filled += count,
        }
    }
    head.starts_with(b"HTTP/1.") && &head[8..12] == b" 200"
}

pub fn port_in_use(port: u16) -> bool {
    let bound = matches!(
        std::net::TcpListener::bind(("127.0.0.1", port)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse
    );
    bound
        || [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]
        .into_iter()
        .any(|ip| {
            TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(250))
                .is_ok()
        })
}
