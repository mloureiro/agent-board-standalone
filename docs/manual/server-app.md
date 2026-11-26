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
   worker; Open logs folder, Open settings file; Connect worker…, Pair a device…, Set up…; Quit. The rows and the
   version line are grey. Set up… is always enabled.
3. Wait until the row reads `API: Running`. Open board, Back up now and Connect worker… are enabled. Restart worker,
   Disconnect worker and Check worker are grey. Pair a device… is grey while `requestSignature` is not `true` in
   `<root>/settings.json`, and while remote access is on.
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

Pairing is for devices that reach the board on this Mac without sign-in. With remote access on (next entry) the API
runs with sign-in, Pair a device… is grey, and a device signs in through the browser hand-off instead.

Expected: only a paired device gets in, a code is single-use and short-lived, and no code is in any log.

## 089: Remote access and first passkey

The board is reached from anywhere through a tunnel, and then needs sign-in with passkeys everywhere. Have Tailscale
Funnel or `cloudflared` installed on this Mac, and a phone that is not on this Mac's network (mobile data).

1. Click Set up… on the tray (it also opens by itself on the very first launch). Section 1 shows the two tunnel
   commands with this app's port filled in.
2. Run one of them in a terminal: `tailscale funnel --bg <port>` (prints an `https://…ts.net` address) or
   `cloudflared tunnel --url http://127.0.0.1:<port>` (prints an `https://…trycloudflare.com` address).
3. Paste the https address into the field and click Turn on. The API restarts; `<root>/settings.json` now holds
   `publicUrl` and every other key as before. Typing an `http://` address, a path or a port is refused and the file is
   left as it was.
4. Section 2 now offers Create my first passkey. Click it. The window shows the name to sign up with and a one-time
   token, and the default browser opens `<publicUrl>/`.
5. In Safari or Chrome at `<publicUrl>/`, sign up with that name and the token and add a passkey. The board opens with
   your existing boards (the account is the one the board used without sign-in).
6. Back in the window click I added my passkey. The API restarts and the token is gone: signing up again with it is
   refused.
7. Sign out in the browser and sign in again with the passkey.
8. On the phone's browser, off the LAN, open `<publicUrl>/`. Sign in with your browser: the phone shows a code;
   approve it from the signed-in browser on this Mac. The board opens on the phone.
9. Open `http://127.0.0.1:<port>/` on this Mac in a private window. It asks for sign-in too: there is no board
   without sign-in while remote access is on. Click Open board on the tray with the client app closed: the browser
   opens `<publicUrl>/`.
10. Open `<root>/logs/app.log` and `<root>/logs/api.log`. Neither holds the token.
11. Click Turn off in Section 1. The API restarts without sign-in, `publicUrl` and `remoteHosts` are gone from the
    settings file, and `<publicUrl>/` answers with an error. Stop the tunnel (`tailscale funnel reset` or Ctrl-C).

The same steps run without the window, from a terminal, with the app's binary
`"<app>/Contents/MacOS/agent-board-server"`: `setup status`, `setup remote --public-url https://<host>`,
`setup first-passkey` (prints the address, the name and the token on three lines), `setup first-passkey --done` and
`setup remote --off`. Each changing command ends with the sentence to restart the server from the tray or to reopen
the app; click Restart server to apply.

Expected: remote access always means sign-in, the token works only for the board's own name and only while the step is
open, and nothing secret reaches a log.

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

Follow `docs/manual/install.md`: it takes the owner from the release builds through the migration, the Set up window,
the worker and the clients to the final walk, and leaves the old local server and its data untouched.
