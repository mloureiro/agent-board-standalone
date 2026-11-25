# agent-board-migrate

Reads an existing board and writes a `BoardExport` file that `agent-board-api import` loads.

```bash
agent-board-migrate inspect --source <postgres-url | pglite-dir>
agent-board-migrate export --source <postgres-url | pglite-dir> --out <file> [--dry-run]
agent-board-migrate run --source <postgres-url | pglite-dir> --api <agent-board-api path> \
  --target-db <postgres-url | pglite://dir> [--out <file>] [--keep-export] [--dry-run]
```

From a checkout: `pnpm --filter @agent-board/migrate migrate inspect --source <...>`. `export` prints the plan report
(per owner, per table counts). With `--dry-run` it also writes the report as `<file>.plan.json`. Neither
`inspect` nor `export` imports anything. `run` does; it is described below.

## Sources

| Version          | Journal | Recognised by                                            |
| ---------------- | ------- | -------------------------------------------------------- |
| `hosted-main`    | 53      | sign-in tables and the `handoff` value of `auth_flow_kind` |
| `local-v2`       | 52      | sign-in tables, no `handoff`                             |
| `local-prelogin` | 42      | no `passkey` table and no `app_user.source`              |

Any other database is refused with its journal count. The journal count alone is never enough: the schema must match
too.

### Reading

- **Postgres** is read through the admin URL in one `REPEATABLE READ`, `READ ONLY` transaction with
  `default_transaction_read_only` on, so a write errors and every table is read from one snapshot. A role that
  row-level security applies to (such as `board_app`) is refused, because it would read an empty board.
- **PGlite** folders are never opened in place, because opening writes to the data folder. The reader copies the folder
  to a temporary directory, opens the copy (also in a read-only transaction) and deletes the copy on close. Stop the
  process that owns the folder first: a copy of a folder that is being written can be inconsistent.
- `PG_VERSION` selects the major version only: PGlite 0.5.16 and 0.5.17 both write `18`. An unknown major is refused by
  name (`PG_VERSION 16 is not supported`). For a known major the reader tries its builds newest first, each on a fresh
  copy, and uses the first that opens.

## What the export carries

Every table of the old board maps to export records, grouped by owner in the order of the contract's `EXPORT_TABLES`.
Sealed values and blind indexes are copied byte for byte. The export and its plan are written readable by their owner
only, since they hold machine token hashes and wrapped key slots. Timestamps are written as ISO 8601 with milliseconds in UTC.

- The owner's default project is one record with an id derived from the owner name, `isDefault` true and no name or
  icon. Every task and schedule belongs to it, with `directoryId` null.
- Task `workdir` becomes `legacyDirectory`, `home_workdir` becomes `legacyHomeWorkdir` and a schedule's `workdir`
  becomes `legacyDirectory`. A machine's sealed `dirs` document becomes its `legacy_dirs` record as stored.
- A note is `queued` when the old note was `queued` or `pending`.
- `shared_agents`, `link_rules` and `title_rules` become documents of kind `agents`, `links` and `titles`. The old
  board had no settings and no device keys, so none are written.
- Values the old schema lacks (`source`, `effort`, `icon`, `labels`, machine feeds) are written as null.

### Dropped on purpose

| Dropped                                                                                  | Why                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| task `run_id`, `run_started_at`, `stop_requested_at`, `inbox_read`, `stop_message_id`    | state of a run in progress; the export has no field for it      |
| note `pending`                                                                           | folded into `queued`                                            |
| machine `client_api`, `feed_requests`, `dirs_index`, `dirs_updated_at`                   | no export field; the CLI sends them again on its first contact  |
| sessions and auth flows                                                                  | sign-in state, never part of a board                            |

Timestamps lose microsecond precision, which JavaScript dates cannot hold.

## Running a migration

`run` exports the source, checks the target, imports through the API executable and compares counts. The tool imports
no API code: `--api` is the built `agent-board-api` (a `.js` file is run with the current Node, anything else is run
as a program) and the tool starts it as `agent-board-api import --file <export>`.

The API reads its target from the environment, so give `run` the same variables the server will use: `NO_LOGIN_USER`
(or `PUBLIC_URL` for a login target) and anything else the API needs. A `pglite://` `--target-db` becomes
`DATABASE_URL` for the import and `DATABASE_ADMIN_URL` is dropped. A Postgres `--target-db` is the admin URL and becomes
`DATABASE_ADMIN_URL`; `DATABASE_URL` must then be set in the environment to the application-role URL the server uses.

Order of work:

1. A `pglite://` target folder that holds `postmaster.pid` is refused: another process has it open, or one stopped
   without closing it. A PGlite folder has one process at a time, so stop it first.
2. The source is read and the export is written to a temporary file (owner-only, in a private temporary
   directory) that is deleted afterwards. `--keep-export` keeps it and prints its path, and `--out <file>` writes it to
   `<file>` and keeps it.
3. The export is compared with the source: per table, the exported rows, summed over owners, must equal the rows the
   source holds (`machine` documents with a `dirs` value count against `legacy_dirs`; there is one `project` per
   user). Any difference stops the run before the target is touched.
4. **Owner rule.** For a no-login target (`NO_LOGIN_USER`, or `AUTH_MODE=no-login`), every exported owner must equal
   `NO_LOGIN_USER`. The run is refused, naming both names, before the API starts. Content keys derive from the owner
   name, so a different name would open nothing. With several owners the target is refused too. A login target has no
   such rule.
5. The API imports in one transaction and prints per-table, per-owner counts. A non-zero exit is reported with the
   API's message; the target holds no board rows from this run (a fresh PGlite folder may have its schema created).
6. The counts the API printed are compared with the export, table by table and owner by owner, with the API's own names
   (`legacy_dirs`, `shared_agents`, `link_rules`, `title_rules`, `machine`, and so on). A difference is printed as a table and
   the run exits 3.

`--dry-run` does steps 1 to 4 and writes the export and `<out>.plan.json`, so `--out` is required with it. It never starts
the API and never creates the target.

Output holds counts and names only. Exit codes: 0 done, 1 import or other failure, 2 refused or bad arguments (a source
that cannot be read, an owner that differs, a held target folder), 3 count difference.

**A count difference after the import** means the target now holds the data, because the import already committed. The
tool says so and exits 3. Recover by restoring the scratch copy of the target (or dropping the database) and running
again. Run into a scratch copy first, never into the only copy of a data folder.

### Tasks that were running

The old board's run state is not exported. A task that was `running` in the source imports as `running` with no run, and
the plan report warns with the count. Stop the workers before migrating so no task is running; a task that is left
running is handled by the new board's stale-run sweep once its worker connects, or can be reset by hand.

## Build

`pnpm --filter @agent-board/migrate build` bundles the tool into `dist/main.js` and builds the end-to-end source board in
`test/fixtures/source-board` (the `local-v2` fixture as a PGlite folder with a manifest of its passphrase and machine
tokens; the folder is git-ignored).
