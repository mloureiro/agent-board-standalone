# Dropped and replaced inventory rows

Every inventory row is either in the catalogue (see [sources.md](sources.md)) or here with a reason (R2.1).

## Dropped (no catalogue row)

| Source  | Reason                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API-003 | A migration of the old schema (owner backfill). The new schema has an owner on every row from its first migration; old data enters only through the migration tool (migrate-001…008).                                          |
| API-007 | `DEV_AUTH_USER` is an upstream compatibility alias of the no-login user. Upstream is cut (Q6); one name is enough.                                                                                                             |
| API-094 | Server-side drafts. R3.4 names "drafts in progress" as volatile state that stays in browser storage (web-064, web-065).                                                                                                        |
| WEB-080 | Managing plugins and feeds from the browser was rejected on security grounds in the core (plugins install code on worker hosts). Run, pause and resume stay (web-070).                                                         |
| APP-080 | A silent `Notification` stand-in injected into non-home tabs. The client app no longer loads server pages, so nothing is injected (client inventory §5); notifications go through the bridge (client-app-002, client-app-040). |
| APP-089 | "Native" versus "board" tabs chosen by path. Every page is the bundled browser client (client-app-001), so there is one kind of tab.                                                                                           |
| APP-090 | A build check that the old shell's own pages ship without React. An implementation choice of the old shell, not a behaviour.                                                                                                   |
| APP-097 | Auto-update of the client app. Out of scope (plan, Q13).                                                                                                                                                                       |
| APP-099 | Signed and notarised builds. Out of scope (plan, Q13); passkeys go through the browser hand-off instead (client-app-033).                                                                                                      |
| APP-101 | Grouping, reordering, search, icons and import/export of the server list. Declared out of scope where it was discussed and not asked for in the plan.                                                                          |
| SRV-065 | Enrolment with the data key only (app mints the token). The owner decided to keep pasting both (server-app-047).                                                                                                               |
| SRV-106 | "No build is published because upstream has no licence." The repository is MIT (repo-004); the remaining limits (no notarisation, auto-update, Intel, Linux, Windows) are the plan's out-of-scope list.                        |
| SRV-109 | `core.pin.json`, the previous pin, the includes and the fork integration branches (`P`, table 2.3): gone; versions become workspace versions.                                                                                  |
| SRV-110 | `pnpm core:build` (`P`, table 2.3): gone; the API and CLI build as ordinary workspace parts (api-019, cli-063).                                                                                                                |
| SRV-112 | `pnpm core:bump` and its contract diff (`P`, table 2.3): gone; the contract diff becomes the versioned contract and the N-1 matrix (contract-001, repo-003).                                                                   |
| SRV-116 | Installing one pin of the old local server on the owner's Mac. Superseded by plan step 13 (install, migrate, owner's walk) and migrate-009.                                                                                    |

## Replaced `P` rows (server inventory table 2.3)

Each row below maps to new catalogue rows instead of keeping the pin-shaped behaviour.

| Source  | Table 2.3 artefact                                           | Replaced by                           | Reason                                                                                                            |
| ------- | ------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SRV-010 | Docker Caddy parity smoke                                    | web-079                               | Caddy is not a shipped part; one header table serves every front.                                                 |
| SRV-012 | Upgrade smoke building the previous pin                      | api-018, server-app-009               | Becomes "upgrade from release N-1".                                                                               |
| SRV-019 | Tray "core built" line                                       | server-app-016                        | The version line stays, showing part versions instead of a foreign commit.                                        |
| SRV-044 | Pre-upgrade backup keyed on the core commit                  | server-app-041                        | Keyed on the API's schema version.                                                                                |
| SRV-046 | Restated worker constants (tick, limit, lock, exit 75)       | contract-010, cli-054, server-app-043 | The CLI publishes the recipe; the server app reads it.                                                            |
| SRV-048 | Restated PATH tail                                           | contract-010, server-app-045          | Same recipe.                                                                                                      |
| SRV-066 | Wrapper reading the recipe from `internal units` (not built) | contract-010, cli-054, server-app-043 | Becomes the normal path.                                                                                          |
| SRV-070 | Legacy `proxy-secret` Keychain cleanup inside uninstall      | server-app-064                        | History only: no install of this repository ever wrote it, so the clause is dropped; the rest of uninstall stays. |
| SRV-080 | Restated API environment names                               | server-app-074                        | The server app starts the API from the API's own configuration schema.                                            |
| SRV-091 | Rust header tables equal to `core.Caddyfile`                 | web-079                               | One header table, no copy to compare.                                                                             |
| SRV-098 | `plain-columns.json` re-validated per pin                    | api-020                               | Kept as the API's own schema test.                                                                                |
| SRV-105 | The fresh-checkout trick with no staged core                 | repo-006                              | Ordinary CI gates.                                                                                                |
| SRV-107 | Bun-compiled core sidecars staged by the wrapper             | api-019, cli-063, server-app-088      | Workspace builds of the API and CLI.                                                                              |
| SRV-111 | Caddyfile check in `core:build`                              | web-079                               | One header table.                                                                                                 |
| SRV-113 | `core:build --pin --out` for the upgrade test                | server-app-009                        | Upgrade from release N-1.                                                                                         |
| SRV-114 | `dropped-checks.json` and its smoke guard                    | contract-011, cli-047, server-app-020 | Typed check ids from the CLI.                                                                                     |
| SRV-115 | Upgrade from the pre-login pin on the other Mac              | migrate-010                           | The other machine is parked (Q2); the migration tool covers it later.                                             |
