mod common;

use agent_board_client_core::bridge::Bridge;
use agent_board_client_core::files::DirStore;
use agent_board_client_core::handshake::Handshake;
use agent_board_client_core::log::{LogEvent, line};
use agent_board_client_core::ports::SecretStore;
use agent_board_client_core::servers::Servers;
use agent_board_client_core::tab_file;
use agent_board_client_core::tabs::Tabs;
use agent_board_client_core::tokens::{key_service, token_service};
use common::*;
use futures_util::StreamExt;
use serde_json::json;
use std::fs;
use std::path::Path;

const TITLE: &str = "Quarterly payroll migration";
const PROMPT: &str = "rotate the payroll signing credentials";
const LABEL: &str = "needs-review-by-finance";

fn files_under(root: &Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files_under(&path));
        } else {
            found.push(path);
        }
    }
    found
}

#[tokio::test]
async fn client_app_036_no_store_holds_decrypted_content_after_a_journey() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let data = root.path().join("data");
    let tab_files = DirStore::new(data.join("tab-files"));
    let content = json!({"tasks": [{"title": TITLE, "prompt": PROMPT, "labels": [LABEL]}]});
    let http = FakeHttp::answering([
        Ok(Canned::json(
            200,
            &json!({"status": "signed-in", "token": token()}).to_string(),
        )),
        Ok(Canned::json(200, &content.to_string())),
        Ok(Canned::json(200, &content.to_string())),
    ]);
    let secrets = std::sync::Arc::new(MemorySecrets::default());
    let bridge = Bridge::new(
        http,
        std::sync::Arc::clone(&secrets),
        FakeConfirm::answering(true),
        FakeClock,
        Servers::open(DirStore::new(&config)),
        client_info(),
    );

    let added = bridge
        .page_add_server(
            &agent_board_client_core::bridge::Scope::AllServers(vec![]),
            "Alpha",
            "https://board.example.test/",
        )
        .unwrap()
        .unwrap();
    let server = added.id;
    let scope = agent_board_client_core::bridge::Scope::Server(server);
    bridge.record_handshake(
        server,
        Handshake {
            request_signature: true,
        },
    );
    bridge
        .handoff_finish(&scope, &server.to_string(), "flow-0001", &"v".repeat(43))
        .await
        .unwrap();
    for _ in 0..2 {
        let response = bridge
            .server_fetch(&scope, &server.to_string(), "GET", "/api/tasks", &[], None)
            .await
            .unwrap();
        assert_eq!(response.body.collect::<Vec<_>>().await.len(), 1);
    }

    let mut tabs = Tabs::new();
    tabs.open("/tasks/t-1");
    tabs.title(1, &format!("{TITLE} · Agent Board"));
    tab_file::write(&tab_files, server, &tabs).unwrap();
    let mut logged: Vec<String> = LogEvent::ALL
        .iter()
        .map(|event| line(server, *event))
        .collect();
    bridge
        .rename_server(&scope, &server.to_string(), "Alpha renamed", |_| Ok(()))
        .unwrap();
    logged.push(format!("{:?}", bridge.is_expired(server)));

    let mut written: Vec<(String, Vec<u8>)> = files_under(root.path())
        .into_iter()
        .map(|path| (path.display().to_string(), fs::read(&path).unwrap()))
        .collect();
    assert!(written.len() >= 2, "{written:?}");
    let services = [token_service(), key_service()];
    for service in &services {
        for account in secrets.accounts(service).unwrap() {
            assert_eq!(account, server.to_string());
            let value = secrets.peek(service, &account).unwrap();
            written.push((format!("keychain {service}"), value));
        }
    }
    assert_eq!(secrets.services(), {
        let mut expected = services.to_vec();
        expected.sort();
        expected
    });
    written.extend(
        logged
            .into_iter()
            .map(|text| ("log".to_owned(), text.into_bytes())),
    );

    for (place, bytes) in &written {
        let text = String::from_utf8_lossy(bytes);
        for marker in [TITLE, PROMPT, LABEL, "prompt", "passphrase"] {
            assert!(!text.contains(marker), "{marker} found in {place}");
        }
    }
}
