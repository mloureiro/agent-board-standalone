# agent-board-migrate

Reads an existing board and writes a `BoardExport` file that `agent-board-api import` loads.

```bash
agent-board-migrate inspect --source <postgres-url | pglite-dir>
agent-board-migrate export --source <postgres-url | pglite-dir> --out <file> [--dry-run]
```

From a checkout: `pnpm --filter @agent-board/migrate migrate inspect --source <...>`. `export` prints the plan report
(per owner, per table counts). With `--dry-run` it also writes the report as `<file>.plan.json`. Neither command
imports anything.

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
  `default_transaction_read_only` on, so a write errors and every table is read from one snapshot.
- **PGlite** folders are never opened in place, because opening writes to the data folder. The reader copies the folder
  to a temporary directory, opens the copy (also in a read-only transaction) and deletes the copy on close. Stop the
  process that owns the folder first: a copy of a folder that is being written can be inconsistent.
- `PG_VERSION` selects the major version only: PGlite 0.5.16 and 0.5.17 both write `18`. An unknown major is refused by
  name (`PG_VERSION 16 is not supported`). For a known major the reader tries its builds newest first, each on a fresh
  copy, and uses the first that opens.

## What the export carries

Every table of the old board maps to export records, grouped by owner in the order of the contract's `EXPORT_TABLES`.
Sealed values and blind indexes are copied byte for byte. Timestamps are written as ISO 8601 with milliseconds in UTC.

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
