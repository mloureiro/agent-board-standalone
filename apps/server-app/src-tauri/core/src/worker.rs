use std::fs;
use std::process::Child;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, sleep};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cli_run::WorkerCli;
use crate::cli_wrapper;
use crate::credential_flow::read_pair;
use crate::enrol::{self, Lifecycle};
use crate::orphans;
use crate::process_group::{group_of, signal_group};
use crate::recipe::{Command, Recipe};
use crate::redact::redact;
use crate::spec::ChildSpec;
use crate::status::{Row, RowState, Status};
use crate::stop::stop_child;
use crate::supervisor::{self, Node};
use crate::worker_setup::WorkerSetup;

pub const NOT_CONNECTED: &str = "Worker not connected";
const MAX_MESSAGE: usize = 200;
const DISPATCH: &str = "worker-dispatch";

pub type Notify = Arc<dyn Fn() + Send + Sync>;
pub type Gate = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Published {
    row: Row,
    gave_up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TickStatus {
    Ok,
    Refused,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TickView {
    status: TickStatus,
    message: String,
}

struct LiveTick {
    child: Child,
    group: i32,
    started: Instant,
}

struct Dispatch {
    spec: ChildSpec,
    every: Duration,
    deadline: Duration,
    lock_held_exit_code: i32,
    next: Instant,
    live: Option<LiveTick>,
}

struct Active {
    recipe: Recipe,
    listen: Node,
    watch: Node,
    dispatch: Dispatch,
    last_tick: Option<TickView>,
}

enum Mode {
    NotConnected,
    Suspended,
    Pending,
    Failed(String),
    Active(Box<Active>),
}

enum Message {
    Suspend(Sender<()>),
    Resume(Sender<()>),
    Restart(Sender<()>),
    Quit(Sender<()>),
}

pub fn pause_grace_seconds(setup: &WorkerSetup) -> u64 {
    setup.durations.stop_grace.as_secs().max(1) * 2
}

fn tidy(message: &str) -> String {
    let single: String = redact(message)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    single.chars().take(MAX_MESSAGE).collect()
}

fn read_tick(setup: &WorkerSetup) -> Option<TickView> {
    let text = fs::read_to_string(setup.paths.tick_result()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let status = match value.get("status")?.as_str()? {
        "ok" => TickStatus::Ok,
        "refused" => TickStatus::Refused,
        "error" => TickStatus::Error,
        _ => return None,
    };
    Some(TickView {
        status,
        message: tidy(value.get("message")?.as_str()?),
    })
}

fn configured_url(setup: &WorkerSetup) -> Option<String> {
    let text = fs::read_to_string(setup.paths.server_file()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("url")?.as_str().map(str::to_string)
}

fn child_spec(
    setup: &WorkerSetup,
    name: &str,
    command: &Command,
    env: &[(String, String)],
) -> ChildSpec {
    ChildSpec {
        name: format!("worker-{name}"),
        program: command.program.clone(),
        args: command.args.clone(),
        env: env.to_vec(),
        log: setup
            .app_paths
            .logs_dir()
            .join(format!("worker-{name}.log")),
        health_port: None,
    }
}

impl Dispatch {
    fn advance(&mut self, setup: &WorkerSetup, started: bool) -> Option<TickView> {
        let now = Instant::now();
        if let Some(live) = &mut self.live {
            let finished = live.child.try_wait().ok().flatten();
            if let Some(status) = finished {
                self.live = None;
                orphans::remove_pid_file(&setup.run_dir, DISPATCH);
                return match read_tick(setup) {
                    Some(view) => Some(view),
                    None if status.code() == Some(self.lock_held_exit_code) => None,
                    None => Some(TickView {
                        status: TickStatus::Error,
                        message: format!("the dispatch tick exited with {status}"),
                    }),
                };
            }
            if live.started.elapsed() >= self.deadline {
                stop_child(
                    &mut live.child,
                    live.group,
                    setup.durations.stop_grace,
                    setup.durations.tick,
                );
                self.live = None;
                orphans::remove_pid_file(&setup.run_dir, DISPATCH);
                return Some(TickView {
                    status: TickStatus::Error,
                    message: "the dispatch tick passed its time limit".to_string(),
                });
            }
            return None;
        }
        if started && now >= self.next {
            self.next = now + self.every;
            let _ = fs::remove_file(setup.paths.tick_result());
            match supervisor::spawn(&self.spec) {
                Ok(child) => {
                    let pid = child.id();
                    let group = group_of(pid).unwrap_or(pid as i32);
                    orphans::write_pid_file(&setup.run_dir, DISPATCH, pid, &self.spec.program);
                    self.live = Some(LiveTick {
                        child,
                        group,
                        started: now,
                    });
                }
                Err(error) => {
                    return Some(TickView {
                        status: TickStatus::Error,
                        message: format!("the dispatch tick could not start: {error}"),
                    });
                }
            }
        }
        None
    }

    fn signal(&self, signal: i32) {
        if let Some(live) = &self.live {
            let _ = signal_group(live.group, signal);
        }
    }

    fn exited(&self) -> bool {
        self.live
            .as_ref()
            .is_none_or(|live| !crate::process_group::group_is_alive(live.group))
    }

    fn stop(&mut self, setup: &WorkerSetup) {
        if let Some(mut live) = self.live.take() {
            stop_child(
                &mut live.child,
                live.group,
                setup.durations.stop_grace,
                setup.durations.tick,
            );
        }
        orphans::remove_pid_file(&setup.run_dir, DISPATCH);
    }
}

struct Engine {
    setup: Arc<WorkerSetup>,
    cli: Arc<dyn WorkerCli>,
    gate: Gate,
    notify: Notify,
    shared: Arc<Mutex<Published>>,
    mode: Mode,
    stopping: bool,
}

impl Engine {
    fn enrolled(&self) -> bool {
        match read_pair(self.setup.store.as_ref(), &self.setup.service, false) {
            Ok(pair) => pair.is_some(),
            Err(error) => {
                self.setup
                    .log
                    .error(&format!("worker credentials unreadable: {error}"));
                false
            }
        }
    }

    fn entry_mode(&self) -> Mode {
        if self.enrolled() {
            Mode::Pending
        } else {
            Mode::NotConnected
        }
    }

    fn prepare(&self) -> Result<Box<Active>, String> {
        let setup = &self.setup;
        cli_wrapper::prepare_base(setup)?;
        let recipe = self.cli.recipe()?;
        let env = setup.env(&recipe.path_tail);
        cli_wrapper::install_wrapper(setup, &env)?;
        let url = setup.api_url.clone()?;
        if configured_url(setup).as_deref() != Some(url.as_str()) {
            setup.log.info("worker server URL differs, running init");
            self.cli.init(&recipe)?;
        }
        let _ = fs::remove_file(setup.paths.tick_result());
        let dispatch = Dispatch {
            spec: child_spec(setup, "dispatch", &recipe.dispatch.command, &env),
            every: recipe.dispatch.every,
            deadline: recipe.dispatch.limit + recipe.dispatch.grace,
            lock_held_exit_code: recipe.dispatch.lock_held_exit_code,
            next: Instant::now(),
            live: None,
        };
        Ok(Box::new(Active {
            listen: supervisor::node(child_spec(setup, "listen", &recipe.listen, &env)),
            watch: supervisor::node(child_spec(setup, "watch", &recipe.watch, &env)),
            dispatch,
            last_tick: None,
            recipe,
        }))
    }

    fn advance(&mut self) {
        if matches!(self.mode, Mode::Pending) && (self.gate)() {
            self.mode = match self.prepare() {
                Ok(active) => Mode::Active(active),
                Err(message) => {
                    self.setup
                        .log
                        .error(&format!("worker not started: {message}"));
                    Mode::Failed(message)
                }
            };
            return;
        }
        if let Mode::Active(active) = &mut self.mode {
            let flags = supervisor::Flags::default();
            for node in [&mut active.listen, &mut active.watch] {
                supervisor::advance_node(
                    node,
                    true,
                    &self.setup.durations,
                    &self.setup.run_dir,
                    &self.setup.log,
                    &flags,
                );
            }
            let started = !active.listen.exited() && !active.watch.exited();
            if let Some(view) = active.dispatch.advance(&self.setup, started) {
                active.last_tick = Some(view);
            }
        }
    }

    fn stop_active(&mut self, pause: bool) {
        let Mode::Active(active) = &mut self.mode else {
            return;
        };
        let setup = &self.setup;
        active.listen.signal(libc::SIGTERM);
        active.watch.signal(libc::SIGTERM);
        active.dispatch.signal(libc::SIGTERM);
        let started = Instant::now();
        while !(active.listen.exited() && active.watch.exited() && active.dispatch.exited())
            && started.elapsed() < setup.durations.stop_grace
        {
            sleep(setup.durations.tick.min(Duration::from_millis(20)));
        }
        if pause
            && let Err(reason) = self
                .cli
                .pause_cards(&active.recipe, pause_grace_seconds(setup))
        {
            setup
                .log
                .error(&format!("pausing cards on quit failed: {reason}"));
        }
        for node in [&mut active.listen, &mut active.watch] {
            supervisor::stop_node(node, &setup.durations, &setup.run_dir, &setup.log);
        }
        active.dispatch.stop(setup);
    }

    fn row(&self) -> Published {
        let retries = self.setup.durations.restart_delays.len() as u32;
        let (row, gave_up) = match &self.mode {
            Mode::NotConnected => (Row::new(RowState::Off, NOT_CONNECTED), false),
            Mode::Suspended if self.stopping => (Row::new(RowState::Stopped, "Stopped"), false),
            Mode::Suspended | Mode::Pending => (Row::new(RowState::Starting, "Starting"), false),
            Mode::Failed(message) => (
                Row::new(
                    RowState::Failed,
                    format!("error \u{2014} {}", tidy(message)),
                ),
                false,
            ),
            Mode::Active(_) if self.stopping => (Row::new(RowState::Stopping, "Stopping"), false),
            Mode::Active(active) => {
                let broken = [&active.listen, &active.watch]
                    .into_iter()
                    .find(|node| node.gave_up() || node.waiting());
                match (broken, &active.last_tick) {
                    (Some(node), _) => (supervisor::row(node, retries, false), node.gave_up()),
                    (None, Some(view)) => (
                        match view.status {
                            TickStatus::Ok => Row::new(RowState::Running, "ok"),
                            TickStatus::Refused => Row::new(
                                RowState::Failed,
                                format!("refused \u{2014} {}", view.message),
                            ),
                            TickStatus::Error => Row::new(
                                RowState::Failed,
                                format!("error \u{2014} {}", view.message),
                            ),
                        },
                        false,
                    ),
                    (None, None) => (Row::new(RowState::Starting, "Starting"), false),
                }
            }
        };
        Published { row, gave_up }
    }

    fn publish(&self) {
        let next = self.row();
        let mut current = self.shared.lock().unwrap();
        if *current != next {
            *current = next;
            drop(current);
            (self.notify)();
        }
    }

    fn run(mut self, inbox: Receiver<Message>) {
        enrol::discard_stale_pending(
            self.setup.store.as_ref(),
            &self.setup.service,
            &self.setup.log,
        );
        self.mode = self.entry_mode();
        self.publish();
        loop {
            match inbox.recv_timeout(self.setup.durations.tick) {
                Ok(Message::Suspend(reply)) => {
                    self.stop_active(false);
                    self.mode = Mode::Suspended;
                    self.publish();
                    let _ = reply.send(());
                }
                Ok(Message::Resume(reply)) => {
                    self.stop_active(false);
                    self.mode = self.entry_mode();
                    self.publish();
                    let _ = reply.send(());
                }
                Ok(Message::Restart(reply)) => {
                    self.setup.log.info("restart-worker requested");
                    self.stop_active(false);
                    self.mode = self.entry_mode();
                    self.publish();
                    let _ = reply.send(());
                }
                Ok(Message::Quit(reply)) => {
                    self.stopping = true;
                    self.publish();
                    let was_active = matches!(self.mode, Mode::Active(_));
                    self.stop_active(true);
                    if was_active {
                        self.mode = Mode::Suspended;
                    }
                    self.publish();
                    let _ = reply.send(());
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.stop_active(false);
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.advance();
            self.publish();
        }
    }
}

pub struct Worker {
    commands: Sender<Message>,
    shared: Arc<Mutex<Published>>,
    thread: Option<JoinHandle<()>>,
    setup: Arc<WorkerSetup>,
    cli: Arc<dyn WorkerCli>,
}

impl Worker {
    pub fn start(
        setup: Arc<WorkerSetup>,
        cli: Arc<dyn WorkerCli>,
        gate: Gate,
        notify: Notify,
    ) -> Worker {
        let shared = Arc::new(Mutex::new(Published {
            row: Row::new(RowState::Off, NOT_CONNECTED),
            gave_up: false,
        }));
        let (commands, inbox) = mpsc::channel();
        let engine = Engine {
            setup: Arc::clone(&setup),
            cli: Arc::clone(&cli),
            gate,
            notify,
            shared: Arc::clone(&shared),
            mode: Mode::NotConnected,
            stopping: false,
        };
        let thread = thread::spawn(move || engine.run(inbox));
        Worker {
            commands,
            shared,
            thread: Some(thread),
            setup,
            cli,
        }
    }

    pub fn setup(&self) -> &Arc<WorkerSetup> {
        &self.setup
    }

    pub fn cli(&self) -> &Arc<dyn WorkerCli> {
        &self.cli
    }

    pub fn row(&self) -> Row {
        self.shared.lock().unwrap().row.clone()
    }

    pub fn merge(&self, mut status: Status) -> Status {
        let published = self.shared.lock().unwrap().clone();
        status.worker = published.row;
        status.gave_up.worker = published.gave_up;
        status
    }

    fn ask(&self, message: impl FnOnce(Sender<()>) -> Message) {
        let (reply, answer) = mpsc::channel();
        if self.commands.send(message(reply)).is_ok() {
            let _ = answer.recv();
        }
    }

    pub fn suspend(&self) {
        self.ask(Message::Suspend);
    }

    pub fn resume(&self) {
        self.ask(Message::Resume);
    }

    pub fn restart(&self) {
        self.ask(Message::Restart);
    }

    pub fn shutdown(&mut self) {
        self.ask(Message::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub fn lifecycle(&self) -> WorkerLifecycle<'_> {
        WorkerLifecycle { worker: self }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct WorkerLifecycle<'a> {
    worker: &'a Worker,
}

impl Lifecycle for WorkerLifecycle<'_> {
    fn stop(&self) -> Result<(), String> {
        self.worker.suspend();
        Ok(())
    }

    fn start(&self) -> Result<(), String> {
        self.worker.resume();
        Ok(())
    }
}
