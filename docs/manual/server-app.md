# Server app: manual walk

Steps that no automated test can drive, because they need the real tray, the macOS Keychain, launchd, a second Mac
or the owner's real data. Each entry names the requirement row it covers in
`requirements/catalogue/server-app.md`. The walk runs once per release on a Mac with macOS 14 or later, against a
built app: the `Agent Board Server` zip attached to the `server-app-v<version>` release (unzip it outside `/tmp`), or a
local build (`pnpm --filter @agent-board/server-app bundle`, then open
`apps/server-app/src-tauri/target/release/bundle/macos/Agent Board Server.app`).

Terms used below:

| Term          | Meaning                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `<root>`      | `~/Library/Application Support/Agent Board Server`, or the folder `AGENT_BOARD_SERVER_ROOT` points at |
| `<port>`      | `port` in `<root>/settings.json` (default 4785)                                                       |
| `<app>`       | the installed `Agent Board Server.app`                                                                |
| `<resources>` | the `resources` folder that sits next to the app's executable, holding `api/`, `cli/` and `web/`      |
| `<owner>`     | the user name of the board's owner, as exported from the old board                                    |

## Before you start

The app writes to the Keychain (service `dev.mloureiro.agent-board-server`), to `~/Library/LaunchAgents` and to
`<root>`. To walk without touching anything that matters, use a throwaway state:

1. Make a new macOS user (System Settings › Users & Groups) and run the walk there, or
2. Run entries 023, 090 and restore with `AGENT_BOARD_SERVER_ROOT=<scratch folder>` set for the launch (the root has
   its own Keychain service and never touches the login item), for example
   `AGENT_BOARD_SERVER_ROOT=/Users/<you>/server-walk "<app>/Contents/MacOS/agent-board-server"`.

Entries 060, 062 and 087 need the default root, the real Keychain and the login item, so they run only in the new
macOS user. The new app has its own bundle id, root, Keychain service and launch agent label, so it coexists with the
old local server. Both default to port 4785: set `port` in `<root>/settings.json` to a free number while the old server
runs.

Other preparation:

- `claude` and `gh` installed and signed in, for the worker entries.
- The client app installed for entry 023 step 7, and uninstalled (or renamed) for step 8.
- The app is ad-hoc signed, so macOS may refuse to open a downloaded copy on first launch. Remove the quarantine flag
  with `xattr -dr com.apple.quarantine "Agent Board Server.app"` or approve it in System Settings › Privacy & Security.
- Keep the app out of `/tmp`: LaunchServices ignores bundles there.

## 023: the tray (text, mark, Open board)

1. Launch the app. No window opens and there is no Dock icon, only an icon in the menu bar.
2. Click the icon. The items, top to bottom: Open board; the rows `API: …`, `Worker not connected`,
   `Last backup: never`; the version line; Restart server, Back up now, Restart worker, Disconnect worker, Check
   worker; Open logs folder, Open settings file; Connect worker…, Pair a device…; Quit. The rows and the version line
   are grey.
3. Wait until the row reads `API: Running`. Open board, Back up now and Connect worker… are enabled. Restart worker,
   Disconnect worker and Check worker are grey. Pair a device… is grey while `requestSignature` is not `true` in
   `<root>/settings.json`.
4. Read the version line: `server app <X> · API <Y> · CLI <Z>`. The three versions are the release's. After you
   rename `<resources>/api/version` and reopen the app, the line reads `API unknown`; rename it back.
5. Quit the app. In a terminal run `nc -l <port>` (this holds the port), then open the app. The tray icon carries a `!`
   and hovering it shows the API row's text (the port is in use). Stop `nc` with Ctrl-C and click Restart server. The
   row reads `API: Running` again and the `!` disappears.
6. Click Open logs folder and Open settings file. Finder shows `<root>/logs` and the default editor opens
   `<root>/settings.json`.
7. With the client app installed, click Open board. The client app comes forward and shows or adds the server
   `http://127.0.0.1:<port>/`. No browser window opens.
8. Quit the client app and rename it so that LaunchServices cannot find it, then click Open board. The default browser
   opens `http://127.0.0.1:<port>/` and the board loads.

