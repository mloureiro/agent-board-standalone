# Client app: manual walk

Steps that no automated test can drive, because they need real native window chrome, the Dock or the macOS
Keychain. Each entry names the requirement row it covers in `requirements/catalogue/client-app.md`. The walk runs on
a Mac with macOS 14 or later, against a built app (`pnpm --filter @agent-board/client-app bundle`, then open
`apps/client-app/src-tauri/target/release/bundle/macos/Agent Board.app`).

Preparation: run an API server that needs no sign-in and add it to the list with its address. A second, unreachable
entry (for example `http://localhost:1`) is useful for the failure checks of later entries.

## 010: a server window cannot be closed

1. Open the server from the list. A window titled with the server's name opens and shows its board.
2. Look at the window's title bar. The close button is disabled (grey, no hover symbol).
3. Press Cmd-W with the server window in front. Nothing happens and the window stays.
4. Open the Window menu. It holds Minimize and no Close Window item. Check the File menu too: its only item is
   "Close List Window".
5. Click the yellow minimise button. The window moves to the Dock, and clicking its Dock tile brings it back.
6. Press Cmd-Q. The app quits and its Dock icon disappears: no process stays behind (`pgrep -x agent-board-client`
   prints nothing).

Expected: the server window can only be minimised, Cmd-Q quits everything and there is no background mode.

## 011: the Dock icon shows the server list

1. Launch the app. Only the list window opens and no server loads.
2. Press Cmd-W with the list window in front. The list window closes. If a server window is open it stays.
3. Click the app's Dock icon. The list window opens again, in front.
4. Click the Dock icon while the list is already open. It stays a single window, brought to the front.

Expected: the Dock icon always brings the server list back, and Cmd-W closes only the list window.

## 003, 006, 007: the server list manages entries

1. Launch the app. In the list window, add a server with a name and the address of the running API. The row
   appears with Open, Rename and Remove.
2. Submit the form with a blank name. The text "Give the server a name." appears and nothing is added. Submit an
   `http://` address that is not on localhost. The text about using https appears.
3. Click Rename, change the name and save. The row shows the new name. If the server window is open its title
   changes too.
4. Add an entry with the address `http://localhost:1` and click Open. No window opens and the list shows
   "<name> could not be opened: …" with that entry's name.
5. Click Remove on the unreachable entry and confirm. The row disappears, and no error about stored data shows.
6. Click "All servers". A window opens that shows the boards of the servers that have an open window.

Expected: every action in the list reports its outcome in the list, with the entry's name in each error.

## 013: a handover link opens or adds the server (cold and warm)

Run the API on a loopback port, for example `http://localhost:4000`, and keep the app out of `/tmp` (LaunchServices
ignores bundles there).

1. Quit the app. In a terminal run `open 'agentboard://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F'`.
2. The app launches cold, the list window shows, and a server window named `localhost:4000` opens with the board.
   The list holds one new entry with that name.
3. With the app still running, run the same command again. The existing window comes to the front and the list
   holds no second entry.
4. Run the command for a second API on another port. A second window opens with a name that
   includes its port.
5. Run `open 'agentboard://open?v=2&url=http%3A%2F%2Flocalhost%3A4000%2F'`. No window opens, the list comes to
   the front and shows that the link's version is not understood.
6. Run `open 'agentboard://open?v=1&url=http%3A%2F%2Fexample.com%2F'`. The list comes to the front and nothing is
   added.

Expected: the cold and the warm link both reach the app once, a known address is opened and an unknown loopback
address is added, and a link that is not acceptable only brings the list forward.

## 008: launch removes the old app's stores

Do this only on a Mac where the previous Agent Board client was used, and only when its data may be deleted.

1. Check that `~/Library/Application Support/com.mloureiro.agent-board-client/tabs` exists and that
   `security find-generic-password -s com.mloureiro.agent-board-client.session` finds an item.
2. Launch the new app once.
3. The `tabs` directory is gone, the Keychain query finds nothing, and `servers.json` next to it is unchanged.

Expected: the old per-server stores, tab files and session items are deleted at launch and the server list is kept.

When `servers.json` cannot be read in full, the app keeps a copy as `servers.json.unreadable` next to it. While that
copy exists, launch and the list page delete no store of servers missing from the list; delete the copy once the list
is put right.
