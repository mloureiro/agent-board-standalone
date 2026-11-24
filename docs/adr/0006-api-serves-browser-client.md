# ADR-0006: The API serves the browser client; the server app has no front

## Status

Accepted.

## Context

A plain browser opening any server, hosted or local, needs the browser client served from somewhere. Today a
separate front (Caddy for hosted boards, a Rust proxy in the local server) serves it and proxies the API, with
header tables kept equal by tests.

## Decision

- The API gains a `web` module: with `WEB_ROOT` set it serves the browser client's static build (GET and HEAD,
  immutable `/assets/`, `index.html` fallback, traversal and symlink protection, byte ranges).
- Every answer, API or static, carries the single header table declared in the contract.
- Origin and `Sec-Fetch-Site` checks on writes move into the API.
- The server app drops its front. The API binds `127.0.0.1:<port>` directly.
- During a backup the API is held over its control channel and answers 503 with the data headers, instead of the
  front's 502.
- An access log is an API option (`ACCESS_LOG`).

## Consequences

- One process less in the server app, and no proxy rules to keep equal.
- While the API restarts the port is closed; the browser client shows its "not answering, retrying" banner
  (web-006).
- Front-only rows (hop-by-hop stripping, header dropping, unbuffered proxying, 502 when the API is down) are
  retired.

## Rows affected

server-app-010, 012, 017, 024, 028, 034, 035, 057, 070, 073, 075 … 083; api-107 … api-112 (new); web-079.
