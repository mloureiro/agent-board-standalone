mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_board_server_core::cli_run::{ProcessCli, WorkerCli};
use agent_board_server_core::credential_flow::{
    Pair, normalize_secret, read_pair, render_command_output, write_pair,
};
use agent_board_server_core::credentials::{
    CredentialError, CredentialStore, FileStore, PENDING_WORKER_DATA_KEY, PENDING_WORKER_TOKEN,
    WORKER_DATA_KEY, WORKER_TOKEN,
};
use agent_board_server_core::enrol::{
    EnrolError, EnrolForm, Enrolment, Lifecycle, MASK_CHARACTER, Phase,
};
use agent_board_server_core::log_file::{AppLog, LogFile};
use agent_board_server_core::recipe::{self, Recipe};
use common::worker::{Rig, SERVICE, eventually};
use tempfile::TempDir;

const RECIPE: &str = r#"{"schema":1,"platform":"darwin","path":"/usr/bin:/bin","passedVariables":[],"units":[
{"name":"dispatch","kind":"tick","program":"/b","args":["internal","dispatch"],"everySeconds":120,"limitSeconds":110,"graceSeconds":10,"lockHeldExitCode":75},
{"name":"listen","kind":"service","program":"/b","args":["internal","listen"],"restartDelaySeconds":10},
{"name":"watch","kind":"service","program":"/b","args":["internal","watch"],"restartDelaySeconds":5}]}"#;

type Events = Arc<Mutex<Vec<String>>>;

struct Faulty {
    inner: FileStore,
    fail: Mutex<Option<(&'static str, &'static str)>>,
}

impl Faulty {
    fn arm(&self, operation: &'static str, account: &'static str) {
        *self.fail.lock().unwrap() = Some((operation, account));
    }

    fn trips(&self, operation: &str, account: &str) -> bool {
        let mut armed = self.fail.lock().unwrap();
        if *armed == Some((operation, account)) {
            *armed = None;
            return true;
        }
        false
    }
}

impl CredentialStore for Faulty {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, CredentialError> {
        self.inner.get(service, account)
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialError> {
        if self.trips("set", account) {
            return Err(CredentialError::new("injected set failure"));
        }
        self.inner.set(service, account, value)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
        if self.trips("delete", account) {
            return Err(CredentialError::new("injected delete failure"));
        }
        self.inner.delete(service, account)
    }
}

struct FakeCli {
    events: Events,
    check: Result<String, String>,
    store: Arc<Faulty>,
}

fn token_of(store: &Faulty) -> String {
    store
        .get(SERVICE, WORKER_TOKEN)
        .unwrap()
        .unwrap_or_else(|| "none".to_string())
}

impl WorkerCli for FakeCli {
    fn recipe(&self) -> Result<Recipe, String> {
        recipe::parse(RECIPE)
    }

    fn check_pending(&self, _: &Recipe) -> Result<String, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("check real={}", token_of(&self.store)));
        self.check.clone()
    }

    fn init(&self, _: &Recipe) -> Result<String, String> {
        Ok(String::new())
    }

    fn pause_cards(&self, _: &Recipe, _: u64) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("pause real={}", token_of(&self.store)));
        Ok(())
    }

    fn doctor(&self, _: &Recipe) -> Result<String, String> {
        Err("not used".to_string())
    }
}

struct FakeLifecycle {
    events: Events,
    store: Arc<Faulty>,
}

impl Lifecycle for FakeLifecycle {
    fn stop(&self) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("stop real={}", token_of(&self.store)));
        Ok(())
    }

    fn start(&self) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("start real={}", token_of(&self.store)));
        Ok(())
    }
}

struct Bench {
    dir: TempDir,
    store: Arc<Faulty>,
    events: Events,
    log: AppLog,
    config: PathBuf,
}

