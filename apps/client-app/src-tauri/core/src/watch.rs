use crate::attention::AttentionPoller;
use crate::ids::ServerId;
use crate::log::LogEvent;
use crate::notify::NotifyRequest;
use crate::throttle::{Change, State, Throttle};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tick {
    pub logs: Vec<(ServerId, LogEvent)>,
    pub polls: Vec<ServerId>,
}

#[derive(Default)]
pub struct Watch {
    throttle: Throttle,
    poller: AttentionPoller,
}

impl Watch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_polling(&self, server: ServerId) -> bool {
        self.poller.is_polling(server)
    }

    pub fn set_hidden(&mut self, server: ServerId, hidden: bool, now_secs: u64) {
        let change = self.throttle.set_hidden(server, hidden, now_secs);
        self.follow(change);
    }

    pub fn heartbeat(&mut self, server: ServerId, now_secs: u64) {
        let change = self.throttle.heartbeat(server, now_secs);
        self.follow(change);
    }

    pub fn tick(&mut self, now_secs: u64) -> Tick {
        let mut logs = Vec::new();
        for change in self.throttle.tick(now_secs) {
            self.poller.start(change.server, now_secs);
            logs.push((change.server, LogEvent::Throttled));
        }
        Tick {
            logs,
            polls: self.poller.due(now_secs),
        }
    }

    pub fn observe(
        &mut self,
        server: ServerId,
        server_name: &str,
        ids: &[String],
    ) -> Vec<NotifyRequest> {
        self.poller.observe(server, server_name, ids)
    }

    pub fn forget(&mut self, server: ServerId) {
        self.throttle.forget(server);
        self.poller.stop(server);
    }

    fn follow(&mut self, change: Option<Change>) {
        if let Some(Change {
            server,
            state: State::Live,
        }) = change
        {
            self.poller.stop(server);
        }
    }
}
