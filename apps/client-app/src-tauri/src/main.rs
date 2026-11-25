mod app;
mod clock;
mod commands;
mod confirm;
mod fetches;
mod handover;
mod keychain;
mod legacy;
mod menu;
mod removals;
mod server_tabs;
mod state;
mod tab_registry;
mod windows;

fn main() {
    app::run();
}
