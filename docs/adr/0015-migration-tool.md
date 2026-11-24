# ADR-0015: Migration tool shape

## Status

Accepted.

## Context

Existing data must survive (Q8) through a migration tool, not a compatible old API (Q14). Sources are hosted
Postgres boards and local-server PGlite folders written by several earlier versions. The tool must not depend on
the API's code, and it holds no data key.

## Decision

- Pipeline: reader (one per detected source version) → `BoardExport` file (format in the contract) →
  `agent-board-api import`.
- Postgres sources are read through the admin URL in a read-only transaction. PGlite folders are opened with the
  PGlite build matching their `PG_VERSION`, installed under npm aliases; an unknown version is refused with its
  name.
- Sealed values and blind indexes are copied byte for byte. Owner names, key ids, key slots, passkeys and machine
  token hashes are copied as they are. Every task and schedule lands in the owner's default project.
- **Directories** cannot be converted without the key. The export carries each machine's legacy `dirs` document
  and each task's and schedule's sealed directory as stored; the import keeps them as legacy values. Each
  machine's new CLI converts them into `directory` rows on its first contact (ADR-0010).
- **Owner name.** Content keys derive from the owner name. Into a no-login target the import refuses an owner other
  than `NO_LOGIN_USER`; the tool checks this before writing.
- **Order for the server app.** Quit the server app (a PGlite folder has one process at a time), set its `userName`
  to the exported owner name, run the migration into its data folder with the bundled API executable, then start
  the app and enrol the worker with its existing token and data key. The import refuses a data folder in which the
  owner already exists.
- `--dry-run` writes the export and a plan report and imports nothing.
- The import is one transaction, refuses a target that already holds any of the owners, and prints per-table,
  per-owner counts. The tool compares them with the source and fails on any difference. Source `dirs` machine
  documents count against target `legacy_dirs` rows; the other machine documents count against target machine
  documents.
- Test fixtures are synthetic: a script runs a reference board in a throwaway environment with a made-up user and
  passphrase; its database and sealing vectors are committed. Real data never enters the repository or CI. The
  rehearsal on a copy of real data is a manual step on the owner's machine, written in `docs/manual/migrate.md`.
- Old `board` binaries are out of scope: a worker host installs the new CLI and runs `board init` with its existing
  token and data key, which stay valid.

## Consequences

- The API's own export and import share the same format, so the same tests cover both.
- Passkeys keep working only if the new server keeps the old public URL's host name (the WebAuthn relying-party id).
- A migrated machine's tasks show their directories only after that machine's CLI has connected once.

## Rows affected

migrate-001 … migrate-012, api-087, api-099, api-100, api-106, api-123 (new), api-125 (new), cli-085 (new),
contract-013 (new), sealing-002.
