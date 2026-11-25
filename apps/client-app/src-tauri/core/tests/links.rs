use agent_board_client_core::ids::ServerId;
use agent_board_client_core::log::{LogEvent, line};

#[test]
fn client_app_034_log_lines_carry_only_the_server_id() {
    let server = ServerId::parse("6ba7b810-9dad-41d1-80b4-00c04fd430c8").unwrap();
    for event in LogEvent::ALL {
        let text = line(server, event);
        assert_eq!(
            text,
            format!(
                "server=6ba7b810-9dad-41d1-80b4-00c04fd430c8 {}",
                event.text()
            )
        );
        for fragment in ["://", "/", "\\", "?", "#", "@"] {
            assert!(!event.text().contains(fragment), "{}", event.text());
        }
    }
    let distinct: std::collections::BTreeSet<_> =
        LogEvent::ALL.iter().map(|event| event.text()).collect();
    assert_eq!(distinct.len(), LogEvent::ALL.len());
}
