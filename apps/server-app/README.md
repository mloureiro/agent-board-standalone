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
