# Client app: manual walk

Steps that no automated test can drive, because they need real native window chrome, the Dock, notifications or the
macOS Keychain. Each entry names the requirement row it covers in `requirements/catalogue/client-app.md`. The walk
runs once per release on a Mac with macOS 14 or later, against a built app: either the `Agent Board` or
`Agent Board Debug` zip attached to the `client-app-v<version>` release (unzip it outside `/tmp`), or a local build
(`pnpm --filter @agent-board/client-app bundle`, then open
`apps/client-app/src-tauri/target/release/bundle/macos/Agent Board.app`). The debug variant has the same bundle id, so
it shares the Keychain items, the notification permission and the data of the release one, and adds the Web Inspector
(right-click a page, Inspect Element).

## Before you start

**The first launch of the new app deletes data of the OLD client app.** It removes the old app's per-server WebKit
stores, its `tabs/` folder and its Keychain session entry (`<bundle id>.session`). It keeps `servers.json`, so the
server list survives. Do not start the new app on a Mac whose old client app data you still need.

To walk without touching anything that matters, use a throwaway state:

1. Make a new macOS user (System Settings › Users & Groups) and run the walk there, or
2. Back up `~/Library/Application Support/com.mloureiro.agent-board-client` and `~/Library/WebKit/com.mloureiro.agent-board-client`
   first, and restore them afterwards.

Entry 008 needs old-app data on purpose. Every other entry wants a clean state: no `servers.json`, no Agent Board items
in Keychain Access (search `com.mloureiro.agent-board-client`) and no entry for the app in System Settings ›
Notifications.

Other preparation:

- Run an API server that needs no sign-in and add it to the list with its address. A second, unreachable entry (for
  example `http://localhost:1`) is useful for the failure checks of later entries.
- Entries that name a login-mode server or a request-signature server say so at their start.
- Keep the app out of `/tmp`: LaunchServices ignores bundles there, which breaks `agentboard://` links.
- The app is ad-hoc signed, so macOS may refuse to open a downloaded copy on first launch. Remove the quarantine flag
  with `xattr -dr com.apple.quarantine "Agent Board.app"` or approve it in System Settings › Privacy & Security.

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

## 029: split view and keybindings

Run this with a throwaway server and a copy of the settings, never with files you care about. Open at least four
pages in the server window first (Backlog, Schedules, Closed and a task).

1. Select a page tab and choose Tabs › Split Tab (Cmd-Backslash). The tab moves into a new pane on the right, each pane has
   its own tab bar, and home stays in the left pane. With home selected, Split Tab does nothing.
2. Drag the divider between the two tab bars. Both panes resize while you drag, neither goes below a tenth of the
   window width, and the page areas follow the bar. Focus the divider with Tab and nudge it with the arrow keys.
