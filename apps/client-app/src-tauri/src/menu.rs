use crate::alerts;
use crate::server_tabs::dispatch;
use crate::windows::{LIST_LABEL, focused_server};
use rumo_client_core::keybindings::Keybindings;
use rumo_client_core::shortcuts::{
    Action, MENU_CLOSE_PANE, MENU_CLOSE_TAB, MENU_FOCUS_NEXT_PANE, MENU_MOVE_TAB, MENU_NEXT_TAB,
    MENU_PREVIOUS_TAB, MENU_SPLIT_TAB, from_menu_id, menu_select_id,
};
use rumo_client_core::zoom::{
    self, MENU_ZOOM_IN, MENU_ZOOM_IN_SHIFTED, MENU_ZOOM_OUT, MENU_ZOOM_RESET,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

pub fn install(app: &AppHandle, keys: &Keybindings) -> tauri::Result<()> {
    let application = Submenu::with_items(
        app,
        "Rumo",
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
            MENU_CLOSE_TAB,
            "Close Tab",
            true,
            keys.accelerator(MENU_CLOSE_TAB),
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
    let tabs = tabs_menu(app, keys)?;
    let view = view_menu(app)?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &file, &edit, &view, &tabs, &window],
    )?)?;
    Ok(())
}

fn view_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, MENU_ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(
                app,
                MENU_ZOOM_IN_SHIFTED,
                "Zoom In",
                true,
                Some("CmdOrCtrl+Shift+="),
            )?,
            &MenuItem::with_id(app, MENU_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(
                app,
                MENU_ZOOM_RESET,
                "Actual Size",
                true,
                Some("CmdOrCtrl+0"),
            )?,
        ],
    )
}

fn tabs_menu(app: &AppHandle, keys: &Keybindings) -> tauri::Result<Submenu<tauri::Wry>> {
    let tabs = Submenu::new(app, "Tabs", true)?;
    let item =
        |id: &str, title: &str| MenuItem::with_id(app, id, title, true, keys.accelerator(id));
    tabs.append(&item(MENU_NEXT_TAB, "Next Tab")?)?;
    tabs.append(&item(MENU_PREVIOUS_TAB, "Previous Tab")?)?;
    tabs.append(&PredefinedMenuItem::separator(app)?)?;
    for position in 1..=9 {
        tabs.append(&item(
            &menu_select_id(position),
            &format!("Select Tab {position}"),
        )?)?;
    }
    tabs.append(&PredefinedMenuItem::separator(app)?)?;
    tabs.append(&item(MENU_SPLIT_TAB, "Split Tab")?)?;
    tabs.append(&item(MENU_MOVE_TAB, "Move Tab to Next Pane")?)?;
    tabs.append(&item(MENU_FOCUS_NEXT_PANE, "Focus Next Pane")?)?;
    tabs.append(&item(MENU_CLOSE_PANE, "Close Pane")?)?;
    Ok(tabs)
}

pub fn handle(app: &AppHandle, id: &str) {
    if let Some(step) = zoom::from_menu_id(id) {
        alerts::zoom(app, step);
        return;
    }
    let Some(action) = from_menu_id(id) else {
        return;
    };
    if action == Action::CloseTab
        && let Some(list) = app.get_webview_window(LIST_LABEL)
        && list.is_focused().unwrap_or(false)
    {
        let _ = list.close();
        return;
    }
    if let Some(server) = focused_server(app) {
        dispatch(app, server, move |tabs| tabs.apply(action));
    }
}
