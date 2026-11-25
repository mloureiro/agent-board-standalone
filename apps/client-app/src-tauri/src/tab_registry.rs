use agent_board_client_core::ids::ServerId;
use agent_board_client_core::tab_file;
use agent_board_client_core::tabs::{Effect, PaneView, Tabs};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use url::Url;

struct Entry {
    tabs: Tabs,
    origin: Url,
}

pub struct Step {
    pub effects: Vec<Effect>,
    pub view: PaneView,
    pub file: Vec<u8>,
    pub origin: Url,
}

#[derive(Default)]
pub struct TabRegistry {
    models: Mutex<HashMap<ServerId, Entry>>,
    ordering: Mutex<()>,
}

impl TabRegistry {
    pub fn insert(&self, server: ServerId, tabs: Tabs, origin: Url) {
        self.models
            .lock()
            .unwrap()
            .insert(server, Entry { tabs, origin });
    }

    pub fn remove(&self, server: ServerId) {
        self.models.lock().unwrap().remove(&server);
    }

    pub fn view(&self, server: ServerId) -> Option<PaneView> {
        let models = self.models.lock().unwrap();
        models
            .get(&server)
            .and_then(|entry| entry.tabs.view().into_iter().next())
    }

    pub fn ordered(&self) -> MutexGuard<'_, ()> {
        self.ordering.lock().unwrap()
    }

    pub fn act(
        &self,
        server: ServerId,
        change: impl FnOnce(&mut Tabs) -> Vec<Effect>,
    ) -> Option<Step> {
        let mut models = self.models.lock().unwrap();
        let entry = models.get_mut(&server)?;
        let effects = change(&mut entry.tabs);
        Some(Step {
            effects,
            view: entry.tabs.view().into_iter().next()?,
            file: tab_file::encode(&entry.tabs),
            origin: entry.origin.clone(),
        })
    }
}
