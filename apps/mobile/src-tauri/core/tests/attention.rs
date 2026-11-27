use rumo_bridge_core::attention::{AttentionState, notification_text, parse_attention};

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn the_first_poll_of_a_server_only_remembers_what_is_already_waiting() {
    let mut state = AttentionState::default();
    assert!(state.update("s", ids(&["a", "b"])).is_empty());
}

#[test]
fn a_task_that_newly_needs_me_is_reported_once() {
    let mut state = AttentionState::default();
    state.update("s", ids(&["a"]));
    assert_eq!(state.update("s", ids(&["a", "b"])), ids(&["b"]));
    assert!(state.update("s", ids(&["a", "b"])).is_empty());
}

#[test]
fn a_task_that_left_and_came_back_is_reported_again() {
    let mut state = AttentionState::default();
    state.update("s", ids(&["a"]));
    assert!(state.update("s", ids(&[])).is_empty());
    assert_eq!(state.update("s", ids(&["a"])), ids(&["a"]));
}

#[test]
fn servers_are_tracked_apart_and_forgetting_one_primes_it_again() {
    let mut state = AttentionState::default();
    state.update("one", ids(&["a"]));
    state.update("two", ids(&[]));
    assert_eq!(state.update("two", ids(&["a"])), ids(&["a"]));
    state.forget("one");
    assert!(state.update("one", ids(&["a", "z"])).is_empty());
}

#[test]
fn the_attention_answer_is_read_and_the_text_never_carries_a_title() {
    let body = br#"{"tasks":[{"id":"t1","projectId":"p","since":"2026-01-01T00:00:00Z"},{"id":"t2","projectId":"p","since":"2026-01-01T00:00:00Z"}]}"#;
    assert_eq!(parse_attention(body).unwrap(), ids(&["t1", "t2"]));
    assert!(parse_attention(b"{}").is_err());
    assert_eq!(notification_text("Home"), "A task needs you on Home");
}
