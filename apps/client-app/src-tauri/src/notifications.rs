use agent_board_client_core::notify::{Permission, UserInfo};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

const UNKNOWN: u8 = 0;
const GRANTED: u8 = 1;
const DENIED: u8 = 2;
const SERVER_KEY: &str = "serverId";
const TASK_KEY: &str = "taskId";

type Clicked = Box<dyn Fn(String, Option<String>) + Send + Sync>;

struct Handler(Clicked);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AgentBoardNotificationDelegate"]
    #[ivars = Handler]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let info = response.notification().request().content().userInfo();
            if let Some(server) = string_for(&info, SERVER_KEY) {
                (self.ivars().0)(server, string_for(&info, TASK_KEY));
            }
            completion.call(());
        }
    }
);

impl Delegate {
    fn new(clicked: Clicked) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Handler(clicked));
        unsafe { msg_send![super(this), init] }
    }
}

fn string_for(info: &NSDictionary, key: &str) -> Option<String> {
    let key = NSString::from_str(key);
    let key: &AnyObject = &key;
    let value = info.objectForKey(key)?;
    let value = value.downcast::<NSString>().ok()?;
    Some(value.to_string())
}

fn user_info_dictionary(info: &UserInfo) -> Retained<NSDictionary> {
    let mut keys = vec![NSString::from_str(SERVER_KEY)];
    let mut values = vec![NSString::from_str(&info.server_id)];
    if let Some(task) = &info.task_id {
        keys.push(NSString::from_str(TASK_KEY));
        values.push(NSString::from_str(task));
    }
    let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
    let dictionary = NSDictionary::from_retained_objects(&key_refs, &values);
    unsafe { Retained::cast_unchecked(dictionary) }
}

struct Center(Retained<UNUserNotificationCenter>);

unsafe impl Send for Center {}
unsafe impl Sync for Center {}

struct Held(#[allow(dead_code)] Retained<Delegate>);

unsafe impl Send for Held {}
unsafe impl Sync for Held {}

pub struct Notifier {
    center: Arc<Center>,
    permission: Arc<AtomicU8>,
    _delegate: Held,
}

fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

fn store(permission: &AtomicU8, status: UNAuthorizationStatus) {
    let known = if status == UNAuthorizationStatus::NotDetermined {
        UNKNOWN
    } else if status == UNAuthorizationStatus::Denied {
        DENIED
    } else {
        GRANTED
    };
    permission.store(known, Ordering::SeqCst);
}

impl Notifier {
    pub fn install(clicked: Clicked) -> Option<Self> {
        if !bundled() {
            return None;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = Delegate::new(clicked);
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let permission = Arc::new(AtomicU8::new(UNKNOWN));
        let observed = Arc::clone(&permission);
        let settings = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            store(
                &observed,
                unsafe { settings.as_ref() }.authorizationStatus(),
            );
        });
        center.getNotificationSettingsWithCompletionHandler(&settings);
        Some(Self {
            center: Arc::new(Center(center)),
            permission,
            _delegate: Held(delegate),
        })
    }

    pub fn permission(&self) -> Permission {
        match self.permission.load(Ordering::SeqCst) {
            GRANTED => Permission::Granted,
            DENIED => Permission::Denied,
            _ => Permission::Unknown,
        }
    }

    pub fn raise(&self, title: &str, subtitle: &str, info: &UserInfo, ask_permission: bool) {
        if !ask_permission {
            add(&self.center.0, title, subtitle, info);
            return;
        }
        let center = Arc::clone(&self.center);
        let permission = Arc::clone(&self.permission);
        let (title, subtitle, info) = (title.to_owned(), subtitle.to_owned(), info.clone());
        let answered = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            permission.store(
                if granted.as_bool() { GRANTED } else { DENIED },
                Ordering::SeqCst,
            );
            if granted.as_bool() {
                add(&center.0, &title, &subtitle, &info);
            }
        });
        self.center
            .0
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &answered,
            );
    }
}

fn add(center: &UNUserNotificationCenter, title: &str, subtitle: &str, info: &UserInfo) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setSubtitle(&NSString::from_str(subtitle));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    content.setThreadIdentifier(&NSString::from_str(&info.server_id));
    unsafe { content.setUserInfo(&user_info_dictionary(info)) };
    let identifier = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    center.addNotificationRequest_withCompletionHandler(&request, None);
}
