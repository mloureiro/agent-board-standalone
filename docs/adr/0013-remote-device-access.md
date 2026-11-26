# ADR-0013: Remote devices reaching a server app

## Status

Accepted. The owner chose option a. Option b stays conditional and parked.

## Context

The server app binds loopback only and runs no-login. The address rule requires https for anything but loopback.
An Android phone must still be able to open the same server as the desktop clients.

## Decision

| Option | Mechanism                                                                                                                                                                                                                                                                                    | Status              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| a      | Any https tunnel or reverse proxy forwarding to loopback (for example Tailscale Funnel or Cloudflare Tunnel). Its https origin goes into the server app's `publicUrl`, which runs the API in login mode with passkeys and the request signature on; the phone signs in through the hand-off. | Chosen; base design |
| c      | A hosted API in login mode with a public https URL. The phone signs in through the hand-off.                                                                                                                                                                                                 | Base design         |
| b      | The server app binds the LAN with a self-signed certificate (API `tls` module). The wrappers pin its SHA-256 fingerprint, shown by the server app, when the server is added.                                                                                                                 | Conditional, parked |

- Option a is login mode, never no-login: a board reachable beyond loopback always needs sign-in. With `publicUrl`
  set the server app runs the API with `AUTH_MODE=login`, `PUBLIC_URL`, `PASSKEYS=on`, `REQUEST_SIGNATURE=on` and the
  tunnel host added to `ALLOWED_HOSTS`. Without it the API stays no-login on loopback.
- `remoteHosts` (extra host names, for a second tunnel or proxy) needs `publicUrl`; on its own it is refused, since it
  used to expose a board without sign-in.
- The owner's first passkey: while the setup flow's first-passkey step is open the API also gets `SIGNUP_TOKEN` and
  `CLAIM_USER=<userName>`, so sign-up admits only the board's own name and takes over that account when it has never
  signed in. Closing the step removes both.
- Pairing codes stay for devices on loopback without sign-in; the API refuses them in login mode, so "Pair a device…"
  is off while remote access is on.
- `TRUST_PROXY` stays unset: every tunnelled request counts as loopback for the sign-in rate limit, which a remote
  flood can slow but not bypass.
- Options a and c need nothing beyond the base design: allowed hosts, sign-in, the request signature and the hand-off.
- Option b is built only if chosen later, as conditional sub-iterations in the server-app and Android work. It adds
  a contract address-rule case (https with a pinned fingerprint, wrappers only) without changing any other case.

## Consequences

- The phone walk uses a tunnel such as `tailscale funnel` to the server app's port, turns remote access on in the
  server app's setup window (or `agent-board-server setup remote --public-url …`), creates the first passkey, and
  signs the phone in through the hand-off.
- With remote access on, browsers on the Mac itself also sign in: the API has one sign-in mode per process.
- No base component assumes the phone is on the same network as the Mac.
- A plain browser cannot use option b, because it cannot pin a certificate.

## Rows affected

api-121 (new), api-124 (new, conditional), server-app-089 (new), server-app-090 (new), server-app-091 (new,
conditional), mobile-009 (new, conditional), mobile-010 (new), contract-007.
