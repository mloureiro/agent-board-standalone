# ADR-0012: Request signature module and its threat model

## Status

Accepted.

## Context

The owner wants an optional signature between API and clients, typically off on a local server (R3.6). On
loopback with no login, any local process can act as the user. Through a tunnel, a no-login server would be open
to anyone who can reach the tunnel.

## Decision

- With `REQUEST_SIGNATURE=on`, every client and machine request is signed with an ECDSA P-256 key the server has
  bound.
- Headers: `x-board-key`, `x-board-ts`, `x-board-nonce`, `x-board-sig`, plus `Content-Digest` for bodies. The
  canonical string (method, path with query, timestamp, nonce, digest) is defined in the contract. The sign and
  verify primitives are in the sealing package, which the API uses to verify.
- The header signature is checked before the body is read (401 on failure, 401 `key-unknown` for a key the server
  does not know); the digest after. Timestamps must be within 120 s; nonces are single use within that window and
  stored in a table purged hourly.
- Binding: at sign-in finish in login mode (the key belongs to the session); by one `register-key` command per
  issued machine token; by `POST /api/pair` with a one-time `XXXX-XXXX` code (10 minutes, single use) in no-login
  mode.
- Pairing codes come from the API's control channel. The server app's "Pair a device…" asks for one;
  `agent-board-api pair` is a client of `CONTROL_SOCKET` and never opens the database, so it works while the API
  runs.
- Wrappers pair through the bridge command `pair(serverId, code, label)`, which sends the Keychain or Keystore
  public key; page code never sees the key or calls `/api/pair` itself.
- Clients report `needs-pairing` when the server requires signatures and they hold no bound key.
- Keys are listed and revoked in Settings › Devices.
- No-login with a non-loopback bind or allowed host requires the signature on.

## Consequences

- A stolen cookie or token alone is not enough while the module is on.
- Against malware running as the same macOS user the signature is a hurdle, not a boundary: such malware can read
  the Keychain after a prompt or the browser's storage files.
- Browsers keep a non-extractable key per server namespace; wrappers and the CLI sign natively.

## Rows affected

api-022, api-039, api-120 (new), api-121 (new), api-122 (new), contract-014 (new), cli-083 (new), web-091,
web-104 (new), client-app-052 (new), mobile-010 (new), server-app-083, server-app-090 (new).