impl Bench {
    fn new() -> Bench {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Faulty {
            inner: FileStore::new(dir.path().join("credentials.json")),
            fail: Mutex::new(None),
        });
        let config = dir.path().join("config.yaml");
        fs::write(&config, "machine: old\n").unwrap();
        Bench {
            log: AppLog::new(LogFile::new(dir.path().join("app.log"))),
            dir,
            store,
            events: Events::default(),
            config,
        }
    }

    fn previous(&self, token: &str, data_key: &str) {
        write_pair(
            self.store.as_ref(),
            SERVICE,
            false,
            &Pair {
                token: token.to_string(),
                data_key: data_key.to_string(),
            },
        )
        .unwrap();
    }

    fn connect(&self, check: Result<String, String>) -> Result<String, EnrolError> {
        let cli = FakeCli {
            events: Arc::clone(&self.events),
            check,
            store: Arc::clone(&self.store),
        };
        let lifecycle = FakeLifecycle {
            events: Arc::clone(&self.events),
            store: Arc::clone(&self.store),
        };
        Enrolment {
            store: self.store.as_ref(),
            service: SERVICE,
            cli: &cli,
            lifecycle: &lifecycle,
            profile_config: &self.config,
            pause_grace_seconds: 1,
            log: &self.log,
        }
        .connect("abm_new", "abk1_new")
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn account(&self, account: &str) -> Option<String> {
        self.store.get(SERVICE, account).unwrap()
    }

    fn nothing_pending(&self) -> bool {
        self.account(PENDING_WORKER_TOKEN).is_none()
            && self.account(PENDING_WORKER_DATA_KEY).is_none()
    }
}

#[test]
fn server_app_050_a_refused_pair_stops_and_pauses_nothing_and_stores_nothing() {
    let bench = Bench::new();
    bench.previous("abm_old", "abk1_old");

    let outcome = bench.connect(Err("the board answered 401".to_string()));

    assert_eq!(
        outcome,
        Err(EnrolError::Refused("the board answered 401".to_string()))
    );
    assert_eq!(bench.events(), vec!["check real=abm_old"]);
    assert_eq!(bench.account(WORKER_TOKEN).as_deref(), Some("abm_old"));
    assert_eq!(bench.account(WORKER_DATA_KEY).as_deref(), Some("abk1_old"));
    assert!(bench.nothing_pending());
}

#[test]
fn server_app_048_a_refused_first_pair_leaves_the_store_empty() {
    let bench = Bench::new();

    let outcome = bench.connect(Err("the data key is not the board's".to_string()));

    assert!(matches!(outcome, Err(EnrolError::Refused(reason)) if reason.contains("data key")));
    assert_eq!(bench.account(WORKER_TOKEN), None);
    assert_eq!(bench.account(WORKER_DATA_KEY), None);
    assert!(bench.nothing_pending());
}

#[test]
fn server_app_050_an_accepted_pair_runs_check_stop_pause_once_promote_start() {
    let bench = Bench::new();
    bench.previous("abm_old", "abk1_old");

    let outcome = bench.connect(Ok("studio".to_string()));

    assert_eq!(outcome, Ok("studio".to_string()));
    assert_eq!(
        bench.events(),
        vec![
            "check real=abm_old",
            "stop real=abm_old",
            "pause real=abm_old",
            "start real=abm_new",
        ]
    );
    assert_eq!(bench.account(WORKER_DATA_KEY).as_deref(), Some("abk1_new"));
    assert!(bench.nothing_pending());
}

#[test]
fn server_app_049_the_machine_name_comes_from_the_server_not_from_the_form_or_the_old_config() {
    let bench = Bench::new();

    let outcome = bench.connect(Ok("name-the-server-gave".to_string()));

    assert_eq!(outcome, Ok("name-the-server-gave".to_string()));
    assert_eq!(
        fs::read_to_string(&bench.config).unwrap(),
        "machine: name-the-server-gave\n"
    );
}

