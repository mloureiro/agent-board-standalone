# ADR-0007: Server app to client app handover

## Status

Accepted.

## Context

"Open board" in the server app must open the local server in the client app when it is installed, and in the
default browser otherwise (server-app-014). The message must be versioned (contract-012).

## Decision

- The message is a deep link `rumo://open?v=1&url=<percent-encoded server URL>`. The contract exports the
  scheme, the version, the client app's bundle id, and `buildHandover` and `parseHandover`.
- The contract also writes the handover cases and the bundle id as JSON. Both Tauri wrappers run those cases as
  vectors in `cargo test`, so the Rust parser and the TypeScript parser agree without sharing code.
- The server app runs `open -b <bundle id> <link>`. A non-zero exit falls back to `open <server URL>`.
- The client app registers the scheme with the Tauri deep-link plugin. It accepts only loopback URLs without
  credentials; anything else only brings the server list forward. A cold launch holds the link until setup
  finishes.
- No discovery protocol.

## Consequences

- Any local app can send the link, so it never carries a secret (no pairing code, no token).
- A newer client app can read older `v` values; an unknown `v` brings the list forward with a message.

## Rows affected

contract-012, server-app-014, client-app-013, client-app-014, client-app-015.
