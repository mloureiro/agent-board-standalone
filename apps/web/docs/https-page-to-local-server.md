# An https page reaching a server on this computer

Measured with Playwright 1.65.1 against Chromium 159 and WebKit 27.2 on macOS. The page was an `https://` document
served through request interception, so its origin is a public https name; the target was a plain `http://` server
on `127.0.0.1`, `localhost` and `[::1]` that answers CORS preflights and streams a body.

| Browser  | Condition                                             | `fetch` plain, with contract headers, and streamed body |
| -------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Chromium | https page, no local network permission               | Blocked: "Permission was denied ... `loopback` address" |
| Chromium | https page, `local-network-access` permission granted | Works, including the streamed body                      |
| Chromium | http page                                             | Blocked: the client is not a secure context             |
| WebKit   | https page                                            | Blocked as mixed content, whatever the permissions      |
| WebKit   | http page (control)                                   | Works                                                   |

## Consequences for the browser client

- A server entered as `http://127.0.0.1:<port>` works from an https-served client only in Chromium, and only after
  the user grants the Local Network Access prompt. The prompt cannot be shown or granted from page code.
- Safari and every WebKit browser never reach it. The client app and the Android wrapper do, because they go
  through the native bridge.
- The server list's Test reports a failed fetch to an `http:` server from an `https:` page as unreachable and adds
  the explanation above (`describeConnection` with `reachesHttpFromHttps`). It is treated as unsupported, never as
  a bug of the server.

## Not verified

- A real public https site with Chrome's permission prompt in a headed profile. The permission was granted through
  Playwright; the prompt itself, its remembered choice and Chrome versions before Local Network Access shipped were
  not exercised.
- Firefox, which is not part of the E2E projects.
- `https://localhost` pages: the table covers only a public https origin.
