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
| Requirement | One testable sentence. "Changed:" marks where the new design alters today's behaviour. "Retired:" marks a row that no longer applies, with the reason. "Conditional" marks a row built only if the named option is chosen. |
| Sources | Inventory rows, plan requirements, ADRs and other catalogue rows it derives from |
| Today | Status of today's implementation, the weakest among the sources: `works`, `unproven`, `broken`, `not built` (discussed, never built), `new` (a requirement of this plan) |
| Test | Where the test lives: `e2e` (the suite connecting API, CLI and browser client), `part` (the owning part's own suite, wrappers included), `manual: <reason>` (a written manual walk, R4.5), or `retired` (no test) |
| Test ids | Written by `pnpm catalogue:fill`: the test files whose titles carry the row id, joined by `, `; `planned: <path>` from [test-plan.json](test-plan.json) while none exists; `—` for `manual` and `retired` rows |

The Test column is the catalogue's proposal; step 4 may move a row between `e2e` and `part` when it writes the test.
A retired row needs no test.

## Counts

| Part | Rows |
|---|---|
| api | 125 |
| contract | 15 |
| sealing | 7 |
| cli | 85 |
| web | 106 |
| server-app | 91 |
| client-app | 52 |
| mobile | 10 |
| migrate | 12 |
| repo | 9 |
| **Total** | **512** |

Tests proposed: 103 `e2e`, 385 `part`, 15 `manual`, 9 `retired` (client-app-030, server-app-075…082).

Inventory rows: 472. Mapped to catalogue rows: 456 (17 of them pin-caused rows replaced). Dropped with a reason: 16.
The architecture added 45 rows, each under "Added by the architecture" at the end of its file.

## Settled by the architecture

The open design choices left by step 1 are settled in [docs/architecture.md](../docs/architecture.md) and the ADRs in
[docs/adr/](../docs/adr/): sessions for bundled and cross-origin clients (ADR-0004), key isolation per server
(ADR-0005), the API serving the browser client with no separate front (ADR-0006), the server-app to client-app
handover (ADR-0007), hidden server windows (ADR-0008), and how a machine may act as its owner (ADR-0009).
