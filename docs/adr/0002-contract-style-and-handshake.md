# ADR-0002: Contract style and the version handshake

## Status

Accepted.

## Context

Today the browser talks tRPC, which couples client and server at the type level, while the CLI talks a hand-written
machine API. The plan asks for one source of truth that any client can implement, versions each side can check,
and a published description. tRPC and OpenAPI were both acceptable to the owner.

## Decision

- The contract is a package of zod 4 schemas and a route table. Each route declares method, path, auth kind
  (`public`, `client`, `machine`), request, response, errors, and `issuesCredential` when it returns a token or
  binds a key.
- Transport is plain HTTP with JSON: `POST /api/machine/<command>`, `GET` and `POST /api/client/<name>`, public
  `/api/version`, `/api/auth/*`, `/api/pair`, `/healthz`.
- An OpenAPI document is generated from the route table and attached to every contract release.
- Events are SSE. Clients read them from a streamed `fetch` with their own parser, never `EventSource`.
- The contract declares `CONTRACT` (an integer break level), `MIN_CLIENT` per kind, `MIN_SERVER` and `FEATURES`.
  Additive changes add a feature. One pure `compat` function returns compatible, client too old, client too new,
  or the features a client needs that the server lacks.
- Clients send `x-board-contract` and `x-board-client` on every request. Below `MIN_CLIENT`, or without
  `x-board-contract` on a client or machine route, the server answers 412 `upgrade-required` before any read or
  write. Public routes, `/healthz` and static files need no header.
- `GET /api/version` is public, CORS-open without credentials, and reports contract, minimums, features, server
  version, enabled modules and the state of the credential sent (`not-required`, `none`, `valid`, `expired`).
- The connection check is one `GET /api/version`, no redirects, 5 s connect and 10 s total. Up means status below
  500, compatible, a session that is valid or not required, and no pairing needed. `needs-pairing` is reported when
  the server requires signatures and the client holds no bound key, or a request got 401 `key-unknown`. Transient
  failures retry twice (1 s, 3 s).
- Shared tables live in the contract as data: address rule, header table, cookie names and token prefixes,
  handover message, worker unit recipe, doctor check ids, board export format, request-signature canonical string.

## Consequences

- Any third party can implement a client from the OpenAPI document plus the sealing package.
- A route served but not declared, or declared but not served, fails a test in the API.
- "Signed out" and "needs pairing" are reported by the same single request that reports "up".

## Rows affected

contract-001 … contract-011, contract-013 … contract-015 (new), api-012, api-096, api-098, api-115 (new),
web-077, web-078, web-091, web-092, cli-003, cli-004, cli-011.
