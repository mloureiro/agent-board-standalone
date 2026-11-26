# Install from release builds (step 13)

One document from the release builds to the final walk. Follow it top to bottom on the Mac that will run the board.
The other manuals hold the detailed walks it points to: `server-app.md`, `client-app.md`, `mobile.md`, `migrate.md`.

Nothing in this document reads, changes or deletes the old apps' data. The new server app
(`Agent Board Server`, `dev.mloureiro.agent-board-server`) and the new client app (`Agent Board Client`,
`dev.mloureiro.agent-board-client`) install beside the old local server and the old `Agent Board` client. Remove the
old apps yourself, and only once the new ones have passed the walk.

| Placeholder    | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `<repo>`       | a clone of `mloureiro/agent-board-standalone` on `main`                       |
| `<root>`       | `~/Library/Application Support/Agent Board Server`                            |
| `<app>`        | `/Applications/Agent Board Server.app`                                        |
| `<server>`     | `"<app>/Contents/MacOS/agent-board-server"`, the server app's executable      |
| `<port>`       | `port` in `<root>/settings.json` (default 4785)                               |
| `<public-url>` | the https address of the tunnel, for example `https://my-mac.tail1234.ts.net` |
| `<owner>`      | the board owner's user name                                                   |

## 0. What you need

- macOS 14 or later, `gh` signed in to GitHub, and `claude` signed in for the worker.
- For remote access: a Tailscale account with HTTPS and Funnel enabled for the tailnet, or a Cloudflare account with
  `cloudflared` installed. Remote access is optional and off until you turn it on in section 4.
- An Android phone (Android 8 or newer) for section 8.

## 1. Get the release builds

No `*-v1.0.0` tag exists before your walk passes, so the builds come from workflow runs on `main`. Start them once,
after the last change you want to test has merged:

```bash
gh workflow run ci.yml --repo mloureiro/agent-board-standalone --ref main
```

```bash
gh workflow run release-assets.yml --repo mloureiro/agent-board-standalone --ref main -f dry-run=true
```

```bash
gh workflow run mobile-apk.yml --repo mloureiro/agent-board-standalone --ref main
```

When the three runs are green, download each artifact into an empty folder outside `/tmp` (`<run>` is the run id
`gh run list --repo mloureiro/agent-board-standalone --workflow <file> --branch main --limit 1` prints):

| Part                                           | Workflow             | Artifact                  |
| ---------------------------------------------- | -------------------- | ------------------------- |
| Server app (bundles the API, the CLI, the web) | `ci.yml`             | `server-app-adhoc-signed` |
| Client app (release and Debug)                 | `release-assets.yml` | `agent-board-client-app`  |
| Android                                        | `mobile-apk.yml`     | `agent-board-mobile-apk`  |

```bash
gh run download <run> --repo mloureiro/agent-board-standalone -n server-app-adhoc-signed
```

Unzip with `ditto -x -k <zip> .`. The apps are ad-hoc signed: remove the quarantine flag with
`xattr -dr com.apple.quarantine "<name>.app"` before the first open, and expect one Keychain prompt per item after
every rebuild (choose Always Allow). The CLI for another host is inside the server app at
`<app>/Contents/Resources/cli/board`.

The icons in these builds are placeholders until the owner's icon files are in `assets/icons/` (see section 10).

## 2. Install the server app

1. Quit the old local server from its tray and stop it starting at login (its README says how). Keep its data.
2. Copy `Agent Board Server.app` to `/Applications` and remove the quarantine flag.
3. If you migrate a board (section 3), do not open the app yet: write `<root>/settings.json` with
   `{"userName": "<owner>"}` first, where `<owner>` is the name the old board exports. Without a migration, open the
   app now: it creates its settings and opens the Set up window by itself.

Both servers default to port 4785. While the old server still runs, set `port` in `<root>/settings.json` to a free
port.

## 3. Migrate the board

Follow `migrate.md` from "Before you start" to step 12, with the bundled API executable
`<app>/Contents/Resources/api/agent-board-api` and `--target-db pglite://<root>/data`. The migration runs before the
first start of the app, always first into a scratch copy, and never against the old board in place: for the rehearsal
set up the old system, create and run a few cards, then migrate a copy of its data folder.

When `run` has printed `count check passed` for the real data folder, open the app. It shows a tray icon and no Dock
icon; wait for `API: Running`.

## 4. Set up (server app)

Open the tray menu and choose **Set up…** (it opened by itself if the app created its settings). Work through the
sections in order. Every step has a command-line equivalent for a terminal or a script; a command that changes the
settings tells you to click **Restart server** in the tray afterwards.

```bash
<server> setup status
```

### 4.1 Remote access (optional, off by default)

With remote access on, the board is reachable from anywhere through an https tunnel, by a plain browser or the phone,
and **everyone signs in with a passkey**, this Mac's browser included. With it off, the board answers on this Mac only
(`http://127.0.0.1:<port>`) and needs no sign-in.

1. Start a tunnel to the server's port and note the https address it prints, one of:
   - Tailscale Funnel (public internet): `tailscale funnel --bg <port>`. `tailscale serve --bg <port>` instead keeps
     it inside your tailnet.
   - Cloudflare: `cloudflared tunnel --url http://127.0.0.1:<port>` (a temporary `trycloudflare.com` address; use a
     named tunnel for an address that lasts).
