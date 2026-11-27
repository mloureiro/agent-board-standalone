# Migration tool: manual walk

For the step-13 install, `install.md` says where this walk fits; start there.

Steps that need a real old board, the real server app and a real worker host, so no automated test can drive them.
The walk covers requirement row `migrate-009` in `requirements/catalogue/migrate.md`. It moves one old board (a
local-server PGlite folder or a hosted Postgres database) into the new server app and ends with the board open in the
browser and the worker connected.

Read the whole walk before starting. No step changes the old board, and every step before step 9 leaves the real new data folder untouched, so you can
stop and start over. Placeholders in angle brackets stand for values on your machine. Never paste real paths, host names,
tokens or owner names into an issue, a commit or a pull request, and never commit anything the tool writes.

| Placeholder  | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `<old-data>` | the old board's PGlite data folder                                                                            |
| `<copy>`     | a backup copy of `<old-data>` that you made in step 3                                                         |
| `<new-data>` | the server app's PGlite data folder (the one its settings show)                                               |
| `<scratch>`  | a copy of `<new-data>` that you make in step 6                                                                |
| `<api-exe>`  | the API executable that ships inside the server app                                                           |
| `<owner>`    | the owner name that `inspect` and `export --dry-run` report                                                   |
| `<migrate>`  | `rumo-migrate`, or `node apps/migrate/dist/main.js` from a checkout after `pnpm --filter @rumo/migrate build` |

## Before you start

- Install the new server app, the new CLI on each worker host and the migration tool. Use the `migrate-v1.0.0`
  release of the tool, built together with the API that the server app ships.
- Keep the old board's passphrase, each machine's token and each machine's data key at hand. You need them in
  steps 12 to 14. The migration copies all of them as they are and never reads them.
- Decide the public host name of the new server. Passkeys keep working only if it is the same host name as the old
  board's public URL (see step 15).

## 1. Stop the workers

On every worker host stop the old listener and watcher, and wait until no `claude` run of the board is left. A task
that is `running` in the old board imports as `running` with no run behind it. The output of `run` in step 8 warns with
the count. With the workers stopped before the export, that count is 0.

Expected: the old board shows no running task.

## 2. Quit the server app

Quit the new server app from its tray menu. A PGlite folder has one process at a time, so the tool refuses a folder
that holds a `postmaster.pid`. If the old board is also a local PGlite folder, quit the old local server too.

Expected: no API process is left (`pgrep -fl rumo-api` prints nothing).

## 3. Back up the old data folder

```bash
cp -R <old-data> <copy>
```

Work only on `<copy>` from here on. The tool never opens a PGlite folder in place (it copies the folder to a
temporary directory first), but the backup protects the old board from every other mistake.

Expected: `<copy>` holds a `PG_VERSION` file.

## 4. Inspect the copy

```bash
<migrate> inspect --source <copy>
```

Expected: a line `source version: local-v2 (52 migrations)` or the version of your board, followed by one row
count per table. The `app_user` count is 1 for a one-owner board. If the tool names an unknown `PG_VERSION` or a
journal count it does not support, stop: the old board needs a version this tool does not read.

## 5. Dry run

```bash
<migrate> export --source <copy> --out <scratch-file> --dry-run
```

`<scratch-file>` is any path outside the repository. The export and `<scratch-file>.plan.json` are readable by their
owner only, because they hold machine token hashes and wrapped key slots. Delete both when the walk is over.

Expected: a plan with one owner. Write the owner name down as `<owner>`. The per-table counts equal the counts of
step 4, except that `machine` documents with a `dirs` value show as `legacy_dirs` and the owner has one `project`.
`export` prints no running-task warning: that warning comes from `run` in step 8.

If the board has no owner, `run` refuses with "the source holds no owner to migrate". An empty board needs no
migration.

## 6. Make a scratch copy of the new data folder

With the server app still quit:

```bash
cp -R <new-data> <scratch>
```

If the server app has never run, create the empty scratch folder instead (`mkdir <scratch>`): the API creates the
schema on the first import.

## 7. Set the server app's user name

