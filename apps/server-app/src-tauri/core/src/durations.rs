use std::time::Duration;

pub const TIMINGS_ENV: &str = "AGENT_BOARD_SUPERVISION_TIMINGS";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Durations {
    pub restart_delays: Vec<Duration>,
    pub stable_reset: Duration,
    pub probe_interval: Duration,
    pub probe_timeout: Duration,
    pub probe_misses: u32,
    pub startup_probe_interval: Duration,
    pub startup_deadline: Duration,
    pub stop_grace: Duration,
    pub tick: Duration,
}

impl Durations {
    pub fn production() -> Durations {
        Durations {
            restart_delays: vec![
                Duration::from_secs(1),
                Duration::from_secs(5),
                Duration::from_secs(25),
            ],
            stable_reset: Duration::from_secs(10 * 60),
            probe_interval: Duration::from_secs(60),
            probe_timeout: Duration::from_secs(2),
            probe_misses: 3,
            startup_probe_interval: Duration::from_millis(500),
            startup_deadline: Duration::from_secs(120),
            stop_grace: Duration::from_secs(10),
            tick: Duration::from_millis(100),
        }
    }

    pub fn worst_case_stop(&self, processes: u32) -> Duration {
        self.stop_grace * processes
    }

    pub fn parse(text: &str) -> Option<Durations> {
        let mut durations = Durations::production();
        for pair in text.split(',').filter(|pair| !pair.trim().is_empty()) {
            let (key, value) = pair.split_once('=')?;
            let value: u64 = value.trim().parse().ok()?;
            let millis = Duration::from_millis(value);
            match key.trim() {
                "restart1" => durations.restart_delays[0] = millis,
                "restart2" => durations.restart_delays[1] = millis,
                "restart3" => durations.restart_delays[2] = millis,
                "stable" => durations.stable_reset = millis,
                "probe" => durations.probe_interval = millis,
                "probeTimeout" => durations.probe_timeout = millis,
                "misses" => durations.probe_misses = u32::try_from(value).ok()?,
                "startupProbe" => durations.startup_probe_interval = millis,
                "startupDeadline" => durations.startup_deadline = millis,
                "grace" => durations.stop_grace = millis,
                "tick" => durations.tick = millis,
                _ => return None,
            }
        }
        Some(durations)
    }
}