#[test]
fn server_app_052_every_failing_promotion_step_rolls_back_to_the_previous_pair() {
    let steps: [(&str, &str); 3] = [
        ("set", WORKER_TOKEN),
        ("set", WORKER_DATA_KEY),
        ("delete", PENDING_WORKER_TOKEN),
    ];
    for (operation, account) in steps {
        let bench = Bench::new();
        bench.previous("abm_old", "abk1_old");
        bench.store.arm(operation, account);

        let outcome = bench.connect(Ok("studio".to_string()));

        assert!(
            matches!(outcome, Err(EnrolError::Failed(_))),
            "{operation} {account}"
        );
        assert_eq!(bench.account(WORKER_TOKEN).as_deref(), Some("abm_old"));
        assert_eq!(bench.account(WORKER_DATA_KEY).as_deref(), Some("abk1_old"));
        assert_eq!(fs::read_to_string(&bench.config).unwrap(), "machine: old\n");
        assert!(bench.nothing_pending(), "{operation} {account}");
        assert_eq!(
            bench.events().last().map(String::as_str),
            Some("start real=abm_old")
        );
    }
}

#[test]
fn server_app_052_a_failing_machine_or_last_step_never_leaves_a_mixed_pair() {
    let bench = Bench::new();
    bench.previous("abm_old", "abk1_old");
    let missing = bench.dir.path().join("missing/config.yaml");
    let cli = FakeCli {
        events: Arc::clone(&bench.events),
        check: Ok("studio".to_string()),
        store: Arc::clone(&bench.store),
    };
    let lifecycle = FakeLifecycle {
        events: Arc::clone(&bench.events),
        store: Arc::clone(&bench.store),
    };
    let outcome = Enrolment {
        store: bench.store.as_ref(),
        service: SERVICE,
        cli: &cli,
        lifecycle: &lifecycle,
        profile_config: &missing,
        pause_grace_seconds: 1,
        log: &bench.log,
    }
    .connect("abm_new", "abk1_new");

    assert!(matches!(outcome, Err(EnrolError::Failed(_))));
    assert_eq!(bench.account(WORKER_TOKEN).as_deref(), Some("abm_old"));
    assert_eq!(bench.account(WORKER_DATA_KEY).as_deref(), Some("abk1_old"));
    assert!(bench.nothing_pending());

    let bench = Bench::new();
    bench.store.arm("delete", PENDING_WORKER_DATA_KEY);
    let outcome = bench.connect(Ok("studio".to_string()));
    assert!(matches!(outcome, Err(EnrolError::Failed(_))));
    assert_eq!(bench.account(WORKER_TOKEN), None);
    assert_eq!(bench.account(WORKER_DATA_KEY), None);
    assert!(bench.nothing_pending());
}

#[test]
fn server_app_055_a_pasted_prefix_is_stripped_and_a_multi_line_value_is_refused() {
    assert_eq!(
        normalize_secret("AGENT_BOARD_TOKEN=abm_x1\n", "AGENT_BOARD_TOKEN", "token"),
        Ok("abm_x1".to_string())
    );
    assert_eq!(
        normalize_secret("  abm_x1  ", "AGENT_BOARD_TOKEN", "token"),
        Ok("abm_x1".to_string())
    );
    assert_eq!(
        normalize_secret(
            "AGENT_BOARD_DATA_KEY=abk1_y",
            "AGENT_BOARD_DATA_KEY",
            "data key"
        ),
        Ok("abk1_y".to_string())
    );
    assert_eq!(
        normalize_secret("AGENT_BOARD_DATA_KEY=abk1_y", "AGENT_BOARD_TOKEN", "token"),
        Ok("AGENT_BOARD_DATA_KEY=abk1_y".to_string())
    );
    assert!(
        normalize_secret(
            "AGENT_BOARD_TOKEN=abm_x\nAGENT_BOARD_DATA_KEY=abk1_y",
            "AGENT_BOARD_TOKEN",
            "token"
        )
        .is_err()
    );
    assert!(normalize_secret("abm_a\r\nabm_b", "AGENT_BOARD_TOKEN", "token").is_err());
    assert!(normalize_secret("AGENT_BOARD_TOKEN=  ", "AGENT_BOARD_TOKEN", "token").is_err());
}

