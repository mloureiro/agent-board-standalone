use crate::server_tabs::dispatch;
use crate::tab_registry::TabRegistry;
use crate::windows;
use agent_board_client_core::ids::ServerId;
use agent_board_client_core::page_input::{self, TabIntent};
use agent_board_client_core::tabs::{Effect, HOME, LayoutView, TabId, Tabs};
use tauri::{AppHandle, State, Webview};

const UNKNOWN: &str = "unknown server";

fn input(error: page_input::InputError) -> String {
    error.message().to_owned()
}

fn server_of(webview: &Webview) -> Result<ServerId, String> {
    windows::server_of_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())
}

pub fn navigate(tabs: &mut Tabs, tab: TabId, intent: TabIntent, path: &str) -> Vec<Effect> {
    match intent {
        TabIntent::New => tabs.open(path),
        TabIntent::Open if tab != HOME => tabs.open(path),
        TabIntent::Open | TabIntent::Route => tabs.route(tab, path),
    }
}

#[tauri::command]
pub async fn tabs_snapshot(
    webview: Webview,
    registry: State<'_, TabRegistry>,
) -> Result<LayoutView, String> {
    registry
        .view(server_of(&webview)?)
        .ok_or_else(|| UNKNOWN.to_owned())
}

#[tauri::command]
pub async fn tab_select(app: AppHandle, webview: Webview, tab: TabId) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| tabs.select(tab));
    Ok(())
}

#[tauri::command]
pub async fn tab_close(app: AppHandle, webview: Webview, tab: TabId) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| tabs.close(tab));
    Ok(())
}

#[tauri::command]
pub async fn tab_cycle(app: AppHandle, webview: Webview, dir: String) -> Result<(), String> {
    let next = page_input::tab_direction(&dir).map_err(input)?;
    dispatch(&app, server_of(&webview)?, move |tabs| tabs.cycle(next));
    Ok(())
}

#[tauri::command]
pub async fn tab_split(app: AppHandle, webview: Webview) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, Tabs::split_tab);
    Ok(())
}

#[tauri::command]
pub async fn tab_move(
    app: AppHandle,
    webview: Webview,
    tab: TabId,
    pane: usize,
) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| {
        tabs.move_tab(tab, pane)
    });
    Ok(())
}

#[tauri::command]
pub async fn pane_close(app: AppHandle, webview: Webview, pane: usize) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| {
        tabs.close_pane(pane)
    });
    Ok(())
}

#[tauri::command]
pub async fn pane_focus(app: AppHandle, webview: Webview, pane: usize) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| {
        tabs.focus_pane(pane)
    });
    Ok(())
}

#[tauri::command]
pub async fn split_resize(
    app: AppHandle,
    webview: Webview,
    index: usize,
    ratio: f64,
    commit: bool,
) -> Result<(), String> {
    dispatch(&app, server_of(&webview)?, move |tabs| {
        tabs.resize(index, ratio, commit)
    });
    Ok(())
}

#[tauri::command]
pub async fn tab_focused(app: AppHandle, webview: Webview) -> Result<(), String> {
    let (server, tab) = windows::tab_of_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())?;
    dispatch(&app, server, move |tabs| tabs.focus_tab(tab));
    Ok(())
}

#[tauri::command]
pub async fn tab_navigate(
    app: AppHandle,
    webview: Webview,
    path: String,
    intent: String,
) -> Result<(), String> {
    let (server, tab) = windows::tab_of_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())?;
    let path = page_input::tab_path(&path).map_err(input)?;
    let intent = page_input::tab_intent(&intent).map_err(input)?;
    dispatch(&app, server, move |tabs| navigate(tabs, tab, intent, &path));
    Ok(())
}

#[tauri::command]
pub async fn tab_title(app: AppHandle, webview: Webview, title: String) -> Result<(), String> {
    let (server, tab) = windows::tab_of_label(webview.label()).ok_or_else(|| UNKNOWN.to_owned())?;
    let title = page_input::tab_title(&title).map_err(input)?;
    dispatch(&app, server, move |tabs| tabs.title(tab, &title));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_pages() -> Tabs {
        let mut tabs = Tabs::new();
        tabs.open("/backlog");
        tabs.open("/tasks/t-1");
        tabs
    }

    #[test]
    fn client_app_018_open_from_home_routes_home_and_from_a_tab_opens_a_new_one() {
        let mut tabs = Tabs::new();
        let effects = navigate(&mut tabs, HOME, TabIntent::Open, "/schedules");
        assert_eq!(
            effects[0],
            Effect::Navigate {
                tab: HOME,
                path: "/".to_owned()
            }
        );
        assert_eq!(tabs.tabs().len(), 2);

        let mut tabs = with_pages();
        navigate(&mut tabs, 1, TabIntent::Open, "/closed");
        assert_eq!(tabs.tabs().len(), 4);
        navigate(&mut tabs, 1, TabIntent::New, "/settings");
        assert_eq!(tabs.tabs().len(), 5);
    }

    #[test]
    fn client_app_019_route_from_a_tab_stays_in_that_tab() {
        let mut tabs = with_pages();
        navigate(&mut tabs, 2, TabIntent::Route, "/schedules");
        assert_eq!(tabs.tabs().len(), 3);
        assert_eq!(tabs.tabs()[2].path, "/schedules");
    }
}
