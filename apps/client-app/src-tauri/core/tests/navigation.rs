use agent_board_client_core::layout::{Bounds, TAB_BAR_HEIGHT, page, tab_bar};
use agent_board_client_core::navigation::{Navigation, app_path, classify};
use url::Url;

fn url(text: &str) -> Url {
    Url::parse(text).unwrap()
}

#[test]
fn navigation_stays_on_the_app_origin_only() {
    let app = url("tauri://localhost/_native/tabbar.html");
    assert_eq!(
        classify(&url("tauri://localhost/backlog?q=1"), &app),
        Navigation::Stay
    );
    assert_eq!(classify(&url("tauri://localhost/"), &app), Navigation::Stay);
    for other in [
        "tauri://evil/backlog",
        "tauri://localhost:8080/",
        "tauri://localhost.evil.test/",
    ] {
        assert_eq!(classify(&url(other), &app), Navigation::Drop, "{other}");
    }
}

#[test]
fn navigation_sends_remote_pages_out_and_drops_everything_else() {
    let app = url("tauri://localhost/");
    for remote in ["https://example.com/a", "http://127.0.0.1:4000/x"] {
        assert_eq!(
            classify(&url(remote), &app),
            Navigation::External(url(remote)),
            "{remote}"
        );
    }
    for blocked in [
        "mailto:someone@example.com",
        "file:///etc/hosts",
        "javascript:alert(1)",
        "data:text/html,hi",
        "about:blank",
        "ftp://example.com/",
    ] {
        assert_eq!(classify(&url(blocked), &app), Navigation::Drop, "{blocked}");
    }
}

#[test]
fn navigation_app_path_keeps_the_query_and_drops_the_fragment() {
    assert_eq!(
        app_path(&url("tauri://localhost/tasks/t-1?a=1#frag")),
        "/tasks/t-1?a=1"
    );
    assert_eq!(app_path(&url("tauri://localhost/")), "/");
}

#[test]
fn layout_puts_the_bar_above_the_page_and_never_overflows_a_short_window() {
    let at = |y: f64, width: f64, height: f64| Bounds {
        x: 0.0,
        y,
        width,
        height,
    };
    assert_eq!(tab_bar(1280.0, 860.0), at(0.0, 1280.0, TAB_BAR_HEIGHT));
    assert_eq!(
        page(1280.0, 860.0),
        at(TAB_BAR_HEIGHT, 1280.0, 860.0 - TAB_BAR_HEIGHT)
    );
    assert_eq!(tab_bar(400.0, 20.0), at(0.0, 400.0, 20.0));
    assert_eq!(page(400.0, 20.0), at(20.0, 400.0, 0.0));
}