With the server app still quit, edit its settings file (the tray's Open settings file names it) and set `userName` to
`<owner>`, exactly as the dry run printed it. The app reads the file only at start. Content keys derive from the owner
name, so any other value opens nothing. The tool refuses a different name before it writes anything, naming both names.
The server app accepts only a `userName` of 1 to 64 characters from `a-z`, `0-9`, `.`, `_` and `-`. If `<owner>` has
any other character, stop: this board cannot move into the server app.

Expected: the settings file holds `"userName": "<owner>"`.

## 8. Run into the scratch copy

```bash
NO_LOGIN_USER=<owner> <migrate> run --source <copy> --api <api-exe> --target-db pglite://<scratch>
```

The API reads its target from the environment, so give `run` the variables the server app gives the API.

Expected output, in order: the plan, `owner check: ok, "<owner>" is the NO_LOGIN_USER`, `import finished` and
`count check passed`. Exit code 0.

Count check expectations: for each table the target's per-owner count equals the export's. Source `dirs` documents
count against target `legacy_dirs` rows, and the other machine documents count against target machine documents.

| Exit code | Meaning                                                                                                                     | What to do                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0         | done                                                                                                                        | continue                                                                                                           |
| 1         | the import failed, for example because the owner exists in the target; it is one transaction, so no board rows were written | read the API's message, fix it, run again                                                                          |
| 2         | refused before the import: unreadable source, owner differs, target folder held, missing variable                           | fix what the message names                                                                                         |
| 3         | a count differs: before the import (the export misses source rows, nothing written) or after it (the import committed)      | read which one the message says; after a commit delete the scratch copy (see Recovery), find the difference, rerun |

## 9. Run into the real data folder

Only when step 8 ended with `count check passed`. Keep `<scratch>` as it is, because it is now the proof of what a
good run looks like, and make a backup of the real folder first:

```bash
cp -R <new-data> <new-data-backup>
NO_LOGIN_USER=<owner> <migrate> run --source <copy> --api <api-exe> --target-db pglite://<new-data>
```

The import refuses a data folder in which the owner already exists. If the server app was started once and created
the owner, restore `<new-data-backup>` taken before that, or use an empty folder.

Expected: the same four lines as step 8 and exit code 0.

## 10. Start the app and check the counts

Start the server app. Open Settings and compare what it shows (machines, passkeys) with the plan of step 5. Open the
board and compare the number of tasks per lane with the old board.

Expected: every count equals the old board's. Tasks of a migrated machine show no directory yet. That is normal until
the machine connects (step 13).

## 11. Open the board in the browser

Open the server app's address in a browser and unlock with the old board's passphrase.

Expected: the board unlocks and shows the tasks, notes and schedules of the old board with their titles readable. A
wrong passphrase leaves everything sealed. If the passphrase is right and nothing opens, the user name of step 7 is
not the exported owner: quit the app and repeat from step 6 with the right name.

## 12. Open one task

Open any task with notes and a transcript.

Expected: the notes, questions and transcript events are there, and a pull-request link shows on a task that had
one.

## 13. Enrol each worker

On each worker host install the new CLI and run, with the machine's existing token and data key:

```bash
rumo init --url <server-url> --token-file <token-file> --data-key-file <data-key-file> --machine <machine-name>
```

Each file holds one value and has mode 600 or 400. Delete the files afterwards. `--machine` checks that the machine
name the board reports for the token is the one you expect. The token stays valid because the migration
copied its hash. At first contact the CLI converts the machine's legacy directories into `directory` rows in the
default project and sets `directory_id` on the tasks that match. It reports the ones that match none.

Expected: the machine shows as connected in Settings, its directories appear on the matching tasks, and the unmatched
ones are listed by the CLI. Then start the worker (`rumo setup` installs the listener and watcher units) and let it
claim one new task.

## 14. Check once more

Compare the counts of step 10 after the workers connected. A task that was running in step 1 and is still shown
running with no live run is handled by the stale-run sweep once its worker connects. If it stays, reset it by hand
from the task's menu.

## 15. Passkeys

A passkey is bound to the public host name it was created for. If the new server answers on the same host name as the
old board, the old passkeys keep working. If the host name changed, sign in with the passphrase and register the
passkey again. The migration cannot change this.

## Hosted Postgres variant

The old board is a hosted Postgres database and the target is a Postgres database.

1. Use the admin URL of the old database, never the `board_app` URL, as `--source`. The tool reads in one
   `READ ONLY` `REPEATABLE READ` transaction, so nothing is written. It refuses a role that row-level security applies
   to, because that role sees an empty board. The error names the hidden tables.
2. `inspect` and `export --dry-run` take `--source <admin-url>`.
3. For the target, `--target-db` is the target's admin URL. `DATABASE_URL` must be set in the environment to the URL of
   the application role (`board_app`) the server uses:

```bash
NO_LOGIN_USER=<owner> DATABASE_URL=<board_app-url> <migrate> run --source <old-admin-url> --api <api-exe> --target-db <new-admin-url>
```

Use `PUBLIC_URL` instead of `NO_LOGIN_USER` for a target that has sign-in. A target with sign-in has no owner rule, and
the exported owner names are kept.

4. The role that reads the source must see rows: if `inspect` prints zero for a board that is not empty, you used the
   wrong role.
5. Take a database backup (`pg_dump`) of the target before the real run, and a scratch database for the first run.

## Rehearsal on a synthetic board (done 2026-11-26)

The walk above was rehearsed end to end on a board made with the old local server, on one Mac, with nothing of the
real board involved. Repeat it this way before touching real data. Every value here is a placeholder. Use scratch
directories outside the repository.

Result of the rehearsal: 10 tasks (4 Done, 1 Needs me, 2 Backlog, 3 Todo of which one is a schedule occurrence), 13
notes, 1 schedule, 1 machine, 4 transcript runs with 19 events and 1 pull-request link. `inspect`, the dry run and
the count check agreed on every count. The board unlocked with the old passphrase, every kind of task opened, the
schedule showed, and a new card reached Done through the new CLI. One bug was found and fixed (see "Found").

### A. The old system, isolated

1. Copy `board-server` and `board` from the installed old server app (`Contents/MacOS/`) and its
   `Contents/Resources/resources/` (`drizzle`, `pglite`, `frontend`) into a scratch folder `<old>`. Do not use the
   app's own data folder.
2. Start the backend with the environment the old app gives it, a scratch data folder and its own port:

```bash
env -i HOME="$HOME" PATH="$PATH" NODE_ENV=production HOST=127.0.0.1 PORT=<backend-port> \
  NO_LOGIN_USER=<owner> ALLOWED_HOSTS=127.0.0.1:<web-port>,localhost:<web-port> \
  DATABASE_URL=pglite://local<old>/data/pglite APP_DATABASE_URL=pglite://board_app:x@local<old>/data/pglite \
  MIGRATIONS_DIR=<old>/resources/drizzle PGLITE_ASSETS_DIR=<old>/resources/pglite <old>/board-server
```

3. Put a tiny static server in front of it on `<web-port>`: it serves `<old>/resources/frontend` (index.html for
   unknown paths) and forwards `/trpc`, `/api/` and `/healthz` to `<backend-port>` with the `Host` header unchanged. The
   backend answers 421 "unknown host" for any other Host.
4. Open `http://127.0.0.1:<web-port>/` in a browser, set a passphrase, store the recovery key, then Settings,
   Machines: add a machine and copy its token and data key into two mode-600 files.
5. Point the old CLI at scratch folders. `board init` ignores `XDG_CONFIG_HOME` and writes into the real
   `~/.config/agent-board`; set `AGENT_BOARD_CONFIG_DIR` and `AGENT_BOARD_STATE_DIR` first, in a wrapper script, then:

```bash
<old>/ob init --url http://127.0.0.1:<web-port> --token-file <token-file> --data-key-file <data-key-file> --machine <machine>
<old>/ob dirs add <dir-a>; <old>/ob dirs add <dir-b>
```

6. Create the board with `<old>/ob schedule --new ...` run inside `<dir-a>` or `<dir-b>`: `--model haiku --effort low`
   cards for the runs, `--backlog`, `--hold`, `--in 30d` and `--every 1d --in 20d` for the other lanes, `--icon` and
   `--label` for the decoration, then `<old>/ob comment <task> "..."` for notes and `<old>/ob pr <task> <url>` for a
   link. Run the cheap cards with one `<old>/ob internal dispatch` (the old worker), wait for their sessions to end,
   and `<old>/ob move <task> done`.
7. Stop the backend (a PGlite folder has one process), then `cp -R <old>/data/pglite <copy>`.

### B. Migrate and verify

1. Build from the release commit: `pnpm --filter @rumo/migrate build`, `pnpm --filter @rumo/api
build:executable`, `pnpm --filter @rumo/web build`, `pnpm --filter @rumo/cli build:binary`.
2. Follow steps 4 to 9 above: `inspect`, `export --dry-run`, then `run` into an empty scratch target, then into the
   real target, each with `NO_LOGIN_USER=<owner>`. Both end with `count check passed`.
3. Start the new API on its own folder and port. Outside the server app it needs `AUTH_MODE=no-login`,
   `NO_LOGIN_USER=<owner>`, `DATABASE_URL=pglite://<new-data>`, `HOST=127.0.0.1`, `PORT=<port>`, `ALLOWED_HOSTS=127.0.0.1,localhost`
   (host names only, no port) and `WEB_ROOT=<web-dist>`.
4. In a browser open `http://127.0.0.1:<port>/`, unlock with the old passphrase and compare: tasks per lane, a task
   with notes, a Done task with its transcript (the Transcript button), the task with the pull-request link, the
   schedule page (it can take a few seconds) and the schedule's occurrence task. No card may show "could not be read".
5. Enrol the new CLI with the old token and data key and the same `RUMO_CONFIG_DIR` / `RUMO_STATE_DIR`
   treatment: `<new>/nb init --url http://127.0.0.1:<port> --token-file ... --data-key-file ... --machine <machine>`.
   It prints `legacy directories: N matched, 0 unmatched` (N is the tasks plus schedules that had a directory).
6. In a listed directory run `<new>/nb schedule --new --model haiku --effort low --auto-done "<short prompt>"`, then
   `<new>/nb internal dispatch`. The card goes Running and then Done within a minute.

### Found

- A task made by a schedule keeps its working directory sealed under the schedule. The CLI conversion and the web
  client tried only the task's own binding, so the occurrence task stayed "unmatched" and showed "The working
  directory could not be read." Fixed by trying the schedule binding for tasks that came from a schedule.
- The old worker ended its runs in Needs me even with `--auto-done`; the rehearsal moved them to Done by hand.

### Clean up

Stop the old backend, the static server, both APIs and any worker you started (`pgrep -fl board-server`, `pgrep -fl
rumo-api`), then delete the scratch folders and the files that held the token and data key. Look for
`~/.config/agent-board` created by an old `board init` that ran without `AGENT_BOARD_CONFIG_DIR` and remove it if it
holds only the rehearsal's files.

## Leftover temporary directories

A run that is killed (Ctrl-C twice, a power cut, a kill signal) can leave its temporary PGlite copy of the source and
its scratch export behind. Both are in the system temporary directory and start with `rumo-migrate-`:

```bash
ls "${TMPDIR:-/tmp}" | grep rumo-migrate-
```

Delete each one with `rm -r` after checking that no migration is running. The export holds token hashes, so do not
leave it there.

## Recovery

- **A run into the scratch copy failed or the count check failed**: delete `<scratch>` and start again from step 6.
- **A run into the real folder failed with exit code 1**: the import is one transaction and no board rows were
  written. Fix the cause and run again.
- **The real run ended with exit code 3**: the data is in the target. Quit the app, delete `<new-data>`, restore
  `<new-data-backup>` and start again from step 8.
- **Hosted Postgres**: drop the scratch database, or restore the `pg_dump`, then run again.
- **The old board** is never changed by any step. `<copy>` and `<old-data>` stay as they were.

## When the walk is over

Delete `<scratch>`, `<scratch-file>`, `<scratch-file>.plan.json`, `<new-data-backup>` and any leftover
`rumo-migrate-*` directory once the new board has run for a while and you no longer need to go back. Keep
`<old-data>` until then. Nothing the walk produces belongs in the repository.
