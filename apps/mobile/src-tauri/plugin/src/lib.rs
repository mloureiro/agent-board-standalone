use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};

#[cfg(desktop)]
pub use desktop::BoardNative;
#[cfg(mobile)]
pub use mobile::BoardNative;

pub trait BoardNativeExt<R: Runtime> {
    fn board_native(&self) -> &BoardNative<R>;
}

impl<R: Runtime, T: Manager<R>> BoardNativeExt<R> for T {
    fn board_native(&self) -> &BoardNative<R> {
        self.state::<BoardNative<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("board-native")
        .setup(|app, api| {
            #[cfg(mobile)]
            let native = mobile::init(app, api)?;
            #[cfg(desktop)]
            let native = desktop::init(app, api)?;
            app.manage(native);
            Ok(())
        })
        .build()
}
