mod alerts;
mod app;
mod clock;
mod commands;
mod confirm;
mod fetches;
mod handover;
mod keychain;
mod links;
mod menu;
mod notifications;
mod removals;
mod server_tabs;
mod state;
mod tab_registry;
mod webkit;
mod windows;

fn main() {
    app::run();
}
