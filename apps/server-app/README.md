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
`gaveUp`, `blocked`, `backup`) and implements every tray action (see "Tray" below).

## Tray

The menu is built from one pure model (`core::menu`) and refreshed whenever the supervision rows, the backup or the
busy lock change. Items, in order: Open board, the API row, the worker row, the Last backup row, the version line,
Restart server, Back up now, Restart worker, Disconnect worker, Check worker, Open logs folder, Open settings file,
Connect worker…, Pair a device…, Quit. Open board and Connect worker… are enabled only while the API runs; Restart,
Disconnect and Check worker only once a worker is connected; Back up now only while the API runs; Pair a device… only
while the API runs with `requestSignature` on. While an enrolment, a backup, Quit or another recovery action runs,
every item except Open board, Connect worker… and Quit is disabled, and a click that still arrives is refused and
logged to `app.log` (`refused <action>: <reason>`). A row that is `failed` or gave up puts a `!` next to the tray icon
and the tooltip reads that row's text; the mark clears when the row recovers.

The version line reads `server app <X> · API <Y> · CLI <Z>`. The bundle step must write one line each to
`resources/api/version` and `resources/cli/version` (`[A-Za-z0-9._+-]{1,64}`): neither executable can print its version
without doing its work, so a missing or invalid file reads "unknown".

Open board hands `http://127.0.0.1:<port>/` to the client app with `open -b <client bundle id>
"agentboard://open?v=1&url=<encoded>"` (the link and the bundle id are the contract's, run as vectors in
`core/tests/handover.rs`) and falls back to `open <url>` in the default browser when that exits non-zero. Only a
loopback URL without credentials is ever handed over.

Pair a device… asks the API's control channel for a one-time code and shows it with its expiry (10 minutes) in a small
window; the code is never written to a log (the log redaction masks the `XXXX-XXXX` shape). Connect worker… opens an
app-owned window with two masked inputs, a character count each, no machine name, "Connecting…" while it works (the
window cannot be closed meanwhile) and "Connected as <machine>" or the refusal reason; the pasted values live only in
the window's inputs, the form model and, once promoted, the credential store. The pages are static files in `frontend/`
(CSP `default-src 'none'`, own scripts and styles only) that call named app commands.

Every item is one `Action` of `core::actions`, run by `Console::dispatch`; the tray and the headless runner share it.
The headless actions are `open-board`, `backup-now`, `restart-server`, `restart-worker`, `disconnect-worker`,
`check-worker`, `connect-worker <token> <data-key>`, `open-logs`, `open-settings`, `pair-device`, `quit`, `state` and
`menu` (prints `{"type":"menu","items":[{id,label,enabled}],"badge","tooltip","busy"}`). Open board prints the `open`
commands it ran in `commands`. `AGENT_BOARD_OPEN_PROGRAM=<absolute path>` (non-release builds or `AGENT_BOARD_E2E=1`)
replaces `/usr/bin/open`, so tests record the calls.

## What stays plain on disk

Worker run logs and agent transcripts are written as plain files under `<root>/worker` and `<root>/logs`, outside the
data folder, and nothing encrypts them: only the disk's own encryption (FileVault) protects them. The board's data
folder holds sealed content; these files do not.

## Manual walk

The checks no automated test can drive (tray text and mark, Keychain prompts, launchd relaunch, pairing through a
tunnel, uninstall, installing over the old local server) are in `docs/manual/server-app.md`.

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

## Backup and restore

`backup-now` (the "Back up now" tray item) runs five steps on its own thread, so Quit never
waits for it: hold the API over its control channel (`<root>/run/api.sock`, `core::control`, 10 s per command and
120 s for the hold), copy the data folder to `<backupDir>/manual-<UTC stamp>.partial`, rename it to
`manual-<stamp>`, resume the API and show the time as "Last backup" (`state.backup.lastBackup`, read from the newest
complete `manual-*` folder name). While held, `/healthz` is not probed. The API is always resumed, also when the
copy fails; if the resume itself fails the API is restarted. A `.partial` folder is never shown as Last backup and
the next manual backup removes it. Only the 5 newest `manual-*` folders are kept; `pre-upgrade-*` folders are never
pruned and a prune that fails is logged. `backupDir` defaults to `<root>/backups`; it must be absolute, free of `..`
and outside the data folder, compared by real path and device/inode so symlinks are caught, and it is checked again
right before each copy. Quit or a signal during a backup sets a cancel flag the copy reads between chunks and stops
the processes at once.

Pre-upgrade backup. The bundle carries the API's schema version in `resources/api/schema-version` (one line,
`[A-Za-z0-9._-]{1,64}`; the API executable has no way to print it without starting). The bundle step must write
that file next to the API executable; without it the API stays blocked with "the bundled API schema version cannot be
read".
The app records the version it last prepared the data folder for in `<root>/data-schema-version`. Before the API is
started (every start, including restarts), a database that is present while the record is missing or different is
copied to `<backupDir>/pre-upgrade-<bundled version>-<stamp>` and the record is written only after the copy is
whole. With no database the version is just recorded. A failed copy, an unreadable or invalid bundled version or an
unusable `backupDir` leaves the API row failed ("Blocked: <reason>", `supervision.blocked`) and the API is not
started; Restart server runs the check again.

