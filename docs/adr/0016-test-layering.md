# ADR-0016: Test layering

## Status

Accepted.

## Context

The E2E suite is written first and connects API, CLI and browser client (R4.1). Most tests live in each part's
own suite (R4.2). Every catalogue row maps to a test or a written manual walk (R4.3, R4.5). There is no WKWebView
driver for macOS.

## Decision

- Unit and integration tests in each part with Vitest. The API's integration tests run against real Postgres 16 and
  PGlite.
- The E2E suite runs a real API in both database modes, the built CLI with a stub `claude` on its `PATH`, and the
  browser client served by the API's web module, in Playwright projects for Chromium and WebKit at desktop and
  phone viewports.
- **Fixtures.** Most E2E tests run the API in no-login mode. Sign-in rows run it in login mode against a fake OIDC
  provider process the harness starts, configured through `OIDC_*`; passkey rows use Chromium's virtual
  authenticator. The suite may import `sealing` (and `contract`) to unlock keys for fixtures and to assert that no
  column holds plaintext; it imports no part's code.
- Wrappers keep their native layer thin: Rust logic is covered by `cargo test`, with the contract's JSON case
  tables as vectors; the bundled client runs under Playwright with a fake bridge; the rest is a manual walk in
  `docs/manual/`.
- Every test title carries its catalogue row id in brackets. `pnpm catalogue:check` fills the Test ids column and
  fails on an active row with no test and no manual reason. Retired rows carry Test `retired`.
- E2E tests written before their part are listed in `e2e/expected-red.json`. The job fails when a listed test passes
  or an unlisted test fails; each part's work removes its ids until the list is empty.

## Consequences

- `main` stays green while the E2E suite starts red.
- A row moves between `e2e` and `part` only with the test that covers it.

## Rows affected

repo-003, repo-006, repo-009 (new), every row's Test ids column.
