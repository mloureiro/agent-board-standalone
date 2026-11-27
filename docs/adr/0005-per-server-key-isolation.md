# ADR-0005: Per-server isolation inside one browser client

## Status

Accepted.

## Context

One client shows several servers, each with its own sign-in, keys, drafts and cache, and two entries for the same
address must share none of them (web-085). The old desktop client isolated servers with one WebKit data store
each. That cannot work in a plain browser, which has one origin, and it rules out showing several servers on one
board (web-086).

## Decision

- Every server entry has a random id. Each id owns a namespace: an IndexedDB database `rumo:<serverId>`
  (non-extractable data keys, signing key, client token when cross-origin) and `localStorage` keys prefixed
  `ab:<serverId>:` (drafts, volatile state).
- The query cache is held in memory only, per server, and never persisted.
- Code reads and writes storage only through a namespace object obtained for a server id; a lint rule bans direct
  `localStorage`, `sessionStorage` and `indexedDB` access outside the storage module.
- Removing a server deletes exactly its namespace. Lock and sign-out clear their slice of it.
- The same mechanism applies in the plain browser, the client app and Android. The client app opens one window
  per server plus an "All servers" window for the combined board.
- The server app's local server is opened from the client app or from its own origin. The server app sets no
  `ALLOWED_ORIGINS`, so a page served by another server cannot reach it.

## Consequences

- Isolation against a hostile server's content rests on the CSP and sanitised rendering, not on separate origins.
- Keys stored by the old desktop client do not carry over; each server is unlocked once after the move.
- A plain browser on a hosted server's page cannot include the local server; the client app can.

## Rows affected

web-004, web-025, web-085, web-086, web-095, web-100, web-102 (new), client-app-005, client-app-007,
client-app-016.
