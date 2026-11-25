# Migration fixtures

Three synthetic boards, one per source version the migration tool reads. **No real data is present in them**: every
name, token, key, passphrase, URL and path is made up, and every value that the old boards seal is sealed under a
made-up data key with `@agent-board/sealing`. The repository is public, so the hygiene test
(`test/hygiene.test.ts`) fails on a home directory path, an email address that does not end in `@example.test`, a URL
host outside `example.test`, and any sealed-looking value that fails the shape checks of `@agent-board/sealing`.

## What is committed

| File                                        | Content                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `data/<fixture>.sql`                        | The pin's schema, the `drizzle.__drizzle_migrations` journal and the synthetic rows, as a plain `pg_dump` with one `INSERT` per row |
| `data/<fixture>.credentials.json`           | The made-up passphrase, recovery key, data key (`abk1_…`) and machine tokens (`abm_…`)   |
| `build.ts`, `content.ts`, `database.ts`     | The script that makes them                                                                |
| `materialize.ts`                            | Loads a fixture into a PGlite data folder, or into a Postgres database                    |

The old migration SQL files are **not** committed, and no old code is copied. The schema in each `.sql` file is what
Postgres reports after the pin's migrations ran (`pg_dump --schema`), so a fixture loads without the old checkout. A
PGlite data folder is about 39 MB even when empty, so none is committed; tests build one in a temporary directory.

## Made-up credentials

| Item          | Value                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Owner         | `fixture-owner` (the name the content keys derive from)                                      |
| Passphrase    | `correct horse battery staple`                                                               |
| Data key      | per fixture, in `data/<fixture>.credentials.json`; the key slots unlock with the passphrase  |
| Machines      | `fixture-laptop` and `fixture-server`, each with a token in the credentials file             |
| Hosts, URLs   | only `*.example.test`                                                                        |

The random stream of the build is seeded per fixture (`agent-board-fixtures/<fixture>`), so running the script again
leaves the files byte for byte unchanged.

## Pins, engines and versions

| Fixture          | Core pin  | Migrations | Source engine          | PGlite alias used to open it                   | `PG_VERSION` |
| ---------------- | --------- | ---------- | ---------------------- | ---------------------------------------------- | ------------ |
| `hosted-main`    | `011f7be` | 53         | Postgres 16            | `pglite-0-5-17` (stand-in, see below)          | 18           |
| `local-v2`       | `d2e0253` | 52         | PGlite 0.5.17          | `pglite-0-5-17` (`@electric-sql/pglite@0.5.17`) | 18          |
| `local-prelogin` | `b587c6a` | 42         | PGlite 0.5.16          | `pglite-0-5-16` (`@electric-sql/pglite@0.5.16`) | 18          |

Observed `PG_VERSION` map (the test `writes the PG_VERSION and server version recorded for its PGlite build` asserts
it): PGlite 0.5.16 writes `18` and runs PostgreSQL 18.6; PGlite 0.5.17 writes `18` and runs PostgreSQL 18.7. The
planning table calls the local-v2 line "Postgres 17"; it is not, both builds are major 18. The lock file of each pin
names the PGlite version above. Both aliases are declared in `package.json`, one per supported build.

## How they were made

```bash
pnpm --filter @agent-board/migrate fixtures:build --core <path to the old agent-board checkout>
```

For each fixture the script:

1. reads the pin's migration journal and files with `git show <pin>:apps/backend/drizzle/…` run inside the old
   checkout (nothing is checked out and the checkout is only read);
2. starts a throwaway `postgres:16` container with Docker (or uses `--postgres-url` and `--pg-dump`), creates the
   `board_app` role and a fresh database, and applies the migrations the way the old migrator does, including its
   `drizzle.__drizzle_migrations` journal (hash of each file, migration time);
3. builds the synthetic content with `@agent-board/sealing`, sealing every field under the binding the old board
   used for it, and inserts it **with the columns and tables the pin really has**: a column the pin lacks is dropped
   and a table it lacks is skipped, which is how the three fixtures differ;
4. dumps the database with the container's `pg_dump` (no owners, no privileges, one `INSERT` per row) and removes
   the `\restrict` lines newer `pg_dump` releases add;
5. loads the dump into a PGlite folder of the matching alias as a check.

The `hosted-main` and `local-v2` schemas differ only by the `handoff` value of `auth_flow_kind` (migration 52). The
`local-prelogin` schema has no `app_user.source`, no passkey, session, auth-flow, shared-agent, link-rule or
title-rule tables, no `effort`, `icon` or `labels` on tasks and schedules, and no machine feeds.

## How tests read them

- `materializePglite(name, dataDirectory)` creates a PGlite folder with the alias of the fixture and loads it.
  `openPglite(dataDirectory, alias)` reopens a folder the way the readers of the migration tool do.
- `hosted-main` is a Postgres 16 dump. The default test reads it through the PGlite stand-in. When
  `API_TEST_POSTGRES_URL` (or `E2E_POSTGRES_URL`) names a Postgres server, `materializePostgres(adminUrl, name)` loads
  it into a new database of that server and the test reads it there too. The `check` job of
  `.github/workflows/ci.yml` runs a `postgres:16` service and sets `API_TEST_POSTGRES_URL`, so CI covers the real
  engine; a developer machine without the variable covers only the stand-in. The apps/api integration tests use the
  same two variables.

## Content

Every fixture holds, for owner `fixture-owner`:

- two machines with sealed `dirs`, catalogue, usage and feeds documents, their blind indexes and token hashes;
- twelve tasks in every status (`backlog`, `todo`, `running`, `waiting`, `needs-me`, `done`): a proposed task, a
  closed task, a fork with a parent and an agent, an intake review task with its `head` and `dedupe_key` blind indexes,
  and two occurrences of a schedule; the tasks with a directory carry it as the legacy sealed `workdir` and
  `home_workdir`, one of them with a session `workdir` that differs from its home;
- ten notes of every kind (`comment`, `question`, `answer`, `event`, `polish`) and author (`user`, `agent`, `system`,
  `server`), among them a pending and a delivered message, a note with a suggestion, an open question and an answered
  one, and the plain-text event written by the server;
- three task PRs (`open`, `merged`, `closed`), watches on two tasks with stopped watch ids, a run with four events
  (one with a sealed tool output) and a resumed run with two;
- an interval schedule, a cron schedule (paused) and an after schedule that follows the interval one;
- at the pins with sign-in: a passkey, one shared-agents document, link rules and title rules.

The old board has no settings table at any of the three pins, so no settings row exists in the fixtures.

## Row counts

The test `lists in the README the row count of every table` reads this table; `-` means the table does not exist at
the pin.

| table              | hosted-main | local-v2 | local-prelogin |
| ------------------ | ----------- | -------- | -------------- |
| `app_user`         | 1           | 1        | 1              |
| `machine`          | 2           | 2        | 2              |
| `task`             | 12          | 12       | 12             |
| `schedule`         | 3           | 3        | 3              |
| `note`             | 10          | 10       | 10             |
| `task_pr`          | 3           | 3        | 3              |
| `transcript_run`   | 2           | 2        | 2              |
| `transcript_event` | 6           | 6        | 6              |
| `passkey`          | 1           | 1        | -              |
| `shared_agents`    | 1           | 1        | -              |
| `link_rules`       | 1           | 1        | -              |
| `title_rules`      | 1           | 1        | -              |
