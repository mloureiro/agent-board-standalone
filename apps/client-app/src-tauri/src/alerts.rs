use crate::clock::SystemClock;
use crate::keychain::Background;
use crate::notifications::Notifier;
use crate::server_tabs::dispatch;
use crate::state::AppState;
use crate::tab_registry::TabRegistry;
use crate::windows::{
    focus_server_window, focused_server, open_server_windows, server_window_label, tab_of_label,
    tabbar_label,
};
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::log::line;
use agent_board_client_core::notify::{
    Click, Decision, FocusState, NotifyPolicy, NotifyRequest, Reason, Target, expiry_banner,
    route_click,
};
use agent_board_client_core::ports::Clock;
use agent_board_client_core::tabs::HOME;
use agent_board_client_core::watch::Watch;
use agent_board_client_core::zoom::{Effect, Step, Zoom};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Webview};

const TICK_SECS: u64 = 5;
const BANNER_EVENT: &str = "banner-changed";

pub struct Alerts {
    policy: Mutex<NotifyPolicy>,
    watch: Mutex<Watch>,
    zoom: Mutex<Zoom>,
    notifier: Option<Notifier>,
    background: Arc<Background>,
}

pub fn install(app: &AppHandle, state: &AppState) {
    let handle = app.clone();
    let notifier = Notifier::install(Box::new(move |server, task| {
        click(&handle, &server, task.as_deref());
    }));
    app.manage(Alerts {
        policy: Mutex::new(NotifyPolicy::new()),
        watch: Mutex::new(Watch::new()),
        zoom: Mutex::new(Zoom::new()),
        notifier,
        background: Arc::new(Background(Arc::clone(&state.secrets))),
    });
    let ticking = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            interval.tick().await;
            let sampling = ticking.clone();
            let Ok(polls) = tauri::async_runtime::spawn_blocking(move || sample(&sampling)).await
            else {
                continue;
            };
            for server in polls {
                tauri::async_runtime::spawn(poll(ticking.clone(), server));
            }
        }
    });
}

fn focus_state(app: &AppHandle) -> FocusState {
    let key_window_server = focused_server(app);
    let home_selected = key_window_server
        .and_then(|server| app.state::<TabRegistry>().view(server))
        .is_some_and(|view| view.selected == HOME);
    FocusState {
        key_window_server,
        home_selected,
    }
}

pub fn raise(app: &AppHandle, request: &NotifyRequest) {
    let alerts = app.state::<Alerts>();
    let Some(notifier) = &alerts.notifier else {
        return;
    };
    let decision = alerts.policy.lock().unwrap().decide(
        request,
        focus_state(app),
        notifier.permission(),
        SystemClock.now_secs(),
    );
    match decision {
        Decision::Raise {
            title,
            subtitle,
            user_info,
            ask_permission,
        } => notifier.raise(&title, &subtitle, &user_info, ask_permission),
        Decision::Suppress(Reason::PermissionDenied { log: Some(event) }) => {
            eprintln!("{}", line(request.server(), event));
        }
        Decision::Suppress(_) => {}
    }
}

fn click(app: &AppHandle, server_id: &str, task_id: Option<&str>) {
    let open = open_server_windows(app);
    let Click::Focus { server, tab } = route_click(server_id, task_id, |id| open.contains(&id))
    else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = focus_server_window(&app, server);
        dispatch(&app, server, move |tabs| match tab {
            Target::Task(id) => tabs.open(&format!("/tasks/{id}")),
            Target::Home => tabs.select(HOME),
        });
    });
}

pub fn heartbeat(app: &AppHandle, server: ServerId) {
    app.state::<Alerts>()
        .watch
        .lock()
        .unwrap()
        .heartbeat(server, SystemClock.now_secs());
}

fn sample(app: &AppHandle) -> Vec<ServerId> {
    let alerts = app.state::<Alerts>();
    if let Some(notifier) = &alerts.notifier {
        notifier.refresh();
    }
    let now = SystemClock.now_secs();
    let hidden: Vec<(ServerId, bool)> = open_server_windows(app)
        .into_iter()
        .filter_map(|server| {
            let window = app.get_window(&server_window_label(server))?;
            let hidden =
                window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true);
            Some((server, hidden))
        })
        .collect();
    let mut watch = alerts.watch.lock().unwrap();
    for (server, hidden) in hidden {
        watch.set_hidden(server, hidden, now);
    }
    let tick = watch.tick(now);
    for (server, event) in tick.logs {
        eprintln!("{}", line(server, event));
    }
    tick.polls
}

async fn poll(app: AppHandle, server: ServerId) {
    let state = app.state::<Arc<AppState>>();
    let alerts = app.state::<Alerts>();
    let Some(entry) = state.bridge.servers().get(server) else {
        return;
    };
    let expiry = ExpiryWatch::begin(&state, &server.to_string());
    let outcome = state.bridge.attention(server, &alerts.background).await;
    expiry.finish(&app, &state);
    let Ok(ids) = outcome else {
        return;
    };
    let requests = alerts
        .watch
        .lock()
        .unwrap()
        .observe(server, &entry.name, &ids);
    for request in &requests {
        raise(&app, request);
    }
}

pub struct ExpiryWatch {
    server: Option<ServerId>,
    before: bool,
}

impl ExpiryWatch {
    pub fn begin(state: &AppState, server_id: &str) -> Self {
        let server = ServerId::parse(server_id).ok();
        Self {
            server,
            before: server.is_some_and(|server| state.bridge.is_expired(server)),
        }
    }

    pub fn finish(self, app: &AppHandle, state: &AppState) {
        let Some(server) = self.server else {
            return;
        };
        let after = state.bridge.is_expired(server);
        if after != self.before {
            let _ = app.emit_to(
                EventTarget::Webview {
                    label: tabbar_label(server),
                },
                BANNER_EVENT,
                expiry_banner(server, after).text,
            );
        }
    }
}

pub fn zoom(app: &AppHandle, step: Step) {
    let Some(server) = focused_server(app) else {
        return;
    };
    let effect = app
        .state::<Alerts>()
        .zoom
        .lock()
        .unwrap()
        .apply(server, step);
    if let Some(Effect::Zoom { server, factor }) = effect {
        for (label, webview) in app.webviews() {
            if tab_of_label(&label).is_some_and(|(owner, _)| owner == server) {
                let _ = webview.set_zoom(factor);
            }
        }
    }
}

pub fn apply_zoom(app: &AppHandle, server: ServerId, webview: &Webview) {
    let factor = app.state::<Alerts>().zoom.lock().unwrap().factor(server);
    if factor != 1.0 {
        let _ = webview.set_zoom(factor);
    }
}

pub fn forget(app: &AppHandle, server: ServerId) {
    let alerts = app.state::<Alerts>();
    alerts.zoom.lock().unwrap().forget(server);
    alerts.watch.lock().unwrap().forget(server);
}