#[test]
fn server_app_055_connect_strips_the_prefix_before_anything_is_stored() {
    let bench = Bench::new();
    let cli = FakeCli {
        events: Arc::clone(&bench.events),
        check: Ok("studio".to_string()),
        store: Arc::clone(&bench.store),
    };
    let lifecycle = FakeLifecycle {
        events: Arc::clone(&bench.events),
        store: Arc::clone(&bench.store),
    };
    let enrolment = Enrolment {
        store: bench.store.as_ref(),
        service: SERVICE,
        cli: &cli,
        lifecycle: &lifecycle,
        profile_config: &bench.config,
        pause_grace_seconds: 1,
        log: &bench.log,
    };

    let refused = enrolment.connect("abm_a\nabm_b", "abk1_y");
    assert!(matches!(refused, Err(EnrolError::Invalid(_))));
    assert!(bench.events().is_empty());
    assert_eq!(bench.account(PENDING_WORKER_TOKEN), None);

    enrolment
        .connect("AGENT_BOARD_TOKEN=abm_ok", "AGENT_BOARD_DATA_KEY=abk1_ok")
        .unwrap();
    assert_eq!(bench.account(WORKER_TOKEN).as_deref(), Some("abm_ok"));
    assert_eq!(bench.account(WORKER_DATA_KEY).as_deref(), Some("abk1_ok"));
}

#[test]
fn server_app_047_the_form_masks_with_one_dot_per_character_and_counts_them() {
    let mut form = EnrolForm::new();
    form.set_token("abm_12345");
    form.set_data_key("abk1_é");
    let view = form.view();

    assert_eq!(view.fields.len(), 2);
    assert_eq!(view.fields[0].mask, MASK_CHARACTER.to_string().repeat(9));
    assert_eq!(view.fields[0].count, 9);
    assert_eq!(view.fields[1].count, 6);
    assert!(!view.fields[0].mask.contains("abm"));
    assert!(view.connect_enabled);
    assert!(view.status.is_none());
    let labels: Vec<&str> = view.fields.iter().map(|field| field.label).collect();
    assert_eq!(labels, ["Token", "Data key"]);
}

#[test]
fn server_app_047_connecting_shows_the_wait_and_blocks_closing_until_it_ends() {
    let mut form = EnrolForm::new();
    assert!(form.begin().is_none());
    form.set_token("abm_a");
    form.set_data_key("abk1_b");

    assert!(form.begin().is_some());
    let waiting = form.view();
    assert_eq!(waiting.status.as_deref(), Some("Connecting\u{2026}"));
    assert!(!waiting.can_close);
    assert!(!waiting.connect_enabled);
    assert!(form.begin().is_none());
    form.set_token("changed");
    assert_eq!(form.view().fields[0].count, 5);

    form.finish(Ok("studio".to_string()));
    let done = form.view();
    assert_eq!(done.status.as_deref(), Some("Connected as studio"));
    assert!(done.can_close);
    assert_eq!(form.phase(), Phase::Connected);
    assert_eq!(done.fields[0].count, 0);
}

#[test]
fn server_app_047_a_refusal_keeps_the_fields_and_shows_the_reason() {
    let mut form = EnrolForm::new();
    form.set_token("abm_a");
    form.set_data_key("abk1_b");
    form.begin();
    form.finish(Err(EnrolError::Refused(
        "the board answered 401".to_string(),
    )));

    let view = form.view();
    assert_eq!(view.status.as_deref(), Some("the board answered 401"));
    assert_eq!(view.fields[0].count, 5);
    assert!(view.can_close && view.connect_enabled);
}

#[test]
fn server_app_051_the_running_worker_is_served_the_real_pair_never_the_pending_one() {
    let rig = Rig::new("");
    rig.enrol();
    write_pair(
        rig.store.as_ref(),
        SERVICE,
        true,
        &Pair {
            token: "abm_pending".to_string(),
            data_key: "abk1_pending".to_string(),
        },
    )
    .unwrap();

    let env = rig.setup.env("/bin");
    let command = env
        .iter()
        .find(|(name, _)| name == "AGENT_BOARD_CREDENTIALS_COMMAND")
        .map(|(_, value)| PathBuf::from(value))
        .unwrap();
    assert_eq!(command, rig.setup.paths.credentials_script(false));
    let served = read_pair(rig.store.as_ref(), SERVICE, false)
        .unwrap()
        .unwrap();
    assert_eq!(
        render_command_output(&served),
        "AGENT_BOARD_TOKEN=abm_good\nAGENT_BOARD_DATA_KEY=abk1_good\n"
    );
}

