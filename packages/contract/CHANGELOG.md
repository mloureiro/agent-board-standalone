# Changelog

## Unreleased

`auth.handoff.approve` is marked `issuesCredential`: approving binds a flow started elsewhere to the caller, and that flow's finish then returns a session, so the wrappers refuse it from page code like the other credential routes.

## 1.0.0

First release. It declares the contract level 1 with the minimum client levels per client kind, the minimum server level, the named feature list and the pure compatibility check every part calls. It holds the error table with one HTTP status per code and the common error lists per auth kind, the shared enums and size limits, and the shared tables as data: sealed-value limits and zod helpers, session cookie names and token prefixes, response headers, the request-signature canonical string, the server address rule, the handover link, worker unit names and doctor check ids, with the address and handover cases and the client app bundle id also written as JSON. It declares the route table in full: 58 machine routes, 75 client routes and 15 public routes (version, health, pairing and sign-in, with the hand-off finish, pairing and the other credential routes marked `issuesCredential`), each with strict request and response schemas, its own error codes and its feature and module marks. It defines `BoardExport` version 1, the JSON Lines format a migration or an account export writes and an import reads, with one record schema per table. The build writes `dist/openapi.json`, an OpenAPI 3.1 document generated from the route table, next to the JSON case tables.
