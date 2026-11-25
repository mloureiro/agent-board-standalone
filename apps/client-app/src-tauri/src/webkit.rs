use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{msg_send, sel};
use tauri::Webview;

pub fn disable_backspace_navigation(webview: &Webview) {
    let _ = webview.with_webview(|platform| {
        let view = platform.inner().cast::<AnyObject>();
        if view.is_null() {
            return;
        }
        unsafe {
            let configuration: Option<Retained<AnyObject>> = msg_send![&*view, configuration];
            let preferences: Option<Retained<AnyObject>> = configuration
                .as_ref()
                .and_then(|configuration| msg_send![&**configuration, preferences]);
            let Some(preferences) = preferences else {
                return;
            };
            let setter = sel!(_setBackspaceKeyNavigationEnabled:);
            let supported: Bool = msg_send![&*preferences, respondsToSelector: setter];
            if supported.as_bool() {
                let _: () = msg_send![&*preferences, _setBackspaceKeyNavigationEnabled: Bool::NO];
            }
        }
    });
}
