# ADR-0013: Remote devices reaching a server app

## Status

Accepted. The owner chose option a. Option b stays conditional and parked.

## Context

The server app binds loopback only and runs no-login. The address rule requires https for anything but loopback.
An Android phone must still be able to open the same server as the desktop clients.

## Decision

| Option | Mechanism                                                                                                                                                                                                                  | Status              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| a      | Any https tunnel or reverse proxy forwarding to loopback (for example `tailscale serve`). Its host name goes into the server app's `remoteHosts`; the request signature must be on; the device pairs with a one-time code. | Chosen; base design |
| c      | A hosted API in login mode with a public https URL. The phone signs in through the hand-off.                                                                                                                               | Base design         |
| b      | The server app binds the LAN with a self-signed certificate (API `tls` module). The wrappers pin its SHA-256 fingerprint, shown by the server app, when the server is added.                                               | Conditional, parked |

- Options a and c need nothing beyond the base design: allowed hosts, the request signature and pairing.
- Option b is built only if chosen later, as conditional sub-iterations in the server-app and Android work. It adds
  a contract address-rule case (https with a pinned fingerprint, wrappers only) without changing any other case.

## Consequences

- The phone walk uses a tunnel such as `tailscale serve` to the server app's port, with `remoteHosts` and
  `requestSignature` set, and pairs the phone with "Pair a device…".
- No base component assumes the phone is on the same network as the Mac.
- A plain browser cannot use option b, because it cannot pin a certificate.

## Rows affected

api-121 (new), api-124 (new, conditional), server-app-089 (new), server-app-090 (new), server-app-091 (new,
conditional), mobile-009 (new, conditional), mobile-010 (new), contract-007.
