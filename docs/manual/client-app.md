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
   "Close Tab".
5. Click the yellow minimise button. The window moves to the Dock, and clicking its Dock tile brings it back.
6. Press Cmd-Q. The app quits and its Dock icon disappears: no process stays behind (`pgrep -x agent-board-client`
   prints nothing).

Expected: the server window can only be minimised, Cmd-Q quits everything and there is no background mode.

## 011: the Dock icon shows the server list

1. Launch the app. Only the list window opens and no server loads.
2. Press Cmd-W with the list window in front. The list window closes (File › Close Tab acts on the list window
   when it is the front one). If a server window is open it stays.
3. Click the app's Dock icon. The list window opens again, in front.
4. Click the Dock icon while the list is already open. It stays a single window, brought to the front.

Expected: the Dock icon always brings the server list back, and Cmd-W closes only the list window.

## 027: menus and tab shortcuts

Open two or three pages in the server window first (click a task card, then open Backlog and Schedules from the
home board); each opens in its own tab.

1. Open the File menu. Its only item is "Close Tab" (Cmd-W). Open the Edit menu: Undo, Redo, Cut, Copy, Paste and
   Select All are there; type in a page field and check that Cut, Copy, Paste and Select All act on it.
2. Open the Window menu. It holds Minimize and no Close Window item.
3. Open the Tabs menu. It holds Next Tab (Ctrl-Tab), Previous Tab (Ctrl-Shift-Tab) and Select Tab 1 to 9
   (Cmd-1 to Cmd-9).
4. Press Cmd-2. The first page tab is selected and the tab bar marks it. Press Cmd-9 with fewer tabs open. Nothing
   changes.
5. Press Ctrl-Tab once with the page focused, once after clicking the tab bar, and once with a text field focused.
   Each press moves exactly one tab to the right and wraps from the last tab to home. Ctrl-Shift-Tab moves left.
6. Press Cmd-W on a page tab. It closes and a neighbour is selected. Press Cmd-W on home. Nothing happens.
7. Middle-click a page tab in the tab bar. It closes. Middle-clicking home does nothing.
8. Cmd-click a task card on the board. A new tab opens for the task and the click does not navigate the current
   tab. Click a link to another website, if the board shows one. Nothing loads in the tab.
9. Quit and open the server again. The same tabs come back in the same order with the same one selected, and only
   that tab loads at first (the others load when first selected).

Expected: every menu item and shortcut acts on the front server window's tabs, home never closes, and a page
can never take the tab to another website.

## 022: two tabs share the sign-in

Use a server that needs a sign-in (a login server), or a signature-on server that needs pairing.

1. Open the server window and sign in (or pair) on the home tab.
2. Open a second tab (click a task card). The board shows signed in with no sign-in step and no pairing prompt.
3. Reload nothing: in the second tab open Settings. The page shows its content without asking to sign in again.
4. Sign out in the second tab. Switch to home. It shows the signed-out state within a few seconds.
5. Sign in once more in home and select the second tab. It shows signed in without any extra step.

Expected: all tabs of a server share one sign-in and one set of keys, so a new tab opens already signed in and
unlocked, and signing out in one tab signs every tab out.

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

## 033, 037, 038, 052: sign in through the hand-off, survive a restart and sign out

Use a login-mode API that has a passkey or other account you can sign in with in your browser, and add it to the
list.

1. Open the server. The page shows "Sign in with your browser" and a code.
2. Click the sign-in button. Your default browser opens the server's approval page on the server's own address, not
   inside the app window. Sign in there by any method and approve the code.
3. The app window signs in on its own within a few seconds and shows the board. The code was never typed in the app.
4. Quit the app with Cmd-Q and launch it again. Open the same server. It is still signed in with no new code.
5. In Keychain Access, search for `com.mloureiro.agent-board-client`. One item per signed-in server exists under the
   `.client-token` service, with the server's id as account. If the server has the request signature on, a
   `.signing-key` item exists as well.
6. Use the sign-out button in the app. The page shows sign-in again, and both Keychain items for that server are gone.
7. Click a link to another website inside a task. The default browser opens it and the app window stays responsive.

Expected: the token is created and kept by the app alone, the approval page opens only in the default browser, a
restart keeps the session, and sign-out deletes the token and the signing key of that server only.

## 037: a revoked session returns to sign-in within 25 s

1. Sign in to a login-mode server as above.
2. In your browser, sign in to the same server and revoke the app's session in Settings.
3. Within 25 seconds the app window shows sign-in again, and the `.client-token` item for that server is removed
   from the Keychain.
4. Sign in again through the hand-off. The expired notice disappears.

Expected: a revoked session is noticed by the next request, the stored token is removed and a new sign-in clears the
expired state.

## 052: pair with a server app code

Use a no-login API with the request signature on, for example the server app or `agent-board-api` started with
`REQUEST_SIGNATURE=on`.

1. Add the server and open it. The page shows `needs-pairing` and asks for a code.
2. In the server app choose "Pair a device…" (or run `agent-board-api pair`) and read the `XXXX-XXXX` code.
3. Enter the code in the app. The page leaves `needs-pairing` and shows the board.
4. In Keychain Access, a `.signing-key` item exists for that server's id. Quit and relaunch the app: the board still
   opens with no new code.
5. Repeat with a wrong code. The page reports that pairing failed, and no new `.signing-key` item is left behind.
6. In the server's Settings, revoke the device. The next request shows `needs-pairing` again.

Expected: the key never leaves the Keychain except as its public half, a failed pairing leaves nothing, and
revoking the device returns the page to `needs-pairing`.

If macOS asks to allow access to a Keychain item after you rebuilt or updated the app, answer Allow. Answering Deny
makes the app treat the item as absent: sign in or pair again.