Expected: the menu text, the order and the enablement are as listed, the `!` follows the failing row and clears when
it recovers, and Open board reaches the client app first and the browser second.

## 023: Connect worker… window

1. With the API running, click Connect worker…. A small window opens in front. The two fields show dots, one per typed
   character, and a count beside each (`0 characters`). The Connect button is disabled while a field is empty. The
   window shows no machine name.
2. Paste a wrong token and a wrong data key and click Connect. The window shows `Connecting…`, the fields are locked
   and the close button does nothing until the answer arrives.
3. The answer is the refusal's reason. Nothing is stored: `Worker not connected` stays on the tray, and Keychain Access
   (search `dev.mloureiro.agent-board-server`) holds no `worker-token` or `worker-data-key` item.
4. Paste the real token and data key and click Connect. The window shows `Connected as <machine>` and the fields are
   empty. Close the window. The tray row now reads `Worker: …` and Restart worker, Disconnect worker and Check worker are
   enabled.
5. While a connect is running (for example with a slow worker host), open the tray menu. Only Open board, Connect
   worker… and Quit are enabled.
6. Click Check worker. The check log opens and the worker row shows `check: N problem(s)`.
7. Click Disconnect worker. The row reads `Worker not connected` and the two Keychain items are gone.

Expected: the secrets are only ever shown as dots and counts, a refusal stores nothing, and the window cannot be closed
mid-connection.

## 090: Pair a device

Set `"requestSignature": true` in `<root>/settings.json`, quit and reopen the app.

1. Click the tray icon. Pair a device… is enabled once the API row reads `Running`.
2. Click it. A small window shows a code such as `ABCD-2345` and the time it is valid until (10 minutes from now).
3. In a browser on this Mac open `http://127.0.0.1:<port>/`. The board reports that it needs pairing. Enter the code.
   The board opens. Use the code again in a private window. It is refused: a code works once.
4. Click Pair a device… again and wait 11 minutes. The new code is refused as expired.
5. Open `<root>/logs/app.log`. It says `pairing code issued` and holds no code.

Remote devices with a tunnel:

6. Add the tunnel's host name to `remoteHosts` in `<root>/settings.json` and set `requestSignature` to `true`. Quit and
   reopen the app.
7. On this Mac run `tailscale serve --bg <port>` (or the tunnel tool in use), then note the HTTPS address it prints.
8. On a second device in the same tailnet open that address. The board reports that it needs pairing. Click Pair a
   device… on the tray, type the code on the second device. The board opens there.
9. Run `tailscale serve reset` when done.

Expected: only a paired device gets in, a code is single-use and short-lived, and no code is in any log.

## 060: Keychain prompt after an ad-hoc rebuild

New macOS user only. Connect a worker first (entry 023, step 4 of the Connect window).

1. Quit the app. Install a rebuild of the same version over `<app>` (build it again with `bundle`, or take a second
   release asset), remove the quarantine flag and open it.
2. macOS asks whether `Agent Board Server` may use the Keychain item `dev.mloureiro.agent-board-server`. Choose
   Always Allow (once per item, up to the token and the data key).
3. The worker row reaches `Worker: ok` without enrolling again.

Expected: the prompt appears after an ad-hoc rebuild, "Always Allow" ends it and the worker runs.

## 087: Keychain across same-identity rebuilds

New macOS user only. The two builds are signed with the same signing identity (the one the release script names, not
ad-hoc).

1. Connect a worker and quit the app.
2. Install the second build over the first, remove the quarantine flag and open it.
3. No Keychain prompt appears and the worker row reaches `Worker: ok`.

Expected: a rebuild signed with the same identity reads the Keychain without a prompt.

## 062: launchd relaunch

New macOS user only, release build installed in `/Applications`, `startAtLogin` left at its default.

1. Open the app once. `~/Library/LaunchAgents/dev.mloureiro.agent-board-server.plist` exists.
2. Log out and log in again. The app is running (tray icon present) without being opened.
3. In a terminal run `pgrep -x agent-board-server` and note the number, then `kill -9 <number>`.
4. Within about 10 seconds `pgrep -x agent-board-server` prints a new number and the tray icon is back. The old
   API and worker processes (`pgrep -fl agent-board-api`) are gone or replaced: no orphan of the killed run remains.
