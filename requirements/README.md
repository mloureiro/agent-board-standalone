# Requirements catalogue

One catalogue of every requirement for the parts of this repository, built from the three inventories of the
repositories it replaces (the `agent-board` fork, `agent-board-client`, `agent-board-local-server`) plus the new
requirements of the plan. Every inventory row is either a catalogue row or dropped with a written reason.

## Files

| File | Content |
|---|---|
| [catalogue/](catalogue/) | One file per owning part: [api](catalogue/api.md), [contract](catalogue/contract.md), [sealing](catalogue/sealing.md), [cli](catalogue/cli.md), [web](catalogue/web.md), [server-app](catalogue/server-app.md), [client-app](catalogue/client-app.md), [mobile](catalogue/mobile.md), [migrate](catalogue/migrate.md), [repo](catalogue/repo.md) (repository-wide rows) |
| [sources.md](sources.md) | Every inventory row and the catalogue rows it became (generated) |
| [dropped.md](dropped.md) | Inventory rows dropped, and pin-caused (`P`) rows replaced, each with its reason |
| [parity.md](parity.md) | The twenty parity problems P-01…P-20, the rows that prevent them and the test that would catch them |
| [storage-audit.md](storage-audit.md) | Every browser-storage key (and on-disk UI state) in today's UIs, volatile or content, and where it moves |
| [cli-review.md](cli-review.md) | Census of every `board` command, option, environment variable and exit code, and the gap review |
| [inventories/](inventories/) | The three input inventories (472 rows), as written on 2026-11-24 |

## Ids

`<part>-<nnn>`, lower case: `api-001`, `server-app-014`. The part is the one whose suite owns the row. Ids are never
renumbered; a row removed later keeps its id and reads "Retired: <reason>".

Inventory ids keep their own upper-case form: `API-`, `WEB-`, `CLI-` (core), `APP-` (desktop client), `SRV-`
(local server), `P-` (parity problems), `ST-` (storage audit), `CMD-`, `G-`, `B-`, `T-` (CLI review). `R1.x`…`R4.x`
and `Q<n>` refer to the plan's requirements and the owner's decisions.

## Columns

| Column | Meaning |
|---|---|
| ID | Stable id |
| Requirement | One testable sentence. "Changed:" marks where the new design alters today's behaviour. |
| Sources | Inventory rows, plan requirements and other catalogue rows it derives from |
| Today | Status of today's implementation, the weakest among the sources: `works`, `unproven`, `broken`, `not built` (discussed, never built), `new` (a requirement of this plan) |
| Test | Where the test lives: `e2e` (the suite connecting API, CLI and browser client), `part` (the owning part's own suite, wrappers included), or `manual: <reason>` (a written manual walk, R4.5) |
| Test ids | Empty until step 4 assigns the test ids |

The Test column is the catalogue's proposal; step 4 may move a row between `e2e` and `part` when it writes the test.

## Counts

| Part | Rows |
|---|---|
| api | 106 |
| contract | 12 |
| sealing | 7 |
| cli | 82 |
| web | 100 |
| server-app | 88 |
| client-app | 48 |
| mobile | 7 |
| migrate | 10 |
| repo | 7 |
| **Total** | **467** |

Tests proposed: 97 `e2e`, 355 `part`, 15 `manual`.

Inventory rows: 472. Mapped to catalogue rows: 456 (17 of them pin-caused rows replaced). Dropped with a reason: 16.

## Left to the architecture step

Rows that say "step 2 decides" name the open design choices: how the bundled clients (client app, Android) carry a
session cross-origin, key isolation per server inside one bundled client, the server-app to client-app handover
mechanism, whether the server app keeps a front proxy, hidden-server behaviour in the client app, and how a machine
token may act as its owner for the CLI's user commands.
