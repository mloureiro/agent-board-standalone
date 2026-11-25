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
mod state;
mod windows;

fn main() {
    app::run();
}
