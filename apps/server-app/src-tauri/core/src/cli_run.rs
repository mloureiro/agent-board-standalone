use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::cli_wrapper;
use crate::process_group::{signal_group, spawn_in_own_group};
use crate::recipe::{self, Recipe};
use crate::redact::redact;
use crate::worker_paths::{CREDENTIALS_COMMAND_ENV, fallback_tail, replace_env};
use crate::worker_setup::WorkerSetup;

const SHORT: Duration = Duration::from_secs(30);
const DOCTOR: Duration = Duration::from_secs(90);
const MAX_REASON: usize = 240;

pub trait WorkerCli: Send + Sync {
    fn recipe(&self) -> Result<Recipe, String>;
    fn check_pending(&self, recipe: &Recipe) -> Result<String, String>;
    fn init(&self, recipe: &Recipe) -> Result<String, String>;
    fn pause_cards(&self, recipe: &Recipe, grace_seconds: u64) -> Result<(), String>;
    fn doctor(&self, recipe: &Recipe) -> Result<String, String>;
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn machine_of(output: &str) -> Option<String> {
    let (_, rest) = output.split_once(" as machine ")?;
    let name = rest.split_whitespace().next()?;
    Some(name.trim_matches(['(', ')', '"']).to_string())
}

pub fn reason_of(output: &Output) -> String {
    let source = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let line = source
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map_or_else(|| format!("the CLI exited with {}", output.code), redact);
    line.chars().take(MAX_REASON).collect()
}

fn drain(mut stream: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

pub fn run_program(
    program: &std::path::Path,
    args: &[std::ffi::OsString],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_in_own_group(&mut command)
        .map_err(|error| format!("{} could not start: {error}", program.display()))?;
    let stdout = drain(child.stdout.take().ok_or("no stdout")?);
    let stderr = drain(child.stderr.take().ok_or("no stderr")?);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = signal_group(child.id() as i32, libc::SIGKILL);
                let _ = child.wait();
                return Err(format!("the CLI timed out after {} s", timeout.as_secs()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(error.to_string()),
        }
    };
    Ok(Output {
        code: status.code().unwrap_or(-1),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

pub struct ProcessCli {
    setup: Arc<WorkerSetup>,
}

impl ProcessCli {
    pub fn new(setup: Arc<WorkerSetup>) -> ProcessCli {
        ProcessCli { setup }
    }

    fn call(
        &self,
        env: &[(String, String)],
        args: &[&str],
        timeout: Duration,
    ) -> Result<Output, String> {
        cli_wrapper::prepare_base(&self.setup)?;
        let args: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
        run_program(&self.setup.paths.cli_link(), &args, env, timeout)
    }

    fn succeeded(output: Output) -> Result<String, String> {
        if output.code == 0 {
            Ok(output.stdout)
        } else {
            Err(reason_of(&output))
        }
    }

    fn url(&self) -> Result<String, String> {
        self.setup.api_url.clone()
    }

    fn run_init(&self, env: &[(String, String)]) -> Result<String, String> {
        let url = self.url()?;
        let output = self.call(env, &["init", "--force", "--url", &url], SHORT)?;
        match machine_of(&output.stdout) {
            Some(machine) => {
                if output.code != 0 {
                    self.setup.log.info(&format!(
                        "rumo init set up the worker and then reported: {}",
                        reason_of(&output)
                    ));
                }
                Ok(machine)
            }
            None if output.code == 0 => Err("the board did not name this machine".to_string()),
            None => Err(reason_of(&output)),
        }
    }
}

impl WorkerCli for ProcessCli {
    fn recipe(&self) -> Result<Recipe, String> {
        let env = self.setup.env(&fallback_tail(&self.setup.home));
        let output = self.call(&env, &["internal", "units"], SHORT)?;
        recipe::parse(&Self::succeeded(output)?)
    }

    fn check_pending(&self, recipe: &Recipe) -> Result<String, String> {
        let mut env = self.setup.env(&recipe.path_tail);
        replace_env(
            &mut env,
            CREDENTIALS_COMMAND_ENV,
            self.setup
                .paths
                .credentials_script(true)
                .display()
                .to_string(),
        );
        self.run_init(&env)
    }

    fn init(&self, recipe: &Recipe) -> Result<String, String> {
        self.run_init(&self.setup.env(&recipe.path_tail))
    }

    fn pause_cards(&self, recipe: &Recipe, grace_seconds: u64) -> Result<(), String> {
        let env = self.setup.env(&recipe.path_tail);
        let grace = grace_seconds.to_string();
        let output = self.call(
            &env,
            &["internal", "shutdown", "--grace", &grace],
            Duration::from_secs(grace_seconds) + SHORT,
        )?;
        Self::succeeded(output).map(|_| ())
    }

    fn doctor(&self, recipe: &Recipe) -> Result<String, String> {
        let env = self.setup.env(&recipe.path_tail);
        let output = self.call(&env, &["doctor", "--json"], DOCTOR)?;
        if output.stdout.trim_start().starts_with('[') {
            Ok(output.stdout)
        } else {
            Err(reason_of(&output))
        }
    }
}
