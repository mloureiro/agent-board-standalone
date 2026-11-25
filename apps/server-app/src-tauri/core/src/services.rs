use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::app::Running;
use crate::cli_run::ProcessCli;
use crate::status::{RowState, Status};
use crate::supervisor::Supervisor;
use crate::worker::{Notify, Worker};

pub struct Services {
    supervisor: Supervisor,
    pub worker: Worker,
}

impl Services {
    pub fn start(running: &Running, notify: Notify) -> Services {
        let api_up = Arc::new(AtomicBool::new(false));
        let sink_up = Arc::clone(&api_up);
        let sink_notify = Arc::clone(&notify);
        let supervisor = Supervisor::start_gated(
            running.plan.clone(),
            running.api_gate.clone(),
            running.app_log.clone(),
            Arc::new(move |status: &Status| {
                sink_up.store(status.api.state == RowState::Running, Ordering::SeqCst);
                sink_notify();
            }),
        );
        let setup = Arc::new(running.worker.clone());
        let worker = Worker::start(
            Arc::clone(&setup),
            Arc::new(ProcessCli::new(setup)),
            Arc::new(move || api_up.load(Ordering::SeqCst)),
            notify,
        );
        Services { supervisor, worker }
    }

    pub fn supervisor(&self) -> &Supervisor {
        &self.supervisor
    }

    pub fn status(&self) -> Status {
        self.worker.merge(self.supervisor.status())
    }

    pub fn stop(mut self) -> Status {
        self.worker.shutdown();
        let last = self.supervisor.stop();
        self.worker.merge(last)
    }
}
