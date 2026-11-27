# Manual walk: Android app (mobile-007)

Walk this once per release of `mobile`, on a physical Android phone (Android 8 or newer; Android 13 or newer to see
the notification permission prompt). The automated suites cover the bridge rules, the bundled client at phone sizes
and the notification logic; this walk covers what only a phone shows.

## What you need

- A Mac running the server app with remote access on (`install.md` section 4.1): a tunnel to the server's port, its
  https address `<public-url>` (for example `https://my-mac.tail1234.ts.net`) set in **Set up…**, and your first
  passkey made (section 4.2). The board then signs everyone in with passkeys (ADR-0013 option a).
- A way to use that passkey on the phone: a passkey kept in a password manager the phone shares, a security key, or the
  cross-device sign-in (the phone's browser shows a QR code that the Mac or another phone with the passkey scans).
- The APK: the `rumo-mobile-apk` artifact of a green `Mobile APK` run, or the file attached to the
  `mobile-v<version>` release. Debug runs are signed with a throwaway key: uninstall an older build before installing
  a newer one signed with a different key.

## 1. Reach the server over https

1. On the phone's browser open `<public-url>/healthz`. It answers `ok`.
2. Open `<public-url>`. The board shows the sign-in page, never the board itself: it runs no-login only on the Mac's
   own address while remote access is off.

Expected: the server answers through the tunnel and asks for sign-in.

## 2. Install and add the server

1. Copy the APK to the phone and open it. Allow installs from that source when Android asks.
2. Open **Rumo**.
3. Open **Servers**, choose **Add server**, enter a name and `<public-url>` and confirm.
4. Android shows a native confirmation naming the server and its address. Accept it.

Expected: the confirmation is a system dialog (not part of the page); the server appears in the list; adding
`http://<any non-loopback host>` is refused with the insecure-address message.

## 3. Sign in with the one-time code

1. The page shows the sign-in screen. Choose **Sign in with your browser**. The page shows a code.
2. The phone's browser opens the server's approval page with the same code. Sign in there with your passkey and
   approve. Approving from a browser on the Mac instead works too: open the approval link there and compare the code.
3. Return to the app.

Expected: the app signs in without asking for a credential itself, and the board loads. The code works once: a
second approval of the same flow is refused.

## 4. Pairing code (only without remote access)

"Pair a device…" in the server app's tray gives a one-time code for a board that runs without sign-in. With remote
access on it is greyed out and the API refuses pairing codes, so this section does not apply to the phone walk.

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
