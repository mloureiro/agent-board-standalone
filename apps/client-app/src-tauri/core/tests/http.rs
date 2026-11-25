use agent_board_client_core::handshake::{ClientInfo, handshake};
use agent_board_client_core::http::ReqwestHttp;
use agent_board_client_core::ports::{Http, HttpRequest, Limits};
use futures_util::StreamExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;

async fn read_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

fn request(url: String, limits: Option<Limits>) -> HttpRequest {
    HttpRequest {
        method: "GET".to_owned(),
        url,
        headers: vec![("accept".to_owned(), "text/event-stream".to_owned())],
        body: Vec::new(),
        limits,
    }
}

#[tokio::test]
async fn client_app_049_does_not_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connections = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&connections);
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            counted.fetch_add(1, Ordering::SeqCst);
            read_head(&mut stream).await;
            let answer = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{address}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(answer.as_bytes()).await.unwrap();
        }
    });

    let http = ReqwestHttp::new().unwrap();
    let response = http
        .send(request(format!("http://{address}/api/tasks"), None))
        .await
        .unwrap();

    assert_eq!(response.status, 302);
    assert!(response.headers.iter().any(|(name, _)| name == "location"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn client_app_049_streams_chunks_as_they_arrive() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (first_seen, release_second) = oneshot::channel::<()>();
    let (request_line, received_head) = oneshot::channel::<String>();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let head = read_head(&mut stream).await;
        request_line.send(head).unwrap();
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        stream.write_all(b"9\r\ndata: 1\n\n\r\n").await.unwrap();
        stream.flush().await.unwrap();
        release_second.await.unwrap();
        stream
            .write_all(b"9\r\ndata: 2\n\n\r\n0\r\n\r\n")
            .await
            .unwrap();
    });

    let http = ReqwestHttp::new().unwrap();
    let mut response = http
        .send(request(format!("http://{address}/api/events?a=%20b"), None))
        .await
        .unwrap();
    assert_eq!(response.status, 200);

    let first = timeout(Duration::from_secs(5), response.body.next())
        .await
        .expect("first chunk waited for the rest of the body")
        .unwrap()
        .unwrap();
    assert_eq!(first, b"data: 1\n\n");
    first_seen.send(()).unwrap();
    let second = timeout(Duration::from_secs(5), response.body.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(second, b"data: 2\n\n");
    assert!(response.body.next().await.is_none());

    let head = received_head.await.unwrap();
    assert!(
        head.starts_with("GET /api/events?a=%20b HTTP/1.1\r\n"),
        "{head}"
    );
    assert!(
        head.to_ascii_lowercase()
            .contains("accept: text/event-stream")
    );
}

#[tokio::test]
async fn client_app_003_the_handshake_reads_the_signature_flag_from_a_live_server() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let head = read_head(&mut stream).await;
        assert!(head.starts_with("GET /api/version HTTP/1.1"));
        let body = r#"{"contract":1,"modules":{"requestSignature":true}}"#;
        let answer = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(answer.as_bytes()).await.unwrap();
    });
    let client = ClientInfo {
        contract: 1,
        version: "1.0.0".to_owned(),
    };
    let outcome = handshake(
        &ReqwestHttp::new().unwrap(),
        &format!("http://{address}/"),
        &client,
    )
    .await
    .unwrap();
    assert!(outcome.request_signature);
}

#[tokio::test]
async fn client_app_003_a_silent_server_hits_the_total_limit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let limits = Limits {
        connect: Duration::from_secs(1),
        total: Duration::from_millis(200),
    };
    let failure = ReqwestHttp::new()
        .unwrap()
        .send(request(
            format!("http://{address}/api/version"),
            Some(limits),
        ))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.0, "timed out");
}
