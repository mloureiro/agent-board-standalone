use std::sync::{Arc, Mutex};

use agent_board_server_core::actions::Action;
use agent_board_server_core::console::Console;
use agent_board_server_core::enrol::FormView;
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const CONNECT_LABEL: &str = "connect-worker";
const PAIR_LABEL: &str = "pair-device";
const SETUP_LABEL: &str = "set-up";
const WRONG_WINDOW: &str = "this window cannot run that command";

#[derive(Default)]
pub struct PairShown(Mutex<Option<Value>>);

fn open(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    size: (f64, f64),
) -> tauri::Result<Option<WebviewWindow>> {
    if let Some(existing) = app.get_webview_window(label) {
        existing.show()?;
        existing.set_focus()?;
        return Ok(None);
    }
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .build()?;
    window.set_focus()?;
    Ok(Some(window))
}

fn only_from(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err(WRONG_WINDOW.to_string())
    }
}

pub fn show_connect(app: &AppHandle) {
    let Ok(Some(window)) = open(
        app,
        CONNECT_LABEL,
        "connect.html",
        "Connect worker",
        (460.0, 330.0),
    ) else {
        return;
    };
    if let Some(console) = app.try_state::<Arc<Console>>() {
        let console = Arc::clone(console.inner());
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if console.form_can_close() {
                    console.form_reset();
                } else {
                    api.prevent_close();
                }
            }
        });
    }
}

pub fn show_reply(app: &AppHandle, reply: &Value) {
    let shown = reply["type"] == "pair-code" || reply["action"] == "pair-device";
    if !shown {
        return;
    }
    if let Some(state) = app.try_state::<PairShown>() {
        *state.0.lock().unwrap() = Some(reply.clone());
    }
    if let Some(existing) = app.get_webview_window(PAIR_LABEL) {
        let _ = existing.reload();
    }
    let _ = open(
        app,
        PAIR_LABEL,
        "pair.html",
        "Pair a device",
        (420.0, 260.0),
    );
}

#[tauri::command]
pub fn enrol_state(
    window: WebviewWindow,
    console: State<Arc<Console>>,
) -> Result<FormView, String> {
    only_from(&window, CONNECT_LABEL)?;
    Ok(console.form_view())
}

#[tauri::command]
pub fn enrol_set(
    window: WebviewWindow,
    console: State<Arc<Console>>,
    field: String,
    value: String,
) -> Result<FormView, String> {
    only_from(&window, CONNECT_LABEL)?;
    Ok(console.form_set(&field, &value))
}

#[tauri::command]
pub fn enrol_connect(
    window: WebviewWindow,
    console: State<Arc<Console>>,
) -> Result<FormView, String> {
    only_from(&window, CONNECT_LABEL)?;
    Ok(console.form_submit())
}

#[tauri::command]
pub fn pair_state(window: WebviewWindow, shown: State<PairShown>) -> Result<Value, String> {
    only_from(&window, PAIR_LABEL)?;
    Ok(shown
        .0
        .lock()
        .unwrap()
        .take()
        .unwrap_or_else(|| json!({ "ok": false, "message": "no pairing code was requested" })))
}

#[tauri::command]
pub fn close_self(window: WebviewWindow) {
    let _ = window.close();
}

pub fn show_setup(app: &AppHandle) {
    let _ = open(app, SETUP_LABEL, "setup.html", "Set up", (620.0, 720.0));
}

fn setup_view(console: &Console, extra: Value) -> Result<Value, String> {
    let mut view = json!({ "status": console.setup_status()? });
    if let (Some(view), Value::Object(extra)) = (view.as_object_mut(), extra) {
        view.extend(extra);
    }
    Ok(view)
}

fn restart(console: &Arc<Console>) -> Value {
    console
        .dispatch(Action::RestartServer)
        .unwrap_or_else(|| json!({ "ok": true }))
}

#[tauri::command]
pub fn setup_state(window: WebviewWindow, console: State<Arc<Console>>) -> Result<Value, String> {
    only_from(&window, SETUP_LABEL)?;
    setup_view(&console, json!({}))
}

#[tauri::command]
pub fn setup_remote(
    window: WebviewWindow,
    console: State<Arc<Console>>,
    public_url: Option<String>,
) -> Result<Value, String> {
    only_from(&window, SETUP_LABEL)?;
    match public_url {
        Some(public_url) => console.setup().remote_on(&public_url)?,
        None => console.setup().remote_off()?,
    };
    let restarted = restart(&console);
    setup_view(&console, json!({ "restart": restarted }))
}

#[tauri::command]
pub fn setup_first_passkey(
    window: WebviewWindow,
    console: State<Arc<Console>>,
) -> Result<Value, String> {
    only_from(&window, SETUP_LABEL)?;
    let opened = console.setup().first_passkey_open()?;
    let restarted = restart(&console);
    let browser = console.open_in_browser(&opened.sign_up_url).err();
    setup_view(
        &console,
        json!({
            "restart": restarted,
            "signUpUrl": opened.sign_up_url,
            "userName": opened.user_name,
            "token": opened.token,
            "browserFailure": browser,
        }),
    )
}

#[tauri::command]
pub fn setup_first_passkey_done(
    window: WebviewWindow,
    console: State<Arc<Console>>,
) -> Result<Value, String> {
    only_from(&window, SETUP_LABEL)?;
    console.setup().first_passkey_close()?;
    let restarted = restart(&console);
    setup_view(&console, json!({ "restart": restarted }))
}

#[tauri::command]
pub fn setup_connect_worker(
    app: AppHandle,
    window: WebviewWindow,
    console: State<Arc<Console>>,
) -> Result<(), String> {
    only_from(&window, SETUP_LABEL)?;
    if console.may_open_connect() {
        show_connect(&app);
        Ok(())
    } else {
        Err("Connect worker needs the API running".to_string())
    }
}
