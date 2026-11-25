use crate::state::AppState;
use crate::tab_registry::{Step, TabRegistry};
use crate::windows::{self, BRIDGE_SCRIPT, TABBAR_PREFIX, server_window_label, tab_label};
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::layout::{self, Bounds};
use agent_board_client_core::navigation::{Navigation, app_path, classify};
use agent_board_client_core::orphans::tab_file_name;
use agent_board_client_core::ports::FileStore;
use agent_board_client_core::tabs::{Effect, HOME, TabId, Tabs};
use std::sync::Arc;
use tauri::EventTarget;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
    Window,
};

const TABS_CHANGED_EVENT: &str = "tabs-changed";

pub fn bounds_rect(bounds: Bounds) -> Rect {
    Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

pub fn window_size(window: &Window) -> tauri::Result<LogicalSize<f64>> {
    Ok(window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?))
}

pub fn relayout(window: &Window) {
    let Ok(size) = window_size(window) else {
        return;
    };
    for webview in window.webviews() {
        let bounds = if webview.label().starts_with(TABBAR_PREFIX) {
            layout::tab_bar(size.width, size.height)
        } else {
            layout::page(size.width, size.height)
        };
        let _ = webview.set_bounds(bounds_rect(bounds));
    }
}

pub fn guard(origin: Url) -> impl Fn(&Url) -> bool + Send + 'static {
    move |target| matches!(classify(target, &origin), Navigation::Stay)
}

fn app_url(path: &str) -> WebviewUrl {
    WebviewUrl::App(path.trim_start_matches('/').into())
}

fn joined(origin: &Url, path: &str) -> Option<Url> {
    let url = origin.join(path).ok()?;
    matches!(classify(&url, origin), Navigation::Stay).then_some(url)
}

pub fn page_builder(
    app: &AppHandle,
    server: ServerId,
    tab: TabId,
    path: &str,
    origin: &Url,
) -> WebviewBuilder<tauri::Wry> {
    let opener = app.clone();
    let page_origin = origin.clone();
    WebviewBuilder::new(tab_label(server, tab), app_url(path))
        .initialization_script(BRIDGE_SCRIPT)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(guard(origin.clone()))
        .on_new_window(move |target, _| {
            if matches!(classify(&target, &page_origin), Navigation::Stay) {
                let path = app_path(&target);
                dispatch(&opener, server, move |tabs| tabs.open(&path));
            }
            NewWindowResponse::Deny
        })
}

fn create_page(
    app: &AppHandle,
    window: &Window,
    server: ServerId,
    tab: TabId,
    path: &str,
    origin: &Url,
) -> tauri::Result<Webview> {
    let size = window_size(window)?;
    let bounds = layout::page(size.width, size.height);
    window.add_child(
        page_builder(app, server, tab, path, origin),
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    )
}

pub fn create_hidden_home(app: &AppHandle, server: ServerId, origin: &Url) {
    let Some(window) = app.get_window(&server_window_label(server)) else {
        return;
    };
    if app.get_webview(&tab_label(server, HOME)).is_some() {
        return;
    }
    if let Ok(home) = create_page(app, &window, server, HOME, "/", origin) {
        let _ = home.hide();
    }
}

fn apply(app: &AppHandle, server: ServerId, step: Step) {
    let Some(window) = app.get_window(&server_window_label(server)) else {
        return;
    };
    for effect in step.effects {
        match effect {
            Effect::CreateWebview { tab, path } => {
                if app.get_webview(&tab_label(server, tab)).is_none() {
                    let _ = create_page(app, &window, server, tab, &path, &step.origin);
                }
            }
            Effect::Navigate { tab, path } => {
                if let (Some(webview), Some(url)) = (
                    app.get_webview(&tab_label(server, tab)),
                    joined(&step.origin, &path),
                ) {
                    let _ = webview.navigate(url);
                }
            }
            Effect::Show(tab) => {
                if let Some(webview) = app.get_webview(&tab_label(server, tab)) {
                    let _ = webview.show();
                    let _ = webview.set_focus();
                }
            }
            Effect::Hide(tab) => {
                if let Some(webview) = app.get_webview(&tab_label(server, tab)) {
                    let _ = webview.hide();
                }
            }
            Effect::Close(tab) => {
                if let Some(webview) = app.get_webview(&tab_label(server, tab)) {
                    let _ = webview.close();
                }
            }
            Effect::UpdateBar => {
                let _ = app.emit_to(
                    EventTarget::Webview {
                        label: windows::tabbar_label(server),
                    },
                    TABS_CHANGED_EVENT,
                    &step.view,
                );
            }
            Effect::WriteTabFile => {
                let state = app.state::<Arc<AppState>>();
                let _ = state.tab_files.write(&tab_file_name(server), &step.file);
            }
            Effect::LimitReached => {}
        }
    }
}

pub fn run(app: &AppHandle, server: ServerId, change: impl FnOnce(&mut Tabs) -> Vec<Effect>) {
    let registry = app.state::<TabRegistry>();
    let _ordered = registry.ordered();
    if let Some(step) = registry.act(server, change) {
        apply(app, server, step);
    }
}

pub fn dispatch(
    app: &AppHandle,
    server: ServerId,
    change: impl FnOnce(&mut Tabs) -> Vec<Effect> + Send + 'static,
) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&app, server, change));
}