3. Click a page in the right pane, then one in the left pane. The tab bar marks the pane you clicked as the active
   one (its selected tab keeps the accent, the other pane's is muted), and Cmd-W and Ctrl-Tab act on that pane.
4. Drag a tab from one tab bar onto the other. It moves, becomes selected there, and the pane it left selects a
   neighbour. Tabs › Move Tab to Next Pane does the same from the keyboard.
5. Open tabs until the limit: the 21st page does not open, counting both panes. Opening a page that is already open
   in the other pane selects it there.
6. Click the x of a right pane's bar (or Tabs › Close Pane). Its tabs join the pane on the left, and a pane whose
   last tab closes disappears.
7. Quit and open the server again. Both panes, their tabs, selections, the divider position and the active pane
   come back, and only each pane's selected tab loads at first.
8. Quit, then in the app's config folder create `settings.json` containing
   `{"v":1,"keybindings":{"tab-next":"CmdOrCtrl+Alt+N","split-tab":"CmdOrCtrl+Shift+D","close-pane":"nonsense"}}`.
   Open the app: Tabs › Next Tab and Split Tab show the new keys, Close Pane keeps its default, and a file that is
   not valid JSON leaves every default in place. An entry such as `"tab-previous":"CmdOrCtrl+Q"` is ignored.

Expected: panes behave as separate tab bars over one shared tab limit, the layout survives a restart, and a
keybinding changed in `settings.json` takes effect at the next launch while invalid entries fall back to the default.

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

If macOS asks to allow access to a Keychain item after you rebuilt or updated the app, answer Allow. By design,
answering Deny leaves the item in place and unused: a denied session token shows sign-in, and a denied signing key
makes every request to that server fail until you relaunch the app and answer Allow. A denied key is never replaced.
The Deny behaviour is not yet confirmed on a Mac: the "Keychain prompt after an update (S4)" walk records it.

## 040: a notification arrives when another app is in front and when the window is minimised

Use a server that lets you move a task to Needs me (for example by running a machine that asks for input). The first
notification asks for permission: allow it in the system prompt. Quit the app and open it again with the permission
already given before the steps below.

1. Open the server window and select its home tab. Bring another app (for example Notes) to the front, then make a
   task need you.
2. A banner shows with the task title as its title and the server's name under it, and it plays the default sound.
3. Minimise the server window with the yellow button and make another task need you.
4. A second banner shows with that task's title and the same server name.
5. Make the same task need you again within a minute (move it out of Needs me and back). No second banner shows for
   it. After a minute the same change raises a banner again.
6. Run `log stream --predicate 'process == "agent-board-client"' | grep -i "notification"` while repeating a step:
   no line holds a task title.

Expected: every notification carries the task title and the server's name, repeats of one task within 60 seconds are
dropped across tabs and windows, and nothing sealed reaches the log.

## 041: no notification while the server's home tab is in front, and one prompt only

Start with the notification permission still unanswered: remove the app from System Settings › Notifications, or use a
Mac user that never opened the app.

1. Launch the app and open a server. No permission prompt shows at launch.
2. With the server window in front and its home tab selected, make a task need you. No banner shows and no prompt
   shows.
3. Select a task tab (or open another server's window) and make a task need you again. The system asks for
   permission once, and after you allow it the banner shows.
4. Select home in the key window again and repeat. No banner shows.
5. Open a second server window and keep it in front with its own home selected. A task of the first server that needs
   you now raises a banner, because only the server of the key window is silent.
6. Deny the permission in System Settings › Notifications and repeat step 3. Nothing shows, and
   `log stream --predicate 'process == "agent-board-client"'` shows "notification permission denied" once for the
   run.

Expected: nothing is requested at launch, the prompt appears with the first raised notification, a home tab in the
key window stays silent, and a denial is logged once.

## 042: clicking a notification opens the task

1. Raise a banner for a task of an open server while another app is in front, then click it.
2. The server window comes to the front and the task's tab is selected. If the task had no tab yet one opens for it.
3. Raise a banner for a task that already has a tab open and click it. That existing tab is selected and no second
   tab opens.
4. Minimise the window, raise a banner and click it. The window is restored and shows the task tab.
5. Raise a banner for server A, then remove server A from the list and click the banner (from Notification Centre).
   Nothing happens and no window opens.
6. Quit the app, then click a banner left in Notification Centre. The app does not open a task and no window for a
   removed server appears.

Expected: a click lands on the task of that server and only on a server that has a window in this run.

## 016, 050: hidden windows keep notifying (spike evidence and walk)

The spike on macOS 27 (S2) showed that with background throttling off a minimised or covered server window kept its
live view alive for three minutes per state: the SSE stream kept its pace of one event per second, and a 3 second
timer ran at a steady 4 second cadence. Nothing was suspended. The poll of the attention route (row 050) exists for the
macOS versions where this does not hold, and the spike did not cover Cmd-H, display sleep or runs of ten minutes.

1. Open a server and select home. Minimise its window and leave it for ten minutes.
2. Make a task need you every few minutes, at least once after the first five minutes. Each one raises a banner
   within a few seconds, and clicking it restores the window with the task tab selected.
3. Restore the window and check that the board shows the changes made meanwhile without a reload.
4. Repeat steps 1 to 3 with another app fullscreen in front of the window instead of minimising it, and once with
   Cmd-H.
5. Where the live view of a hidden window is still throttled by macOS, the log
   (`log stream --predicate 'process == "agent-board-client"'`) shows "window throttled, polling attention" for the
   server. From then on a task that needs you raises "A task needs you on <server>" within 30 seconds. A task that
   needed you before the poll started raises none of them.
6. Restore the window. The log line does not repeat and polling stops: no further banner with the generic text shows.
7. Sign the server out of its token from another device so the session ends, and leave the window minimised. Restore
   it and check that the tab bar shows "Your session expired. Sign in again to keep receiving notifications."

Expected: a hidden, covered or minimised window keeps raising notifications, the generic poll runs only while
heartbeats are missed, and an expired session shows the banner in the tab bar until the next sign-in.

## 045: zoom acts on every tab of the key server window and not on the tab bar

Open three tabs in a server window and a second server window.

1. Press Cmd-= (and Cmd-Shift-= on a keyboard where the plus key needs shift). The pages of all three tabs grow one
   step. The tab bar keeps its size and its text.
2. Open View › Zoom In, Zoom Out and Actual Size with the same window in front. Each moves the pages along the
   25 to 500 percent ladder (… 90, 100, 110, 125 …) and Actual Size returns to 100 percent.
3. Open a new tab while the window is zoomed. The new tab opens at the same zoom.
4. Switch to the second server window. Its pages are still at 100 percent. Zoom it out and go back to the first one:
   it keeps its own level.
5. With the server list in front, press Cmd-=. Nothing zooms.
6. Quit and open the app again. Every server starts at 100 percent.
7. Click the board background and press Backspace. The page does not go back. Type in a text field and press
   Backspace: characters are deleted as usual.

Expected: zoom follows the key server window, covers all its tabs including new ones, never scales the tab bar, is not
remembered, and Backspace outside a field never navigates back.

## 047: the notification permission survives a rebuild with the same bundle id

You need two builds of the app that differ in content and share the bundle id: for example the release zip of one
version and the zip of the next, or two local `bundle` runs with a change between them. Use a Mac user that never
answered the notification prompt for this app.

1. Open build A and a server, select a task tab (or another window) so the home tab is not the key one, and make a
   task need you. The system asks for permission once. Allow it.
2. In System Settings › Notifications, the entry for the app reads Allow Notifications on. Quit the app.
3. Replace build A with build B (same name, same location) and open it.
4. Make another task need you. A banner shows and no permission prompt shows. The Notifications entry still reads
   Allow Notifications on and no second entry exists.
5. Repeat the steps with `Agent Board Debug` in place of build B. It shows banners without a prompt and without a
   second entry, because it has the same bundle id.

Expected: the permission is tied to the bundle id and not to the code signature, so an ad-hoc rebuild keeps it. If a
prompt shows again after step 3, record it: the row no longer holds.

## 048: runs on macOS 14 and later, on Apple silicon and Intel

1. Check the bundle without launching it: `lipo -archs "Agent Board.app/Contents/MacOS/agent-board-client"` prints
   `x86_64 arm64`, and
   `/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "Agent Board.app/Contents/Info.plist"` prints `14.0`.
2. On an Apple silicon Mac with macOS 14 or later, open the app, add a server and open it. The board loads.
3. On an Intel Mac with macOS 14 or later, repeat step 2 with the same zip. If no Intel Mac is at hand, run
   `arch -x86_64 "Agent Board.app/Contents/MacOS/agent-board-client"` on Apple silicon (Rosetta) and check that the
   list window shows.
4. On a Mac with macOS 13 or older, open the app. macOS refuses with a message that the app needs a newer macOS
   version, and nothing launches.

Expected: one universal bundle runs on both architectures from macOS 14 and does not start earlier.

## Keychain prompt after an update (S4)

An update that is signed ad hoc has a new code identity, and macOS treats it as a different app for the Keychain
items written by the previous build. The spike (S4) showed that the new build cannot read those items silently: the
read blocks on the system's Keychain access dialog until you answer, and with interaction switched off it fails
instead of returning the value. Run this walk when you move from one build to the next with a signed-in server.

1. With build A, sign in to a login-mode server (or pair with a signature-on server) so its `.client-token` item (and
   its `.signing-key` item) exist. Quit the app.
2. Replace build A with build B (a rebuild or the next release), keeping the bundle id. Open it and open that server.
3. macOS shows a dialog that the app wants to use confidential information stored in the Keychain, naming the item.
   One dialog shows per item that is read: the token and, for a signature-on server, the signing key. Answer Allow, or
   Always Allow to stop it for this build.
4. The server opens signed in with no new code. Quit and open it again: with Always Allow no dialog shows, with Allow
   it shows again.
5. Update to a later build C and open the server. The dialogs show again, because Always Allow applies to the build it
   was given to.
6. Repeat from step 2 and answer Deny. The item stays in the Keychain and the app treats it as absent: a denied token
   shows sign-in, and a denied signing key makes requests to that server fail until you relaunch the app and answer
   Allow. The app never replaces a denied key. The spike could not answer the dialog, so this behaviour is described by
   the design and is not yet confirmed on a Mac: record what you see.
7. While a dialog waits, the rest of the app stays responsive: other windows and the list still work.

Expected: one prompt per Keychain item per update, never a crash or a silent loss of a session, and a denial reads as
an absent item.

## Acceptance walk: release build to Done

The end-to-end check of a release. Use the zip attached to the `client-app-v<version>` release, on a clean state
(see "Before you start"), with the server app of the same release train on the same Mac.

1. Unzip `Agent-Board.zip` outside `/tmp`, remove the quarantine flag if macOS blocks it, and open the app once. The
   list window shows with no server. The first launch ran the cleanup of the old app's stores.
2. Start the server app. In its tray menu choose "Open board". The client app comes to the front, a server window
   opens for the server app's address, and the list gains an entry for it. If the client app is not installed, the
   browser opens instead. Without a server app at hand, send the same handover link by hand as in entry 013.
3. If the server asks you to sign in, sign in through the hand-off, or pair with a code, as in the entries above. The
   board shows.
4. Create a card with New task (a short prompt for a machine you have connected). The card appears in Backlog or Todo.
5. Let it run. The card moves through Running and reaches Done, and the board updates without a reload. If a task asks
   for you on the way, a native notification shows when the home tab is not in front, and clicking it opens the task.
6. Quit with Cmd-Q and open the app again. The server window comes back with its tabs, the board shows the card in Done,
   and no sign-in is asked.
7. Repeat steps 2 to 4 with `Agent Board Debug`. It reaches the same server with the same sign-in, and right-click
   Inspect Element opens the Web Inspector.

Expected: from a clean Mac and a release zip, the server app hands the server over, a created card runs to Done, and
a restart keeps the session.
