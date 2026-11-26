use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_board_server_core::app::Running;
use agent_board_server_core::services::Services;
use agent_board_server_core::signals;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent};

#[cfg(target_os = "macos")]
fn hide_from_dock(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn hide_from_dock(_: &mut tauri::App) {}

struct Supervision(Mutex<Option<Services>>);

impl Supervision {
    fn stop(&self) {
        let services = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(services) = services {
            services.stop();
        }
    }
}

pub fn run(running: Running) {
    signals::install();
    let result = tauri::Builder::default()
        .setup(move |app| {
            hide_from_dock(app);
            let title = MenuItemBuilder::with_id("title", "Agent Board Server")
                .enabled(false)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&title, &quit]).build()?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Agent Board Server")
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            running.app_log.info("tray ready");
            let services = Services::start(&running, Arc::new(|| {}));
            app.manage(Supervision(Mutex::new(Some(services))));
            app.manage(running);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    if let Some(signal) = signals::received() {
                        if let Some(running) = handle.try_state::<Running>() {
                            running
                                .app_log
                                .info(&format!("{} received, quitting", signals::name(signal)));
                        }
                        handle.exit(0);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event
                && let Some(supervision) = handle.try_state::<Supervision>()
            {
                supervision.stop();
            }
        }),
        Err(error) => eprintln!("{error}"),
    }
}
