use std::fs::{self, OpenOptions};
use std::io;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use crate::durations::Durations;
use crate::health;
use crate::log_file::{AppLog, LogFile};
use crate::orphans;
use crate::process_group::{group_of, spawn_in_own_group};
use crate::spec::ChildSpec;
use crate::status::{GaveUp, Row, RowState, Status};
use crate::stop::{Outcome, stop_child};

#[derive(Debug, Clone)]
pub struct Plan {
    pub api: Result<ChildSpec, String>,
    pub worker: Option<ChildSpec>,
    pub durations: Durations,
    pub run_dir: std::path::PathBuf,
}

pub type StatusSink = Arc<dyn Fn(&Status) + Send + Sync>;

enum Message {
    Stop,
    RestartApi,
}

struct Shared {
    status: Mutex<Status>,
    held: AtomicBool,
}

pub struct Supervisor {
    commands: Sender<Message>,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Supervisor {
    pub fn start(plan: Plan, log: AppLog, sink: StatusSink) -> Supervisor {
        let shared = Arc::new(Shared {
            status: Mutex::new(Status::initial()),
            held: AtomicBool::new(false),
        });
        let (commands, inbox) = mpsc::channel();
        let supervision = Loop::new(plan, log, sink, Arc::clone(&shared), inbox);
        *shared.status.lock().unwrap() = supervision.snapshot();
        let thread = thread::spawn(move || supervision.run());
        Supervisor {
            commands,
            shared,
            thread: Some(thread),
        }
    }

    pub fn status(&self) -> Status {
        self.shared.status.lock().unwrap().clone()
    }

    pub fn restart_server(&self) {
        let _ = self.commands.send(Message::RestartApi);
    }

    pub fn set_hold(&self, held: bool) {
        self.shared.held.store(held, Ordering::SeqCst);
    }

    pub fn stop(mut self) -> Status {
        self.shutdown();
        self.status()
    }

    fn shutdown(&mut self) {
        let _ = self.commands.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Live {
    child: Child,
    group: i32,
    started: Instant,
    healthy_since: Option<Instant>,
    stable: bool,
    misses: u32,
    next_probe: Instant,
    probe: Option<Receiver<bool>>,
}

enum Phase {
    Pending,
    Live(Box<Live>),
    Waiting(Instant),
    GaveUp,
    Unavailable(String),
    Stopped,
}

pub(crate) struct Node {
    pub(crate) spec: ChildSpec,
    phase: Phase,
    crashes: u32,
}

impl Node {
    pub(crate) fn signal(&self, signal: i32) {
        if let Phase::Live(live) = &self.phase {
            let _ = crate::process_group::signal_group(live.group, signal);
        }
    }

    pub(crate) fn exited(&self) -> bool {
        match &self.phase {
            Phase::Live(live) => !crate::process_group::group_is_alive(live.group),
            _ => true,
        }
    }

    pub(crate) fn gave_up(&self) -> bool {
        matches!(self.phase, Phase::GaveUp)
    }

    pub(crate) fn waiting(&self) -> bool {
        matches!(self.phase, Phase::Waiting(_))
    }

    fn ready(&self) -> bool {
        match &self.phase {
            Phase::Live(live) => self.spec.health_port.is_none() || live.healthy_since.is_some(),
            _ => false,
        }
    }
}

struct Loop {
    api: Result<Node, String>,
    worker: Option<Node>,
    durations: Durations,
    run_dir: std::path::PathBuf,
    log: AppLog,
    sink: StatusSink,
    shared: Arc<Shared>,
    inbox: Receiver<Message>,
    stopping: bool,
}

pub(crate) fn node(spec: ChildSpec) -> Node {
    Node {
        spec,
        phase: Phase::Pending,
        crashes: 0,
    }
}

impl Loop {
    fn new(
        plan: Plan,
        log: AppLog,
        sink: StatusSink,
        shared: Arc<Shared>,
        inbox: Receiver<Message>,
    ) -> Loop {
        Loop {
            api: plan.api.map(node),
            worker: plan.worker.map(node),
            durations: plan.durations,
            run_dir: plan.run_dir,
            log,
            sink,
            shared,
            inbox,
            stopping: false,
        }
    }

    fn run(mut self) {
        let grace = self.durations.stop_grace;
        let tick = self.durations.tick;
        let log = self.log.clone();
        orphans::sweep(&self.run_dir, grace, tick, &|line| log.info(line));
        self.publish();
        loop {
            match self.inbox.recv_timeout(self.durations.tick) {
                Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Message::RestartApi) => self.restart_api(),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.advance();
            self.publish();
        }
        self.stopping = true;
        self.publish();
        self.stop_all();
        self.publish();
    }

    fn advance(&mut self) {
        if let Ok(api) = self.api.as_mut() {
            advance_node(
                api,
                true,
                &self.durations,
                &self.run_dir,
                &self.log,
                &self.shared.held,
            );
        }
        if let Some(worker) = self.worker.as_mut() {
            let gate = self.api.as_ref().is_ok_and(Node::ready);
            advance_node(
                worker,
                gate,
                &self.durations,
                &self.run_dir,
                &self.log,
                &self.shared.held,
            );
        }
    }

    fn restart_api(&mut self) {
        let Ok(api) = self.api.as_mut() else { return };
        self.log.info("restart-server requested");
        stop_node(api, &self.durations, &self.run_dir, &self.log);
        api.crashes = 0;
        api.phase = Phase::Pending;
    }

    fn stop_all(&mut self) {
        if let Some(worker) = self.worker.as_mut() {
            stop_node(worker, &self.durations, &self.run_dir, &self.log);
        }
        if let Ok(api) = self.api.as_mut() {
            stop_node(api, &self.durations, &self.run_dir, &self.log);
        }
    }

    fn publish(&self) {
        let status = self.snapshot();
        let mut current = self.shared.status.lock().unwrap();
        if *current != status {
            *current = status.clone();
            drop(current);
            (self.sink)(&status);
        }
    }

    fn snapshot(&self) -> Status {
        let api = match &self.api {
            Ok(api) => row(
                api,
                self.durations.restart_delays.len() as u32,
                self.stopping,
            ),
            Err(message) => Row::new(RowState::Failed, message.clone()),
        };
        let worker = match &self.worker {
            Some(worker) => row(
                worker,
                self.durations.restart_delays.len() as u32,
                self.stopping,
            ),
            None => Row::new(RowState::Off, "Not set up"),
        };
        Status {
            api,
            worker,
            gave_up: GaveUp {
                api: matches!(&self.api, Ok(n) if matches!(n.phase, Phase::GaveUp)),
                worker: matches!(&self.worker, Some(n) if matches!(n.phase, Phase::GaveUp)),
            },
            blocked: None,
        }
    }
}

pub(crate) fn row(node: &Node, retries: u32, stopping: bool) -> Row {
    match &node.phase {
        Phase::Pending => Row::new(RowState::Starting, "Starting"),
        Phase::Live(_) if stopping => Row::new(RowState::Stopping, "Stopping"),
        Phase::Live(_) if node.ready() => Row::new(RowState::Running, "Running"),
        Phase::Live(_) => Row::new(RowState::Starting, "Starting"),
        Phase::Waiting(_) => Row::new(
            RowState::Restarting,
            format!("Restarting after crash {} of {retries}", node.crashes),
        ),
        Phase::GaveUp => Row::new(
            RowState::GaveUp,
            format!("Gave up after {} crashes", node.crashes),
        ),
        Phase::Unavailable(message) => Row::new(RowState::Failed, message.clone()),
        Phase::Stopped => Row::new(RowState::Stopped, "Stopped"),
    }
}

fn open_log(spec: &ChildSpec) -> io::Result<std::fs::File> {
    if let Some(parent) = spec.log.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = LogFile::new(spec.log.clone()).rotate_if_full();
    OpenOptions::new().create(true).append(true).open(&spec.log)
}

pub(crate) fn spawn(spec: &ChildSpec) -> io::Result<Child> {
    let log = open_log(spec)?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    spawn_in_own_group(&mut command)
}

fn start_node(node: &mut Node, durations: &Durations, run_dir: &std::path::Path, log: &AppLog) {
    if let Some(port) = node.spec.health_port
        && health::port_in_use(port)
    {
        let message = format!("Port {port} in use; change port in settings.json");
        log.error(&format!("{}: {message}", node.spec.name));
        node.phase = Phase::Unavailable(message);
        return;
    }
    let _ = fs::create_dir_all(run_dir);
    if node.spec.name == "api" {
        let _ = fs::remove_file(run_dir.join("api.sock"));
    }
    match spawn(&node.spec) {
        Ok(child) => {
            let pid = child.id();
            let group = group_of(pid).unwrap_or(pid as i32);
            orphans::write_pid_file(run_dir, &node.spec.name, pid, &node.spec.program);
            log.info(&format!("{} started, pid {pid}", node.spec.name));
            let now = Instant::now();
            node.phase = Phase::Live(Box::new(Live {
                child,
                group,
                started: now,
                healthy_since: None,
                stable: false,
                misses: 0,
                next_probe: now + durations.startup_probe_interval,
                probe: None,
            }));
        }
        Err(error) => {
            log.error(&format!("{} could not start: {error}", node.spec.name));
            register_crash(node, durations);
        }
    }
}

fn register_crash(node: &mut Node, durations: &Durations) {
    node.crashes += 1;
    node.phase = match durations.restart_delays.get(node.crashes as usize - 1) {
        Some(delay) => Phase::Waiting(Instant::now() + *delay),
        None => Phase::GaveUp,
    };
}

fn crash(
    node: &mut Node,
    reason: &str,
    durations: &Durations,
    run_dir: &std::path::Path,
    log: &AppLog,
) {
    if let Phase::Live(live) = &mut node.phase {
        stop_child(
            &mut live.child,
            live.group,
            durations.stop_grace,
            durations.tick,
        );
    }
    orphans::remove_pid_file(run_dir, &node.spec.name);
    register_crash(node, durations);
    match node.phase {
        Phase::GaveUp => log.error(&format!(
            "{} {reason}; gave up after {} crashes",
            node.spec.name, node.crashes
        )),
        _ => log.error(&format!(
            "{} {reason}; crash {} will restart",
            node.spec.name, node.crashes
        )),
    }
}

pub(crate) fn stop_node(
    node: &mut Node,
    durations: &Durations,
    run_dir: &std::path::Path,
    log: &AppLog,
) {
    if let Phase::Live(live) = &mut node.phase {
        let outcome = stop_child(
            &mut live.child,
            live.group,
            durations.stop_grace,
            durations.tick,
        );
        match outcome {
            Outcome::Graceful => log.info(&format!("{} stopped", node.spec.name)),
            Outcome::Killed => {
                log.info(&format!("{} killed after the grace period", node.spec.name))
            }
        }
    }
    orphans::remove_pid_file(run_dir, &node.spec.name);
    node.phase = Phase::Stopped;
}

pub(crate) fn advance_node(
    node: &mut Node,
    gate_open: bool,
    durations: &Durations,
    run_dir: &std::path::Path,
    log: &AppLog,
    held: &AtomicBool,
) {
    let now = Instant::now();
    match &mut node.phase {
        Phase::Pending if gate_open => start_node(node, durations, run_dir, log),
        Phase::Waiting(until) if now >= *until => start_node(node, durations, run_dir, log),
        Phase::Live(live) => {
            if let Ok(Some(status)) = live.child.try_wait() {
                crash(
                    node,
                    &format!("exited with {status}"),
                    durations,
                    run_dir,
                    log,
                );
                return;
            }
            if !live.stable
                && let Some(since) =
                    live.healthy_since
                        .or(node.spec.health_port.is_none().then_some(live.started))
                && now.duration_since(since) >= durations.stable_reset
            {
                live.stable = true;
                node.crashes = 0;
            }
            let Some(port) = node.spec.health_port else {
                return;
            };
            if held.load(Ordering::SeqCst) {
                live.probe = None;
                live.misses = 0;
                live.next_probe = now + durations.probe_interval;
                return;
            }
            let verdict = match live.probe.as_ref().map(Receiver::try_recv) {
                Some(Ok(answer)) => Some(answer),
                Some(Err(mpsc::TryRecvError::Disconnected)) => Some(false),
                Some(Err(mpsc::TryRecvError::Empty)) => return,
                None => None,
            };
            match verdict {
                Some(true) => {
                    live.probe = None;
                    live.misses = 0;
                    if live.healthy_since.is_none() {
                        live.healthy_since = Some(now);
                        log.info(&format!("{} is healthy", node.spec.name));
                    }
                }
                Some(false) => {
                    live.probe = None;
                    if live.healthy_since.is_some() {
                        live.misses += 1;
                        if live.misses >= durations.probe_misses {
                            crash(node, "missed its health probes", durations, run_dir, log);
                        }
                    } else if now.duration_since(live.started) >= durations.startup_deadline {
                        crash(node, "never became healthy", durations, run_dir, log);
                    }
                }
                None => {}
            }
            if let Phase::Live(live) = &mut node.phase
                && live.probe.is_none()
                && now >= live.next_probe
            {
                let interval = if live.healthy_since.is_some() {
                    durations.probe_interval
                } else {
                    durations.startup_probe_interval
                };
                live.next_probe = now + interval;
                let (answer, receiver) = mpsc::channel();
                let timeout = durations.probe_timeout;
                thread::spawn(move || {
                    let _ = answer.send(health::probe(port, timeout));
                });
                live.probe = Some(receiver);
            }
        }
        _ => {}
    }
}
