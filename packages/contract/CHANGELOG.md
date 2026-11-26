# Changelog

## Unreleased

`machine.list-projects` lists the owner's projects with their sealed names and icons, so a machine can show names to its user. It is marked with the new `machine-projects` feature: a server that does not advertise it has no such route, and the CLI falls back to project ids. The contract level stays 1.

A request-signature key id is the 43-character base64url SHA-256 the sealing package derives (`signingKeyId`), not a 16-hex data-key id. `signingKeyIdString` accepts that form, and the 16-hex form older device rows hold. It is used by the device list and revoke, the pairing answer, the machine key registration answer and the export's device rows, which refused every real signing key id before.

`auth.handoff.approve` is marked `issuesCredential`: approving binds a flow started elsewhere to the caller, and that flow's finish then returns a session, so the wrappers refuse it from page code like the other credential routes.

## 1.0.0

First release. It declares the contract level 1 with the minimum client levels per client kind, the minimum server level, the named feature list and the pure compatibility check every part calls. It holds the error table with one HTTP status per code and the common error lists per auth kind, the shared enums and size limits, and the shared tables as data: sealed-value limits and zod helpers, session cookie names and token prefixes, response headers, the request-signature canonical string, the server address rule, the handover link, worker unit names and doctor check ids, with the address and handover cases and the client app bundle id also written as JSON. It declares the route table in full: 58 machine routes, 75 client routes and 15 public routes (version, health, pairing and sign-in, with the hand-off finish, pairing and the other credential routes marked `issuesCredential`), each with strict request and response schemas, its own error codes and its feature and module marks. It defines `BoardExport` version 1, the JSON Lines format a migration or an account export writes and an import reads, with one record schema per table. The build writes `dist/openapi.json`, an OpenAPI 3.1 document generated from the route table, next to the JSON case tables.
