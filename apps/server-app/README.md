# Server app

Tray-only Tauri 2 app that runs the API on one Mac. Layout: `src-tauri/core` (pure Rust library
`agent-board-server-core`, all logic, tested with `cargo test`) and `src-tauri` (app crate
`agent-board-server`, a thin shell). `test/` holds black-box Vitest tests that spawn the built headless binary.

```bash
pnpm --filter @agent-board/server-app shell:check   # clippy + build of the app crate (macOS)
pnpm --filter @agent-board/server-app test          # Vitest (needs the built binary) + cargo test of core
pnpm --filter @agent-board/server-app bundle        # signed-ad-hoc .app
```

## Architecture notes

Spike outcome (Tauri `=2.12.6`, Rust 1.100, Darwin 27.2).

- **No Dock icon, no window.** `Info.plist` sets `LSUIElement` for the bundle and the setup hook calls
  `set_activation_policy(Accessory)`, so a plain `cargo run` binary is a UI element too. Checked with
  `lsappinfo list`: the process reports `type="UIElement"`. `app.windows` is empty in `tauri.conf.json`; with no
  window the event loop stays up until the tray's Quit calls `app.exit(0)`.
- **Headless in the same binary.** `main` parses the arguments first. `--headless` calls the core runner and returns
  before any `tauri::Builder` exists, so AppKit is never initialised: the process never appears in `lsappinfo`. The
  binary still links AppKit and WebKit, so it only runs on macOS; the Linux jobs build and test `core` only
  (`default-members`). `--uninstall` takes the same path.
- **Child in its own process group.** `process_group::spawn_in_own_group` uses `CommandExt::process_group(0)`
  (setpgid in the child before exec). A shell and its background grandchild share the child's pgid, which differs
  from the parent's, and `killpg(SIGTERM)` removes both. No `pre_exec` or unsafe is needed to spawn.
- **Single instance** is `flock(LOCK_EX | LOCK_NB)` on `<root>/app.lock`, released by the kernel when the process
  dies, so a crash never leaves a stale lock. The Tauri single-instance plugin is not used.
- **Log rotation** serialises writers (threads and processes) with `flock` on a `<log>.lock` sidecar, because a
  lock on the log itself would follow the renamed inode.
- **Gotchas.** `regex` needs its `unicode` feature for `(?i)`. SIGTERM on the tray process ends it without Quit
  logic; signal handling arrives with the supervisor. The tray icon is the bundle icon (placeholder artwork copied
  from the client app) until the tray iteration. Keychain prompts on ad-hoc rebuilds stay a manual check.

## Settings and roots

`<root>/settings.json` is created with defaults on the first start and never rewritten; edits apply after Quit and
reopen. The root is `~/Library/Application Support/Agent Board Server` unless `AGENT_BOARD_SERVER_ROOT` moves it; a
moved root has its own Keychain service and never touches the login item. Test seams (non-release builds, or any
build with `AGENT_BOARD_E2E=1`): `AGENT_BOARD_CREDENTIAL_STORE=file:<path>` replaces the Keychain and
`AGENT_BOARD_LAUNCH_AGENTS_DIR=<dir>` replaces `~/Library/LaunchAgents`.

## Supervision

`core::supervisor` runs the API (and, from the worker iteration, the worker) on one thread. Each child is its own
process group with its output appended to `<root>/logs/<name>.log`, a pid file `<root>/run/<name>.pid` (pid and
program path) and an environment cleared down to the variables the spec lists: the real API executable starts and
answers `/healthz` with no `PATH` or `HOME`, so none is passed. Order: API, then the worker once the API is first
healthy; stop is the reverse, SIGTERM to the group and SIGKILL after the grace. Crashes restart after 1 s, 5 s and
25 s and the fourth gives up until Restart server. The restart count resets after 10 minutes stable, counted from the
first healthy `/healthz`. `/healthz` is probed every 60 s (2 s timeout, three misses are a crash) and never while
`Supervisor::set_hold(true)` (the backup hold) or during a restart. The orphan sweep runs first: the process a pid file
names is terminated, SIGKILL included, only when its command starts with the recorded program, it leads its own
process group and it started before the pid file was written; anything else is a reused pid and is left alone. A port already in use is found
before spawning and shown on the API row; the app stays up.

SIGTERM, SIGINT and SIGHUP are recorded by `core::signals` and run the same stop as Quit, in the tray (through
`app.exit`) and in `--headless`; dropping the supervisor on any other exit path stops the children too. A release
build with `panic = "abort"` skips drops, so the next start's orphan sweep is the net.

Test seams (non-release builds, or `AGENT_BOARD_E2E=1`): `AGENT_BOARD_SERVER_RESOURCES=<dir>` replaces the
`resources/` folder next to the binary (`api/agent-board-api`, `web/`), and `AGENT_BOARD_SUPERVISION_TIMINGS`
(`restart1=100,grace=500,probe=100,...` in ms, keys in `core::durations`) shortens every timing. The `stub_child`
binary of `core` is the stand-in API in tests: it listens on `HOST:PORT`, answers `/healthz`, and reads its
behaviour (crash, hang, ignore SIGTERM, start late, spawn a grandchild) from `STUB_CONFIG` or `<exe>.conf`.
`build:binary` builds it next to the app binary.

The headless runner prints a `state` line whenever the rows change (`supervision.api`, `supervision.worker`,
`gaveUp`, `blocked`) and implements `state`, `restart-server`, `open-logs`, `open-settings` and `quit`. The other
actions answer `error` with "<action> is not implemented in this build" until their iteration.

## Worker and enrolment

The worker is the bundled CLI (`resources/cli/board`) run under `AGENT_BOARD_PROFILE=server-app` with the three
directory overrides under `<root>/worker/{config,state,run}`; no launchd unit is installed. The app asks the CLI for its
unit recipe (`board internal units`) and runs the listener, the watcher and the dispatch tick from it, supervised with
the same restart policy as the API. It starts once the API is first healthy and, on Quit, is stopped first: SIGTERM to
the worker processes, `board internal shutdown` to pause running cards, then SIGKILL for stragglers. Nothing runs while
the worker is not enrolled; the row reads "Worker not connected".

`<root>/worker/bin` holds `board-cli` (a link to the bundled CLI) and `board`, a wrapper that sets the worker
environment and refuses `setup`, `self-update`, `restart` and `init` with exit 2. The worker `PATH` is that folder, the
`workerPath` entries from `settings.json` (a list of at most 32 absolute folders without `:`; a single string is read
as a one-entry list), then the recipe's tail; only `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`LANG` and `SSH_AUTH_SOCK` are inherited.

The token and data key live only in the credential store (Keychain service from the root, accounts `worker-token` and
`worker-data-key`, plus `.pending` for a pair under test). The CLI reads them through
`AGENT_BOARD_CREDENTIALS_COMMAND`, a script in `<root>/worker/libexec` that calls the app binary with
`--worker-credentials`; no file or process argument holds them.

Headless actions: `connect-worker <token> <data-key>` (checks the pair as pending through `board init --force`, then
stop, pause once, promote, start; a refusal changes nothing), `disconnect-worker`, `restart-worker` and `check-worker`
(`board doctor --json` minus the checks in `core/src/dropped_checks.json`, plus a `claude` and `gh` lookup on the worker
`PATH`, written to `logs/check-worker.log`). `core::enrol::EnrolForm` is the window's masked-input model. The row after
each dispatch tick reads `ok`, `refused — …` or `error — …` from the CLI's `dispatch-result.json`.
