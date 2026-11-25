use crate::windows::LIST_LABEL;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

const CLOSE_LIST: &str = "close-list";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let application = Submenu::with_items(
        app,
        "Agent Board",
        true,
        &[
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&MenuItem::with_id(
            app,
            CLOSE_LIST,
            "Close List Window",
            true,
            Some("CmdOrCtrl+W"),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &file, &edit, &window],
    )?)?;
    Ok(())
}

pub fn handle(app: &AppHandle, id: &str) {
    if id != CLOSE_LIST {
        return;
    }
    if let Some(list) = app.get_webview_window(LIST_LABEL)
        && list.is_focused().unwrap_or(false)
    {
        let _ = list.close();
    }
}