5. Click Quit. After 30 seconds `pgrep -x agent-board-server` prints nothing.
6. Open the app, then open it a second time (`open -n "<app>"`). The second launch exits at once, the first keeps
   running and `pgrep -x agent-board-server` prints one number 30 seconds later.
7. Log out while the app runs. After logging in the app starts once (a single `pgrep` number).

Expected: a crash or kill is relaunched in about 10 seconds with its orphans swept, and Quit, logout and a second
launch are not relaunched.

## 006: a clean Mac

A Mac (or a fresh macOS user and VM) with no Docker, Postgres, Node or Caddy installed and with `claude` and `gh`
signed in.

1. Copy the app to `/Applications` and open it. The tray icon appears and the API row reads `API: Running` within a
   minute.
2. Run entry 023 steps 1 to 4 and 7 to 8, the Connect window entry and entry 090.
3. `which docker psql node caddy` prints nothing before and after.

Expected: the app runs the board and the worker with nothing else installed.

## 084: plain files on disk

1. Open `apps/server-app/README.md` and read the section "What stays plain on disk".
2. It says that worker run logs and agent transcripts stay plain on disk outside the data folder and are protected by
   disk encryption only.

Expected: the README states it.

## Restore from a backup

1. Open the app, add a card to the board, click Back up now and wait for `Last backup: <date>` to change.
2. Add a second card, then Quit.
3. In a terminal: `mv "<data>" "<data>.aside"` then `cp -R "<backups>/manual-<stamp>" "<data>"`. `<data>` and `<backups>`
   are `dataDir` and `backupDir` of the settings (`<root>/data` and `<root>/backups` by default); `<stamp>` is the newest
   folder.
4. Open the app. The first card is there and the second is gone.

Expected: the documented restore brings back the state at the backup.

## Uninstall

1. Quit the app. Run `"<app>/Contents/MacOS/agent-board-server" --uninstall`. It lists what it removed: the launch
   agent (default root only) and the Keychain items. `<root>` is untouched.
2. In Keychain Access search `dev.mloureiro.agent-board-server`: nothing is left. `~/Library/LaunchAgents` holds no
   `dev.mloureiro.agent-board-server.plist`.
3. Run it again with `--delete-data` only when you want the app folder gone: `<root>` disappears, and a data or backup
   folder outside it is printed and left.
4. Drag `<app>` to the Trash.

Expected: a clean removal that keeps the data unless `--delete-data` is given.

## Step 13: install over the old local server

Preparation by the owner. Nothing here uses the old server's data folder in place.

1. Quit the old local server from its tray menu and remove its login item according to its README, so it no longer
   starts at login. Keep its data and its worker folder.
2. Copy the new `Agent Board Server.app` to `/Applications` and remove the quarantine flag. Do not open it yet.
3. Create the app folder and settings by hand: `mkdir -p "<root>"` and write `<root>/settings.json` with
   `{"userName": "<owner>"}`. The value must equal the owner name exported from the old board; opening the app without
   it derives a name from the macOS login and the import refuses.
4. Migrate with the bundled API into the data folder, before the first start. Follow `docs/manual/migrate.md` steps 5
   to 9 with `<api-exe>` set to `<resources>/api/agent-board-api` and `--target-db pglite://<root>/data`.
5. Open the app. The API row reads `Running`. Compare the counts with the old board (migrate step 10), then open the
   board in the browser (step 11) and one task (step 12).
6. Click Connect worker…, paste the worker's existing token and data key (the pair the old setup used) and click
   Connect. The window shows `Connected as <machine>` with the migrated machine's name.
7. Wait for the worker row to read `Worker: ok`, then create a test task and check that the worker picks it up.
8. Check Keychain Access for `dev.mloureiro.agent-board-server` items and `<root>/logs/app.log` for errors.

Expected: the board opens with the old content, the migrated machine runs on the new app, and the old server stays
stopped until the owner decides to remove it.
