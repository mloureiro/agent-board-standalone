use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::thread::{sleep, spawn};
use std::time::Duration;

static REQUESTS: AtomicU32 = AtomicU32::new(0);
static ORDER_FD: AtomicI32 = AtomicI32::new(-1);
static STOP_LINE: OnceLock<Vec<u8>> = OnceLock::new();

extern "C" fn on_term(_: libc::c_int) {
    let fd = ORDER_FD.load(Ordering::SeqCst);
    if let Some(line) = STOP_LINE.get() {
        unsafe {
            libc::write(fd, line.as_ptr().cast(), line.len());
            libc::_exit(0);
        }
    }
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

fn failing(config: &HashMap<String, String>, request: u32) -> bool {
    config
        .get("fail_window")
        .and_then(|window| window.split_once(':'))
        .and_then(|(from, to)| Some((from.parse::<u32>().ok()?, to.parse::<u32>().ok()?)))
        .is_some_and(|(from, to)| (from..to).contains(&request))
}

fn config_path() -> Option<PathBuf> {
    std::env::var_os("STUB_CONFIG")
        .map(PathBuf::from)
        .or_else(|| {
            let mut name = std::env::current_exe().ok()?.into_os_string();
            name.push(".conf");
            Some(PathBuf::from(name))
        })
}

fn read_config() -> HashMap<String, String> {
    let text = config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn millis(config: &HashMap<String, String>, key: &str) -> Option<Duration> {
    config.get(key)?.parse().ok().map(Duration::from_millis)
}

fn answer(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    let config = read_config();
    let request_number = REQUESTS.fetch_add(1, Ordering::SeqCst) + 1;
    let mode = if failing(&config, request_number) {
        "fail".to_string()
    } else {
        config.get("health").cloned().unwrap_or_else(|| "ok".into())
    };
    let (status, body) = if request.starts_with("GET /healthz ") {
        match mode.as_str() {
            "hang" => loop {
                sleep(Duration::from_secs(3600));
            },
            "fail" => ("503 Service Unavailable", "{\"status\":\"down\"}"),
            _ => ("200 OK", "{\"status\":\"ok\"}"),
        }
    } else {
        ("404 Not Found", "{}")
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

// macOS sets close-on-exec after socket(), so a stub forked mid-bind by a parallel test keeps that socket.
fn close_inherited_descriptors() {
    for fd in 3..1024 {
        unsafe {
            libc::close(fd);
        }
    }
}

fn main() {
    close_inherited_descriptors();
    let config = read_config();
    println!("stub started pid {}", std::process::id());
    if let Some(path) = config.get("order_log") {
        let label = config.get("label").cloned().unwrap_or_default();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        let _ = writeln!(file, "start {label} {}", now_millis());
        let _ = STOP_LINE.set(format!("stop {label}\n").into_bytes());
        ORDER_FD.store(std::os::fd::IntoRawFd::into_raw_fd(file), Ordering::SeqCst);
        if !config.get("ignore_term").is_some_and(|value| value == "1") {
            unsafe {
                libc::signal(
                    libc::SIGTERM,
                    on_term as extern "C" fn(libc::c_int) as usize,
                );
            }
        }
    }
    if config.get("ignore_term").is_some_and(|value| value == "1") {
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
    }
    if let Some(path) = config.get("env_dump") {
        let mut vars: Vec<String> = std::env::vars().map(|(k, v)| format!("{k}={v}")).collect();
        vars.sort();
        let _ = std::fs::write(path, vars.join("\n"));
    }
    if let Some(delay) = millis(&config, "startup_delay_ms") {
        sleep(delay);
    }
    if let Some(path) = config.get("grandchild_pid_file") {
        let grandchild = Command::new("/bin/sleep").arg("300").spawn().unwrap();
        let _ = std::fs::write(path, grandchild.id().to_string());
        std::mem::forget(grandchild);
    }
    if config.get("health").is_none_or(|value| value != "none") {
        let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        match TcpListener::bind((host.as_str(), port)) {
            Ok(listener) => {
                spawn(move || {
                    for stream in listener.incoming().flatten() {
                        spawn(move || answer(stream));
                    }
                });
            }
            Err(error) => {
                eprintln!("cannot listen on {host}:{port}: {error}");
                std::process::exit(98);
            }
        }
    }
    match millis(&config, "crash_after_ms") {
        Some(delay) => {
            sleep(delay);
            eprintln!("stub crashing");
            std::process::exit(1);
        }
        None => loop {
            sleep(Duration::from_secs(3600));
        },
    }
}
