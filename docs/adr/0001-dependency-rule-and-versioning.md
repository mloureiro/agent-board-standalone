# ADR-0001: Dependency rule, versions and the N vs N-1 matrix

## Status

Accepted.

## Context

The repositories this one replaces failed mostly at their seams: a shared package pinned to a commit, hand-written
constants, a server and client released at different times with no negotiation. The parts here must install and
run alone (R1.2) and work by declared versions (R1.3), with CI proving N against N-1 (R1.4).

## Decision

- **Code dependencies.** API, CLI and browser client import no code from each other. They share only
  `@agent-board/contract` and `@agent-board/sealing`. The API uses `sealing` for envelope shape checks and
  signature verification only. An ESLint `no-restricted-imports` rule per part fails on any other import across
  parts.
- Wrappers depend on what they wrap and nothing else.
- **Data dependencies are allowed.** A part may read a data file another part publishes. The contract writes JSON
  case tables (address cases, handover cases, the client app's bundle id) that the Tauri wrappers read as test
  vectors in `cargo test`.
- Workspace dependencies carry a range (`workspace:^1.0.0`), so the install fails when a shared package leaves the
  range a consumer declared.
- **Release bundles.** A release bundle may carry another part's pinned release artifact: the server app ships the
  API executable, the CLI binary and the browser client build; the client app and Android ship the browser client
  build.
- Each part has one semver version and a `CHANGELOG.md`, and releases as a tag `<part>-v<semver>`.
- N-1 of a part is its newest release tag with a version lower than `HEAD`'s. The matrix job builds N-1 of API,
  CLI and browser client from their tags and runs the `@matrix` E2E subset in four cells (API N × CLI N-1,
  API N × web N-1, API N-1 × CLI N, API N-1 × web N). A test needing a feature the older peer lacks is skipped
  with the feature named.
- When `HEAD` raises `CONTRACT` and its minimums no longer admit the N-1 peer, that cell asserts the refusal
  instead of running the suite.
- A part with no release has no N-1; its cells pass with "no N-1 for <part>".

## Consequences

- A breaking change to `contract` shows up as range bumps in every consumer in the same pull request.
- Only one version of each shared package exists in the workspace at a time; older peers are exercised through
  built artifacts, not workspace links.
- The Rust wrappers and the TypeScript parts test the same address and handover cases without sharing code.
- The matrix becomes meaningful from each part's second release.

## Rows affected

repo-001, repo-002, repo-003, repo-005, repo-008 (new), contract-007, contract-009, contract-012, server-app-088.