2. In **Remote access**, paste the address and click **Turn on**. The API restarts in sign-in mode; the board is no
   longer open without sign-in, on this Mac too.

```bash
<server> setup remote --public-url <public-url>
```

The address must be `https://` with a bare host name. Changing the tunnel's address means turning remote access on
again with the new one, and the passkeys made for the old address no longer work: keep a stable address.

### 4.2 First passkey

1. In **Sign-in**, click **Create my first passkey**. The window shows your user name and a one-time sign-up token,
   and opens `<public-url>` in the browser.
2. In the browser choose **Create account**, enter the user name and the token exactly as shown, and create the
   passkey (Touch ID, iCloud Keychain, a security key or a password manager).
3. The board opens with your data. Back in the window, click **I added my passkey**. The token stops working.

```bash
<server> setup first-passkey
```

```bash
<server> setup first-passkey --done
```

Add a second passkey from the board's Settings › Account › Passkeys (**Add passkey**) in a plain browser, for example
the phone's, so that losing one device does not lock you out. The client app and the Android app refuse to register
passkeys.

### 4.3 Worker

Click **Connect worker…** and paste the worker's existing token and data key (after a migration, the pair the old
setup used). The window shows `Connected as <machine>`; the tray row reaches `Worker: ok`. The detailed walk is
`server-app.md`, "023: Connect worker… window".

A worker on another host uses the CLI from section 1:

```bash
board init --url <public-url> --token-file <token file> --data-key-file <data key file>
```

Create a card in the browser and check that it reaches Done.

### 4.4 Phone

Needs remote access on. Section 8 walks it.

### 4.5 Keys that can wait

These two keys matter only for the builds you keep after the walk (section 9). Until then the APK is signed with a
throwaway key and the CLI checks update checksums only.

- **Android release keystore.** From `<repo>`: `sh scripts/keys/android-keystore.sh`. It creates the keystore outside
  the repository and prints the two `gh secret set` commands for `MOBILE_KEYSTORE_B64` and `MOBILE_KEYSTORE_PASSWORD`.
  Back up the keystore and its password: an APK signed with another key cannot update the installed app.
- **CLI update signing key (minisign).** From `<repo>`: `sh scripts/keys/minisign-init.sh`. The secret key and its
  password stay on your Mac and off GitHub (back them up). Commit `apps/cli/update-key.pub` and merge it **before the
  CLI release build you keep**: the CLI embeds the public key at build time, and a CLI built earlier trusts no key and
  never refuses an unsigned update.

## 5. Client app

1. Unzip `Agent-Board-Client.zip`, copy `Agent Board Client.app` to `/Applications`, remove the quarantine flag.
2. In the server app's tray choose **Open board**: the client app opens and adds the server. With remote access on,
   the client signs in with **Sign in with your browser**: approve the code in a browser where you are signed in.
3. Walk `client-app.md` in file order. Its acceptance walk ends with a card reaching Done.

## 6. Plain browser

1. Open the board (`<public-url>`, or `http://127.0.0.1:<port>` with remote access off). With remote access on, sign
   in with your passkey; from a device off your network too.
2. The board shows every project, and one project when filtered.
3. Clear the site's `localStorage` and reload: nothing you would miss is lost.

## 7. Server app walk

Walk the entries of `server-app.md`, including "Remote access and first passkey". The entries that need the real
Keychain, login item and launchd run only on the default root.

## 8. Android

1. Install the APK from section 1 on the phone.
2. Walk `mobile.md` from the start: add the server with `<public-url>`, choose **Sign in with your browser**, sign in
   with your passkey in the browser that opens and approve the one-time code it shows. The phone needs no pairing code
   in this mode.

## 9. Finalise step 13

Only after the walk has passed:

1. Owner's icons: put them in `assets/icons/` (section 10) and merge.
2. Keys: run the two scripts of section 4.5, set the two secrets, commit and merge `apps/cli/update-key.pub`.
3. Tags: push the `*-v1.0.0` tags of every part (each part's CHANGELOG lists its release steps). A CLI release stays a
   draft until you sign it: `pnpm --filter @agent-board/cli release:sign cli-v1.0.0`.
4. Install the tagged builds over the walked ones the same way as section 1. The data, the passkeys and the worker
   stay.
5. Remove the old local server and the old `Agent Board` client when you no longer need them.

## 10. Icons

The owner's icons replace two files: `assets/icons/client-app.png` (client app and Android) and
`assets/icons/server-app.png` (server app), each a 1024×1024 PNG. Then, from `<repo>`:

```bash
pnpm icons
```

Commit the regenerated icon files of the three apps, merge, and build again.

## If something goes wrong

- Turn remote access off (`<server> setup remote --off`, then Restart server): the board is back on this Mac only,
  without sign-in. Stop the tunnel (`tailscale funnel --bg off <port>` or quit `cloudflared`).
- The migration never changed the old board: the old local server can start again from its own data.
- `<root>/logs/app.log` and `<root>/logs/api.log` hold the reasons the tray rows show.