Restore (a card added after the backup is gone):

1. Quit the app.
2. Move the data folder aside: `mv "<dataDir>" "<dataDir>.aside"` (`<root>/data` unless `dataDir` is set).
3. Copy the backup in: `cp -R "<backupDir>/manual-<stamp>" "<dataDir>"`.
4. Open the app.

`<root>/data-schema-version` is not part of a backup. After restoring a backup made under another bundle version,
delete that file so the next start makes a pre-upgrade copy before the API migrates the restored folder.

## Bundle

`pnpm --filter @agent-board/server-app run assemble --build` builds the three artifacts the app carries and collects them
into `src-tauri/resources/` (git-ignored). Without `--build` it takes the existing outputs and names the missing artifact
and the command that builds it; `--api`, `--cli` and `--web` point at pre-built paths. `pnpm … bundle` then runs
`tauri build` and leaves the ad-hoc signed app at
`src-tauri/target/release/bundle/macos/Agent Board Server.app`. No secret is needed.

| Path in `resources/` (and in `Contents/Resources/resources/`) | Content                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api/agent-board-api`                                         | The API single executable (`apps/api` `build:executable`); PGlite assets and migrations are embedded in it |
| `api/schema-version`                                          | The API's last migration tag, read by the pre-upgrade backup                                               |
| `api/version`, `cli/version`                                  | The API and CLI package versions, shown by the tray's version line                                         |
| `cli/board`                                                   | The CLI binary (`apps/cli` `compile`, target `darwin-arm64`), the worker                                   |
| `web/`                                                        | The browser client build (`apps/web` `dist`), served by the API                                            |

The app finds the folder next to its binary in a development build, in `Contents/Resources/resources` inside the `.app`,
and in `AGENT_BOARD_SERVER_RESOURCES` for the test seams.

## Signing

One identity signs the app and every bundled executable. `assemble` signs `api/agent-board-api` and `cli/board` ad hoc
before Tauri seals them into the app, and `tauri.conf.json` signs the app with the ad-hoc identity `-`.
`pnpm … sign:check [<app>]` reads `codesign -d --verbose=4` of the app, its binary and every executable under
`Contents/Resources`, fails when any object is unsigned or the signers differ (ad hoc, or authority and team
identifier) and verifies each with `codesign --verify --strict`. CI runs it on the built app. A named identity is a
matter of replacing `-` and the `codesign` identity in `assemble`; the check does not change.

## Security model

- The API listens on `127.0.0.1:<port>` only and there is no TLS on loopback. With `requestSignature` off, any local
  process can act as the settings user. With it on, only clients paired through "Pair a device…" can; unsigned and badly
  signed requests get 401. `remoteHosts` requires `requestSignature: true`.
- Worker run logs and agent transcripts stay plain on disk outside the data folder, protected only by FileVault (see
  "What stays plain on disk").

## Idle memory

Measured by `test/build-data-at-rest-resources.test.ts` 10 s after the worker is enrolled and idle, with `ps` RSS of the
processes of the headless app (the same binary without AppKit), the API and the worker units. Measured on one Apple
silicon Mac:

| Process               | Measured RSS      | Threshold asserted     |
| --------------------- | ----------------- | ---------------------- |
| API single executable | about 300-350 MiB | below 400 MB (decimal) |
| App plus worker units | about 105 MiB     | below 250 MiB          |

About 175 MiB of the API figure is the Bun executable's own code pages; its physical footprint, the figure Activity
Monitor shows, is about 160 MiB. A first start initialises a new PGlite data folder in a short-lived child process,
because initdb peaks near 1 GiB and the allocator keeps a peak resident for the life of the process. After a burst of
requests the RSS stays near that burst's peak even once the memory is collected: with 1000 open tasks, 8 KiB prompts
each, it measured about 500 MiB. The tray build adds WebKit to the app's own figure; that part is not measured by the
automated run.

## Tests against the real artifacts

`test/end-to-end.test.ts`, `network.test.ts` and `build-data-at-rest-resources.test.ts` run the built binary headless
with the real API, CLI and web build and a stub `claude` from the end-to-end suite. They skip with the missing command
when the artifacts are not built; CI builds them first. The N-1 data folder of server-app-009 is written at test time:
the API's Node build is copied with its last migration removed, run once to create a key setup and a machine, and
stopped. The app then opens that folder with the full migration set after exactly one `pre-upgrade-<tag>-<stamp>` copy.

## Release

`pnpm --filter @agent-board/server-app release 1.0.0 [--notes "..."]` sets the version in `package.json`,
`src/version.ts`, both Cargo manifests and `Cargo.lock`, and writes `CHANGELOG.md` (notes already written under the
version heading are kept). `release:check 1.0.0` then verifies all of them and the built `.app`'s version; then
`pnpm release:tags` creates `server-app-v1.0.0`.
