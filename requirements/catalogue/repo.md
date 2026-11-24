# repo — repository-wide

Rows no single part owns: licence, independence of parts, version matrix. Columns are explained in
[../README.md](../README.md).

| ID       | Requirement                                                                                                                                                                                                                     | Sources                           | Today | Test | Test ids |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----- | ---- | -------- |
| repo-001 | Only a wrapper depends on what it wraps: API, CLI and browser client import no code from each other and share only the versioned `contract` and `sealing` packages; a lint or build check fails on any other cross-part import. | R1.1                              | new   | part |          |
| repo-002 | Each part installs and runs alone: the client app without the CLI, the CLI without any app, the API without the server app, the Android wrapper without any desktop part.                                                       | R1.2                              | new   | part |          |
| repo-003 | CI runs each part at version N against the other parts at version N-1 (compatibility matrix).                                                                                                                                   | R1.4                              | new   | part |          |
| repo-004 | The repository is MIT-licensed with a `LICENSE` file from the first commit, every package declares `MIT`, and no code is copied from the upstream or the three old repositories.                                                | R3.8                              | works | part |          |
| repo-005 | Each part has one version and a changelog; its release states the contract versions it supports.                                                                                                                                | R1.3, CLAUDE.md                   | new   | part |          |
| repo-006 | Format, lint, typecheck and tests run in CI on every push for every part; the Tauri wrappers also build and test on macOS.                                                                                                      | SRV-105                           | works | part |          |
| repo-007 | Nothing in the repository holds a secret, a private path or the owner's data; the migration tool's real-data test runs only on a local copy.                                                                                    | ORCHESTRATION (public repository) | new   | part |          |

## Added by the architecture

| ID       | Requirement                                                                                                                                                                               | Sources        | Today | Test | Test ids |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- | ---- | -------- |
| repo-008 | Each part releases as a tag `<part>-v<semver>`; the matrix takes as N-1 the newest tag below the version at `HEAD`, and a part with no release passes its cells with "no N-1 for <part>". | R1.4, ADR-0001 | new   | part |          |
| repo-009 | E2E tests written before their part are listed in `e2e/expected-red.json`; the E2E job fails when a listed test passes or an unlisted test fails.                                         | R4.1, ADR-0016 | new   | part |          |
