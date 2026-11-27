use rumo_client_core::ids::ServerId;
use rumo_client_core::tab_file;
use rumo_client_core::tabs::{Effect, LayoutView, Tabs};
use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use url::Url;

type Job = Box<dyn FnOnce() + Send>;

pub struct TabQueue {
    jobs: Sender<Job>,
}

impl TabQueue {
    pub fn start() -> Self {
        let (jobs, queue) = channel::<Job>();
        thread::spawn(move || {
            for job in queue {
                job();
            }
        });
        Self { jobs }
    }

    pub fn submit(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.jobs.send(Box::new(job));
    }
}

struct Entry {
    tabs: Tabs,
    origin: Url,
}

pub struct Step {
    pub effects: Vec<Effect>,
    pub view: LayoutView,
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

    pub fn view(&self, server: ServerId) -> Option<LayoutView> {
        let models = self.models.lock().unwrap();
        models.get(&server).map(|entry| entry.tabs.layout())
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
            view: entry.tabs.layout(),
            file: tab_file::encode(&entry.tabs),
            origin: entry.origin.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn client_app_029_tab_commands_run_in_the_order_they_were_sent() {
        let queue = TabQueue::start();
        let seen = Arc::new(Mutex::new(Vec::new()));
        for number in 0..500 {
            let seen = Arc::clone(&seen);
            queue.submit(move || seen.lock().unwrap().push(number));
        }
        let (done, finished) = channel();
        queue.submit(move || done.send(()).unwrap());
        finished.recv().unwrap();
        assert_eq!(*seen.lock().unwrap(), (0..500).collect::<Vec<_>>());
    }
}
