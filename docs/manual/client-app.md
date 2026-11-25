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
