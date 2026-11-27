use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
use objc2_foundation::NSString;
use rumo_client_core::ports::Confirm;
use std::sync::mpsc;
use tauri::AppHandle;

pub struct NativeConfirm {
    app: AppHandle,
}

impl NativeConfirm {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn ask(message: &str) -> bool {
    let Some(thread) = MainThreadMarker::new() else {
        return false;
    };
    let alert = NSAlert::new(thread);
    alert.setMessageText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str("OK"));
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    alert.runModal() == NSAlertFirstButtonReturn
}

impl Confirm for NativeConfirm {
    fn confirm(&self, message: &str) -> bool {
        let (sender, receiver) = mpsc::channel();
        let message = message.to_owned();
        let scheduled = self.app.run_on_main_thread(move || {
            let _ = sender.send(ask(&message));
        });
        scheduled.is_ok() && receiver.recv().unwrap_or(false)
    }
}
