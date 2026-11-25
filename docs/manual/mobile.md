# Manual walk: Android app (mobile-007)

Walk this once per release of `mobile`, on a physical Android phone (Android 8 or newer; Android 13 or newer to see
the notification permission prompt). The automated suites cover the bridge rules, the bundled client at phone sizes
and the notification logic; this walk covers what only a phone shows.

## What you need

- A Mac running the server app, with the server app's port (shown in its tray menu as `http://127.0.0.1:<port>`).
- A Tailscale account on the Mac and the phone, with HTTPS enabled for the tailnet (any https tunnel or reverse proxy
  that forwards to the loopback port works the same way; ADR-0013 option a).
- The APK: the `agent-board-mobile-apk` artifact of a green `Mobile APK` run, or the file attached to the
  `mobile-v<version>` release. Debug runs are signed with a throwaway key: uninstall an older build before installing
  a newer one signed with a different key.

## 1. Expose the server app over https

1. On the Mac, run `tailscale serve https / http://127.0.0.1:<port>` and note the host name it prints, for example
   `https://my-mac.tail1234.ts.net`.
2. In the server app, open Settings and add that host name (without the scheme) to **Remote hosts**.
3. Turn **Request signature** on.
4. Restart the server app.

Expected: the tray menu shows the server running again; `https://<host name>/healthz` opens in the Mac's browser and
answers `ok`.

## 2. Install and add the server

1. Copy the APK to the phone and open it. Allow installs from that source when Android asks.
2. Open **Agent Board**.
3. Open **Servers**, choose **Add server**, enter a name and the tunnel address (`https://<host name>`) and confirm.
4. Android shows a native confirmation naming the server and its address. Accept it.

Expected: the confirmation is a system dialog (not part of the page); the server appears in the list; adding
`http://<any non-loopback host>` is refused with the insecure-address message.

## 3. Pair the phone

1. The page shows **Pairing needed**.
2. On the Mac, open the server app's tray menu and choose **Pair a device…**; a code like `ABCD-1234` appears.
3. Enter it on the phone within ten minutes and submit.

Expected: the page leaves the pairing form. Entering a wrong or reused code shows "The pairing code was refused or
has expired." and stays on the form. In the server app, Settings › Devices lists the phone.

## 4. Sign in

1. If the page shows the sign-in screen, choose **Sign in with your browser**.
2. The system browser opens the server's approval page; approve it (use a passkey if the server has one).
3. Return to the app.

Expected: the app signs in without asking for a credential itself; the board loads.

## 5. Use the board

1. Create a card on the board, send it to Todo, and let an agent run it to Done.
2. Open **Servers** and confirm the server shows as up.
3. Open a link inside a task transcript that points to another site.

Expected: the card moves through the columns on the phone as on the desktop; the external link opens in the system
browser, not inside the app.

## 6. Back button and drafts

1. Open the New task form and type a few words without sending.
2. Press the Android back button.
3. Reopen the New task form.

Expected: back leaves the form and moves within the client (it never closes the app while there is history); the
typed words are still there when the form is reopened.

## 7. Notifications

1. In Settings › Notifications, turn **Notifications** on. Allow the Android notification permission.
2. Confirm an ongoing "Watching for tasks that need you" notification is present.
3. Press Home, then make a task reach Needs me (for example by asking a question from the Mac).
4. Wait up to one minute.
5. Tap the notification.

Expected: a notification reads "A task needs you on <server name>" with no task title; tapping it opens the app on
that task. Turning **Notifications** off removes the ongoing notification and stops the service.

## 8. Sign out and remove

1. Sign out from the app; the page returns to the sign-in screen.
2. Remove the server from **Servers** and accept the native confirmation.

Expected: the server leaves the list; adding it again asks for pairing again (its key and token were deleted from the
phone).

## Known limits to note while walking

- On Android 15 or newer the watching service (foreground type `dataSync`) is limited to about six hours in a day;
  after that Android stops it, and notifications resume the next time the app is opened with notifications on.
- A tapped notification opens the task on the app's active server; the client has no server in its task addresses.
- A server whose certificate is not from a public authority is not trusted (ADR-0013 option b, not built).