#[test]
fn server_app_051_a_pending_pair_left_by_a_crash_is_discarded_at_the_next_start() {
    let rig = Rig::new("");
    rig.enrol();
    write_pair(
        rig.store.as_ref(),
        SERVICE,
        true,
        &Pair {
            token: "abm_left".to_string(),
            data_key: "abk1_left".to_string(),
        },
    )
    .unwrap();

    let worker = rig.worker();

    assert!(eventually(10, || {
        read_pair(rig.store.as_ref(), SERVICE, true)
            .unwrap()
            .is_none()
    }));
    assert!(
        read_pair(rig.store.as_ref(), SERVICE, false)
            .unwrap()
            .is_some()
    );
    drop(worker);
}

#[test]
fn server_app_050_an_init_that_sets_up_the_pair_but_fails_its_closing_checks_accepts_the_pair() {
    let rig = Rig::new("INIT_CHECKS_FAIL=1");
    let cli = ProcessCli::new(Arc::clone(&rig.setup));
    let recipe = cli.recipe().unwrap();

    assert_eq!(cli.check_pending(&recipe), Ok("studio".to_string()));
    assert_eq!(cli.init(&recipe), Ok("studio".to_string()));

    let refused = Rig::new("INIT_CHECKS_FAIL=1\nACCEPT_TOKEN=abm_other");
    let cli = ProcessCli::new(Arc::clone(&refused.setup));
    let recipe = cli.recipe().unwrap();
    assert_eq!(
        cli.check_pending(&recipe),
        Err("the board answered 401: the token is not valid".to_string())
    );
}

#[test]
fn server_app_054_the_pending_pair_has_its_own_accounts_in_the_same_service() {
    let rig = Rig::new("");
    write_pair(
        rig.store.as_ref(),
        SERVICE,
        true,
        &Pair {
            token: "abm_p".to_string(),
            data_key: "abk1_p".to_string(),
        },
    )
    .unwrap();

    assert_eq!(
        rig.store
            .get(SERVICE, PENDING_WORKER_TOKEN)
            .unwrap()
            .as_deref(),
        Some("abm_p")
    );
    assert_eq!(rig.store.get(SERVICE, WORKER_TOKEN).unwrap(), None);
    assert!(
        read_pair(rig.store.as_ref(), SERVICE, false)
            .unwrap()
            .is_none()
    );
}

#[test]
fn server_app_019_disconnect_stops_pauses_deletes_both_pairs_and_keeps_the_worker_config() {
    let bench = Bench::new();
    bench.previous("abm_old", "abk1_old");
    write_pair(
        bench.store.as_ref(),
        SERVICE,
        true,
        &Pair {
            token: "abm_p".to_string(),
            data_key: "abk1_p".to_string(),
        },
    )
    .unwrap();
    let cli = FakeCli {
        events: Arc::clone(&bench.events),
        check: Ok(String::new()),
        store: Arc::clone(&bench.store),
    };
    let lifecycle = FakeLifecycle {
        events: Arc::clone(&bench.events),
        store: Arc::clone(&bench.store),
    };

    Enrolment {
        store: bench.store.as_ref(),
        service: SERVICE,
        cli: &cli,
        lifecycle: &lifecycle,
        profile_config: &bench.config,
        pause_grace_seconds: 1,
        log: &bench.log,
    }
    .disconnect()
    .unwrap();

    assert_eq!(
        bench.events(),
        vec!["stop real=abm_old", "pause real=abm_old", "start real=none"]
    );
    assert_eq!(bench.account(WORKER_TOKEN), None);
    assert_eq!(bench.account(WORKER_DATA_KEY), None);
    assert!(bench.nothing_pending());
    assert_eq!(fs::read_to_string(&bench.config).unwrap(), "machine: old\n");
}
