# `board` CLI census and gap review

Source: core fork, CLI package `apps/cli` at CLI version 0.41.0, branch `main` (HEAD "Hide Sign in with your browser on the hand-off approval page (#53)"), plus branch `origin/local-server-v2`.
Paths are repo-relative. Line numbers are of `main` unless a row says `[v2]` (= `origin/local-server-v2`).

Method: read every `register-*.mts`, the shared option helpers (`program.mts`, `schedule.mts`), the config/env readers and the generated `docs/cli.md`. Nothing was executed.

## 0. Branch relationship (read first)

- `origin/local-server-v2` forks from `main` at the commit "Release CLI 0.35.0, the first that updates from the fork (#34)" and has NOT absorbed later `main` work.
- Commands/options present on `main` and absent on `local-server-v2`: `uninstall`, `self-update --resume|--rollback|--server`, `internal migration-plan`, and the migration machinery under `apps/cli/src/migrate/`. `dirs`, `plugins`, `config`, `feeds` and `agents` exist on both (their register files are on `local-server-v2`; only the commands listed were compared).
- Commands present on `local-server-v2` and absent on `main`: `internal shutdown --grace`, `internal units`; plus `AGENT_BOARD_CREDENTIALS_COMMAND` and `version.machine` handling (below).
- Consequence: any "CLI of record" for the standalone repo has to merge both lines; neither alone is complete.

## 1. Deliverable 1 - command census

### 1.0 Registration mechanics

- Program: `new Command('board')` with `enablePositionalOptions()`, `exitOverride()`, `showSuggestionAfterError()` (`apps/cli/src/commands/program.mts:47-51`).
- Help groups: `Tasks:`, `Scheduling:`, `Setup:` (`apps/cli/src/commands/help-text.mts:3-5`).
- Every command built with `dryRunOption` gets its own `--dry-run` (`program.mts:116-117`); the root also has one (`program.mts:54`), and `contextOf` accepts either (`program.mts:71-72`). `feeds`, `plugins`, `events` and `restart/logs/...` do not register their own `--dry-run`; only the root one before the command name reaches them (`board --dry-run feeds ...`).
- `jsonOption` registers `--json` (`program.mts:89-95`); `jsonOptionReadable` is the variant that names the `unreadable` key (`program.mts:88`).
- A bare `board` (or only `--dry-run`) prints the overview (`program.mts:215-217`); `board help nosuch` is an unknown command (`program.mts:219`).
- Registration order: tasks, task settings, schedules, dirs, feeds, plugins, config, agents, delay, setup commands, then the post-action update-hint hook (`program.mts:138-164`), then `internal` (`program.mts:166`), then `help` (`program.mts:168`).
- `<task>` argument everywhere = id, link `<web.json url>/t/<id>`, or unique id prefix (3-7 or 9-11 chars; 8 and 12 are whole ids); inside a run only the full id (`apps/cli/src/commands/ids.mts`, `docs/cli.md:3`).
- `--file <path>` options read only a regular file in `/tmp` (`/private/tmp` on macOS) with a single hard link (`docs/cli.md:5`).
- Statuses: `backlog, todo, running, waiting, needs-me, done` (`packages/shared/src/contract.mts:30`); `parseStatus` lower-cases and turns spaces into dashes, so "Needs me" works (`apps/cli/src/commands/board.mts:104-108`). `waiting` cannot be a `move` target (server answers 400, `docs/machine-api.md` update-task table).
- Priorities `urgent, high, normal, low` (`packages/shared/src/contract.mts:70`). Efforts `low, medium, high, xhigh, max` (`:83`). Model aliases `fable, opus, sonnet, haiku` or any model id (`:75-80`).
- "In a run" = `AGENT_BOARD_TASK` set (`program.mts:80`); `notInRun` throws a usage error (`program.mts:102-104`).

### 1.1 Global flags

| ID        | Flag            | Argument | Default                                                                                             | Hidden | Branch   | file:line                                                                             |
| --------- | --------------- | -------- | --------------------------------------------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------- |
| CMD-01-O1 | `-V, --version` | none     | n/a. Prints `board <ver> (api <API_VERSION>, updates from <release repo> \| updates with git pull)` | no     | main, v2 | `apps/cli/src/commands/program.mts:53`, text at `apps/cli/src/self/version.mts:27-30` |
| CMD-01-O2 | `--dry-run`     | none     | off                                                                                                 | no     | main, v2 | `apps/cli/src/commands/program.mts:54`                                                |
| CMD-01-O3 | `-h, --help`    | none     | commander default, on every command                                                                 | no     | main, v2 | commander built-in                                                                    |

### 1.2 Command table

Legend: `NIR` = refuses inside a board run (`AGENT_BOARD_TASK` set). "cfg" = needs `config.json` (strictConfig), otherwise defaults are used when it is missing. Option rows follow each command.

| ID     | Command                      | Group      | Branch                       | Registered at                            | Positionals                                                                                                                                        | NIR?                                                                         | Special exit codes / notes                                                                                                                                                                                                                                                                                                                                             |
| ------ | ---------------------------- | ---------- | ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CMD-01 | `board` (root)               | -          | main, v2                     | `commands/program.mts:47`                | `<command>`                                                                                                                                        | -                                                                            | Usage error exit 2; ReportedFailure exit code as given; other errors exit 1 (`cli.mts:114-137`). Update hint on stderr after every non-`internal` command, only when stderr is a TTY and not in a run (`program.mts:150-164`).                                                                                                                                         |
| CMD-02 | `help [command]`             | Setup      | main, v2                     | `commands/program.mts:168`               | `[command]`                                                                                                                                        | no                                                                           | -                                                                                                                                                                                                                                                                                                                                                                      |
| CMD-03 | `tasks`                      | Tasks      | main, v2                     | `commands/register-tasks.mts:71`         | none                                                                                                                                               | no                                                                           | cfg optional.                                                                                                                                                                                                                                                                                                                                                          |
| CMD-04 | `show <task>`                | Tasks      | main, v2                     | `register-tasks.mts:90`                  | `<task>`                                                                                                                                           | no                                                                           | cfg optional.                                                                                                                                                                                                                                                                                                                                                          |
| CMD-05 | `attach <task>`              | Tasks      | main, v2                     | `register-tasks.mts:112`                 | `<task>`                                                                                                                                           | NIR (`:131`)                                                                 | Exit status is that of `claude` (`commands/board.mts:341-342`).                                                                                                                                                                                                                                                                                                        |
| CMD-06 | `comment <task> [text...]`   | Tasks      | main, v2                     | `register-tasks.mts:138`                 | `<task>`, `[text...]` (`-` = stdin, `--file <path>` right after task)                                                                              | no                                                                           | `.passThroughOptions()` (`:154`); usage `[options] <task> <text...\|-\|--file <path>>` (`:149`); a note starting with `--suggest`/`--suggest-file` is refused (`:168-172`). Posts as author `agent` (machine API allows no `user` author, `docs/machine-api.md` add-note table).                                                                                       |
| CMD-07 | `pr <task> <url>`            | Tasks      | main, v2                     | `register-tasks.mts:183`                 | `<task>`, `<url>` (GitHub PR URL only)                                                                                                             | no                                                                           | -                                                                                                                                                                                                                                                                                                                                                                      |
| CMD-08 | `move <task> <status...>`    | Tasks      | main, v2                     | `register-tasks.mts:213`                 | `<task>`, `<status...>`                                                                                                                            | `--expect` is NIR (`:236-239`); in a run only `needs-me` is allowed          | **Exit 3** when `--expect` mismatches, nothing written (`:255-258`). Dropping watches when a run moves its own task to needs-me (`:246-254`).                                                                                                                                                                                                                          |
| CMD-09 | `ask <task>`                 | Tasks      | main, v2                     | `register-tasks.mts:264`                 | `<task>`                                                                                                                                           | no                                                                           | Questions JSON `{"questions":[{header,question,multiSelect,options:[{label,description,recommended?}]}]}`, 1-4 questions (`:270`).                                                                                                                                                                                                                                     |
| CMD-10 | `wait <task>`                | Tasks      | main, v2                     | `register-tasks.mts:284`                 | `<task>`                                                                                                                                           | no (but `--check` refused by restricted agents, `commands/board.mts:615`)    | cfg required only with `--check` (`:311`). Waits at most 7 days; a check attempt may take 45 s (`dispatch/waits.mts:112`).                                                                                                                                                                                                                                             |
| CMD-11 | `watch <task> [command...]`  | Tasks      | main, v2                     | `register-tasks.mts:333`                 | `<task>`, `[command...]` after `--`                                                                                                                | no (restricted agents refused for command watches, `commands/watch.mts:334`) | cfg required (`:390`). Exactly one source: `--ci`, `--pr-review`, `--pr-merged`, a command, `--stream`, or `--in/--at`.                                                                                                                                                                                                                                                |
| CMD-12 | `watches <task>`             | Tasks      | main, v2                     | `register-tasks.mts:397`                 | `<task>`                                                                                                                                           | no                                                                           | cfg required.                                                                                                                                                                                                                                                                                                                                                          |
| CMD-13 | `unwatch <task> <name>`      | Tasks      | main, v2                     | `register-tasks.mts:419`                 | `<task>`, `<name>`                                                                                                                                 | no                                                                           | cfg required.                                                                                                                                                                                                                                                                                                                                                          |
| CMD-14 | `events`                     | Tasks      | main, v2                     | `register-tasks.mts:439`                 | none                                                                                                                                               | NIR (`:469`)                                                                 | Exit 0 on Ctrl-C, 1 on a refused token / closed pipe / write failure, otherwise the stream's code (`commands/events.mts:147-153`, `backend/event-stream.mts:165-196`). No `--dry-run`.                                                                                                                                                                                 |
| CMD-15 | `add`                        | Tasks      | main, v2                     | `register-tasks.mts:487`                 | none                                                                                                                                               | no                                                                           | cfg required. Proposals land in Backlog; `createdBy` agent.                                                                                                                                                                                                                                                                                                            |
| CMD-16 | `polish <task>`              | Tasks      | main, v2                     | `register-tasks.mts:536`                 | `<task>`                                                                                                                                           | **only inside a run** (`:551`)                                               | cfg required.                                                                                                                                                                                                                                                                                                                                                          |
| CMD-17 | `task <task> [action...]`    | Tasks      | main, v2                     | `commands/register-task-settings.mts:35` | `<task>`, `[action...]` = `set <key> <value...>` or `unset <key>`                                                                                  | `set`/`unset` NIR (`:96`)                                                    | usage `[options] <task> [set <key> <value> \| unset <key>]` (`:55`); `--json` only with no action (`:95`); cfg required only for `set dir` (`:97`). Sub-actions in 1.3.                                                                                                                                                                                                |
| CMD-18 | `schedule <prompt...>`       | Scheduling | main, v2                     | `commands/register-scheduling.mts:32`    | `<prompt...>`                                                                                                                                      | NIR (`:74`)                                                                  | `.passThroughOptions()` (`:49`): flags first, then everything is the prompt; `--` to start a prompt with dashes; usage `[options] <prompt...>` (`:47`). cfg required (`:81`). Prompt ending in `--dry-run` without `--` is refused (`:77-80`). Exit 0 for every `--key` outcome (created/exists/requeued/rescheduled).                                                 |
| CMD-19 | `schedules [action...]`      | Scheduling | main, v2                     | `register-scheduling.mts:102`            | `[action...]` = `pause <id>`, `resume <id>`, `rm <id>`, `edit <id> [text...\|-\|--file <path>]`                                                    | changes NIR (`:174`)                                                         | usage line `:115`; cfg required only with `--dir` or `--agent` (`:181`). Id may be a prefix outside a run (`resolveScheduleId`).                                                                                                                                                                                                                                       |
| CMD-20 | `feeds [action...]`          | Scheduling | main, v2                     | `commands/register-feeds.mts:27`         | `[action...]` = `list`, `add <name> <file\|->`, `rm <name>`, `run <name>`, `pause <name>`, `resume <name>`                                         | non-list NIR (`:59`)                                                         | cfg required (`:60`). `run` exit 1 when the feed run failed (`:93`). No `--json`, no own `--dry-run`.                                                                                                                                                                                                                                                                  |
| CMD-21 | `delay <task>`               | Scheduling | main, v2                     | `register-scheduling.mts:211`            | `<task>`                                                                                                                                           | no                                                                           | Exactly one of `--in`, `--at`, `--now`.                                                                                                                                                                                                                                                                                                                                |
| CMD-22 | `dirs [action...]`           | Setup      | main, v2                     | `commands/register-dirs.mts:20`          | `[action...]` = `list`, `add [path]`, `rm [path]`, `set <key> <value> [path]`, `unset <key> [path]`                                                | all but `list` NIR (`:74`)                                                   | cfg required (`:75`); board request timeout 15 s (`:14`). `rm` refuses while open work uses the dir unless `--force`.                                                                                                                                                                                                                                                  |
| CMD-23 | `plugins [action...]`        | Setup      | main, v2                     | `commands/register-plugins.mts:18`       | `list`, `install <url>`, `update <name>`, `remove <name>`                                                                                          | non-list NIR (`:51`)                                                         | No flags besides globals.                                                                                                                                                                                                                                                                                                                                              |
| CMD-24 | `config [action...]`         | Setup      | main, v2                     | `commands/register-config.mts:30`        | `show`, `get <key>`, `set <key> <value>`, `unset <key>`, `edit`, `path`                                                                            | set/unset/edit NIR (`:72`)                                                   | cfg required (`:75`); timeout 15 s (`:12`). `--json` only with `show` (`:71`). `edit` needs a terminal and `$VISUAL`/`$EDITOR`.                                                                                                                                                                                                                                        |
| CMD-25 | `agents [action...]`         | Setup      | main, v2                     | `commands/register-agents.mts:21`        | `list`, `show <name>`, `export <name>`, `add <file\|-\|https-url\|example:name>`, `push <name\|file\|-\|url\|example:name>`, `rm [--board] <name>` | add/push/rm NIR, also when `AGENT_BOARD_RESTRICTED` (`:86-90`)               | usage `:35-37`. `add`/`push` from stdin cannot prompt (`:114-116`). URL fetch: https only, 15 s, 256 KB, same-host https redirects, `#sha256=<hex>` pin (description `:29`).                                                                                                                                                                                           |
| CMD-26 | `init`                       | Setup      | main, v2                     | `commands/register-setup.mts:92`         | none                                                                                                                                               | NIR (`:122`)                                                                 | After writing, runs the doctor checks; exit 1 if a check fails (`:142`).                                                                                                                                                                                                                                                                                               |
| CMD-27 | `doctor`                     | Setup      | main, v2                     | `register-setup.mts:147`                 | none                                                                                                                                               | no                                                                           | Exit 1 if any check fails, warnings alone exit 0 (`:85-89`, description `:152`).                                                                                                                                                                                                                                                                                       |
| CMD-28 | `setup`                      | Setup      | main, v2                     | `register-setup.mts:162`                 | none                                                                                                                                               | NIR (`:180`)                                                                 | Refuses unless `--force` when the checkout is not the installed one or a binary runs from the temp dir. Writes systemd units or launchd agents.                                                                                                                                                                                                                        |
| CMD-29 | `uninstall`                  | Setup      | main only                    | `register-setup.mts:186`                 | none                                                                                                                                               | NIR (`:201`)                                                                 | Exit 1 when a unit fails to stop (installed board kept). Does not revoke the token.                                                                                                                                                                                                                                                                                    |
| CMD-30 | `restart [unit...]`          | Setup      | main, v2                     | `register-setup.mts:215`                 | `[unit...]` choices `dispatch\|listen\|watch` (`setup/units.mts:18`, `setup/launchd.mts:17`)                                                       | NIR (`:228`)                                                                 | Exit 1 when a restart failed or nothing could be restarted.                                                                                                                                                                                                                                                                                                            |
| CMD-31 | `logs [target]`              | Setup      | main, v2                     | `register-setup.mts:233`                 | `[target]` = `dispatch`, `listen`, `watch` or a task id                                                                                            | allowed in a run                                                             | Exit status is journalctl's or tail's. `--since` not on macOS or for task logs.                                                                                                                                                                                                                                                                                        |
| CMD-32 | `self-update`                | Setup      | main (v2 has `--check` only) | `register-setup.mts:268`                 | none                                                                                                                                               | NIR (`:296`)                                                                 | `--server` cannot combine with `--check/--resume/--rollback` (`:302-304`); `--rollback` with `--check`/`--resume` refused (`:328-329`); `--resume` exits 1 when the migration stopped (`:362`).                                                                                                                                                                        |
| CMD-33 | `completion <shell>`         | Setup      | main, v2                     | `register-setup.mts:392`                 | `<shell>` choices `bash\|zsh\|fish` (`commands/completion.mts:8`)                                                                                  | no                                                                           | -                                                                                                                                                                                                                                                                                                                                                                      |
| CMD-34 | `example [name]`             | Setup      | main, v2                     | `register-setup.mts:408`                 | `[name]` (lists names without it)                                                                                                                  | no                                                                           | Usage error (2) for an unknown name.                                                                                                                                                                                                                                                                                                                                   |
| CMD-35 | `__complete [kind]` (hidden) | -          | main, v2                     | `register-setup.mts:431`                 | `[kind]` = `tasks` or `schedules`; `.allowExcessArguments()` (`:433`)                                                                              | silent no-op in a run (`:435`)                                               | Always exit 0; whole-process 2 s deadline (`main.mts:14`); 2 s per request (`:436`).                                                                                                                                                                                                                                                                                   |
| CMD-36 | `internal` (hidden)          | -          | main, v2                     | `commands/register-internal.mts:18`      | subcommand                                                                                                                                         | NIR for all subcommands                                                      | Alone it throws a usage error listing the subcommands (`:21`). Error prefix is `agent-board:` not `board:` (`main.mts:15-17`). Needs Linux or macOS (`:26-29`).                                                                                                                                                                                                        |
| CMD-37 | `internal dispatch`          | -          | main, v2                     | `register-internal.mts:31`               | none                                                                                                                                               | NIR                                                                          | **Exit 124** when the tick passes its time limit (`dispatch/dispatch.mts:353,805`); tick limit 110 s + 10 s grace (`dispatch/tick.mts:5,10`). Has `--dry-run`. Under `flock -E 75` / `lockf -s -t 0`: **exit 75** = another tick holds the lock, treated as success by the units (`setup/setup.mts:58,129-131`, `setup/launchd.mts:110`, `dispatch/listen.mts:24-25`). |
| CMD-38 | `internal intake` (hidden)   | -          | main, v2                     | `register-internal.mts:37`               | none                                                                                                                                               | -                                                                            | Removed feature: prints the "removed" line, exit 0, so a stale timer does not fail (`:35-41`).                                                                                                                                                                                                                                                                         |
| CMD-39 | `internal listen`            | -          | main, v2                     | `register-internal.mts:43`               | none                                                                                                                                               | NIR                                                                          | Exit code comes from `runListener` (`dispatch/listen.mts:276`).                                                                                                                                                                                                                                                                                                        |
| CMD-40 | `internal watch`             | -          | main, v2                     | `register-internal.mts:50`               | none                                                                                                                                               | NIR                                                                          | -                                                                                                                                                                                                                                                                                                                                                                      |
| CMD-41 | `internal worker <task>`     | -          | main, v2                     | `register-internal.mts:57`               | `<task>`                                                                                                                                           | NIR                                                                          | One task run; sets `AGENT_BOARD_*` for the agent (`worker/worker.mts:352-355`).                                                                                                                                                                                                                                                                                        |
| CMD-42 | `internal migration-plan`    | -          | main only                    | `register-internal.mts:65-66`            | none                                                                                                                                               | NIR (`:68`)                                                                  | Always prints JSON `{from,to,steps:[{id,since,title,kind}]}` (`:70-74`); `--json` is registered but redundant.                                                                                                                                                                                                                                                         |
| CMD-43 | `internal hook [args...]`    | -          | main, v2                     | `register-internal.mts:77`               | `[args...]`, `.allowUnknownOption()`, `.passThroughOptions()` (`:81-82`)                                                                           | in a run, ignores calls whose task or run dir differs (`:85-86`)             | **Always exit 0** (`main.mts:19`): a broken hook must not break the tool call.                                                                                                                                                                                                                                                                                         |
| CMD-44 | `internal shutdown`          | -          | v2 only                      | `[v2] register-internal.mts:68`          | none                                                                                                                                               | NIR                                                                          | Asks each running worker to pause, then stops stragglers (`[v2] setup/shutdown.mts`).                                                                                                                                                                                                                                                                                  |
| CMD-45 | `internal units`             | -          | v2 only                      | `[v2] register-internal.mts:102`         | none                                                                                                                                               | NIR                                                                          | Prints `ResolvedWorkerUnits` JSON, schema 1 (`[v2] setup/worker-units.mts`).                                                                                                                                                                                                                                                                                           |

Total: 45 command rows (CMD-01 .. CMD-45) = 34 user-visible (incl. the root and `help`, 33 without the root) + 11 hidden; 43 exist on `main`, 43 on `local-server-v2` (v2 lacks CMD-29 and CMD-42, and the `self-update` options CMD-32-O2..O4; it adds CMD-44 and CMD-45).

### 1.3 Options and sub-actions per command

Format: `ID | option | argument | default | hidden | branch | file:line`. All options visible unless stated. `--dry-run` appears on a command when it was built with `dryRunOption` (marked `DR`).

#### CMD-03 `tasks` (DR, `--json` readable)

| ID        | Option      | Arg        | Default         | Branch | file:line               |
| --------- | ----------- | ---------- | --------------- | ------ | ----------------------- |
| CMD-03-O1 | `--all`     | -          | open tasks only | both   | `register-tasks.mts:77` |
| CMD-03-O2 | `--status`  | `<status>` | all             | both   | `register-tasks.mts:78` |
| CMD-03-O3 | `--json`    | -          | text            | both   | `program.mts:88-95`     |
| CMD-03-O4 | `--dry-run` | -          | off             | both   | `program.mts:116`       |

#### CMD-04 `show` (DR, `--json` readable)

| CMD-04-O1 | `--json` | - | text | both | `program.mts:88` |
| CMD-04-O2 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-05 `attach` (DR)

| CMD-05-O1 | `--fork` | - | off (the board's session continues) | both | `register-tasks.mts:124` |
| CMD-05-O2 | `--desktop` | - | terminal; cannot combine with `--fork` | both | `register-tasks.mts:125` |
| CMD-05-O3 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-06 `comment` (DR, pass-through)

| CMD-06-O1 | `--suggest` | `<text>` | none | both | `register-tasks.mts:152` |
| CMD-06-O2 | `--suggest-file` | `<path>` (file in /tmp) | none; not with `--suggest` (`:173`) | both | `register-tasks.mts:153` |
| CMD-06-O3 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-07 `pr` (DR)

| CMD-07-O1 | `--remove` | - | add | both | `register-tasks.mts:196` |
| CMD-07-O2 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-08 `move` (DR)

| CMD-08-O1 | `--expect` | `<status>` | none | both | `register-tasks.mts:225` |
| CMD-08-O2 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-09 `ask` (DR)

| CMD-09-O1 | `--file` | `<path>` REQUIRED (`requiredOption`) | - | both | `register-tasks.mts:275` |
| CMD-09-O2 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-10 `wait` (DR)

| CMD-10-O1 | `--in` | `<duration>` | none | both | `register-tasks.mts:296` |
| CMD-10-O2 | `--at` | `<time>` | none | both | `register-tasks.mts:297` |
| CMD-10-O3 | `--check` | `<command>` | none | both | `register-tasks.mts:298` |
| CMD-10-O4 | `--every` | `<duration>` | 2m, at least 1m (`commands/board.mts:542`) | both | `register-tasks.mts:299` |
| CMD-10-O5 | `--timeout` | `<duration>` | 2h (`commands/board.mts:543`); max 7 days | both | `register-tasks.mts:300` |
| CMD-10-O6 | `--reason` | `<text>` | none | both | `register-tasks.mts:301` |
| CMD-10-O7 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-11 `watch` (DR)

| CMD-11-O1 | `--ci` | `[pr]` optional value | newest open reported PR | both | `register-tasks.mts:350` |
| CMD-11-O2 | `--required` | - | all checks | both | `register-tasks.mts:353` |
| CMD-11-O3 | `--ignore` | `<pattern>`, repeatable (collector `:357`) | none | both | `register-tasks.mts:355` |
| CMD-11-O4 | `--pr-review` | `[pr]` | newest open reported PR | both | `register-tasks.mts:360` |
| CMD-11-O5 | `--pr-merged` | `[pr]` | newest open reported PR | both | `register-tasks.mts:364` |
| CMD-11-O6 | `--name` | `<name>` | ci, review, pr-merged or timer; a command needs one | both | `register-tasks.mts:367` |
| CMD-11-O7 | `--stream` | - | off | both | `register-tasks.mts:368` |
| CMD-11-O8 | `--every` | `<duration>` | 30s (`commands/watch.mts:53`), at least 15s | both | `register-tasks.mts:369` |
| CMD-11-O9 | `--timeout` | `<duration>` | 2h; `--pr-review` `commands/watch.mts:55`; `--pr-merged` 7d (`:57`); max 7d | both | `register-tasks.mts:371` |
| CMD-11-O10 | `--in` | `<duration>` | none | both | `register-tasks.mts:374` |
| CMD-11-O11 | `--at` | `<time>` | none | both | `register-tasks.mts:375` |
| CMD-11-O12 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-12 `watches` (DR, `--json`) and CMD-13 `unwatch` (DR)

| CMD-12-O1 | `--json` | - | text | both | `program.mts:89` |
| CMD-12-O2 | `--dry-run` | - | off | both | `program.mts:116` |
| CMD-13-O1 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-14 `events` (no `--dry-run`)

| CMD-14-O1 | `--task` | `<task>`, repeatable (`collect`) | all | both | `register-tasks.mts:452` |
| CMD-14-O2 | `--status` | `<status>`, repeatable | all | both | `register-tasks.mts:453` |
| CMD-14-O3 | `--type` | `<type>`, repeatable; `created, moved, changed, closed, removed, note` (`events/diff.mts:9`) | all | both | `register-tasks.mts:454` |
| CMD-14-O4 | `--actor` | `<actor>`, repeatable; `user, agent, machine` (`packages/shared/src/contract.mts:116`) | all | both | `register-tasks.mts:455` |
| CMD-14-O5 | `--machine` | `<name>` | all | both | `register-tasks.mts:456` |
| CMD-14-O6 | `--json` | - (plain `.option`, one object per line) | text | both | `register-tasks.mts:457` |

#### CMD-15 `add` (DR, `--json`)

| CMD-15-O1 | `--title` | `<title>` REQUIRED | - | both | `register-tasks.mts:496` |
| CMD-15-O2 | `--file` | `<path>` REQUIRED | - | both | `register-tasks.mts:497` |
| CMD-15-O3 | `--parent` | `<task>` | none | both | `register-tasks.mts:498` |
| CMD-15-O4 | `--priority` | `<priority>` | normal | both | `register-tasks.mts:499` |
| CMD-15-O5 | `--lane` | `<name>` | default lane (not inherited) | both | `register-tasks.mts:501` |
| CMD-15-O6 | `--icon` | `<emoji>` | none | both | `register-tasks.mts:504` |
| CMD-15-O7 | `--label` | `<label>`, repeatable | none | both | `register-tasks.mts:505` |
| CMD-15-O8 | `--here` | - | parent's directory when it has one here | both | `register-tasks.mts:506` |
| CMD-15-O9 | `--json` | - | text | both | `program.mts:89` |
| CMD-15-O10 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-16 `polish` (DR)

| CMD-16-O1 | `--title` | `<title>` REQUIRED | - | both | `register-tasks.mts:546` |
| CMD-16-O2 | `--file` | `<path>` REQUIRED | - | both | `register-tasks.mts:547` |
| CMD-16-O3 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-17 `task` (DR, `--json` readable)

| CMD-17-O1 | `--title` | `<title>`, only with `set prompt` | keep title | both | `register-task-settings.mts:61` |
| CMD-17-O2 | `--file` | `<path>`, only with `set prompt` | none | both | `register-task-settings.mts:62` |
| CMD-17-O3 | `--json` | - | text; only with no action | both | `program.mts:88` |
| CMD-17-O4 | `--dry-run` | - | off | both | `program.mts:116` |

`task set <key> ...` accepted keys (`register-task-settings.mts:111-124`):

| ID        | Key         | Value                                          | Notes                                                                                                              |
| --------- | ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CMD-17-S1 | `priority`  | `urgent\|high\|normal\|low`                    | `unset priority` refused (`:128`)                                                                                  |
| CMD-17-S2 | `model`     | alias `fable\|opus\|sonnet\|haiku` or model id | `unset model` = claude default; applies from the next run                                                          |
| CMD-17-S3 | `effort`    | `low\|medium\|high\|xhigh\|max`                | `unset effort`                                                                                                     |
| CMD-17-S4 | `lane`      | lane name                                      | `unset lane`; refused while running                                                                                |
| CMD-17-S5 | `auto-done` | `on\|off`                                      | `unset auto-done` = off; applies at once                                                                           |
| CMD-17-S6 | `icon`      | one emoji                                      | `unset icon`                                                                                                       |
| CMD-17-S7 | `labels`    | one or more labels (replaces)                  | `unset labels` removes all                                                                                         |
| CMD-17-S8 | `dir`       | optional path (default cwd; `~` expands)       | `unset dir` removes directory and machine pin; refused while running/waiting; drops the session; needs config.json |
| CMD-17-S9 | `prompt`    | words, `-` (stdin), or `--file`; `--title`     | only creator's Todo/Backlog task, unclaimed; `unset prompt` refused (`:129`)                                       |

Errors: action other than `set`/`unset` -> usage error (`:91-92`); `--title/--file` outside `set prompt` -> usage error (`:93-94`).

#### CMD-18 `schedule` (DR, `--json`; options from `addScheduleOptions`, `commands/schedule.mts:117-177`)

| ID         | Option             | Arg                           | Default               | file:line                    |
| ---------- | ------------------ | ----------------------------- | --------------------- | ---------------------------- |
| CMD-18-O1  | `--priority`       | `<priority>`                  | normal                | `schedule.mts:119`           |
| CMD-18-O2  | `--model`          | `<model>`                     | claude default        | `schedule.mts:121`           |
| CMD-18-O3  | `--effort`         | `<level>`                     | claude default        | `schedule.mts:124`           |
| CMD-18-O4  | `--icon`           | `<emoji>`                     | none                  | `schedule.mts:125`           |
| CMD-18-O5  | `--label`          | `<label>`, repeatable         | none                  | `schedule.mts:126`           |
| CMD-18-O6  | `--lane`           | `<name>`                      | machine default lane  | `schedule.mts:131`           |
| CMD-18-O7  | `--auto-done`      | -                             | task ends in needs-me | `schedule.mts:135`           |
| CMD-18-O8  | `--agent`          | `<name>`                      | none                  | `schedule.mts:139`           |
| CMD-18-O9  | `--title`          | `<title>`                     | first line of prompt  | `schedule.mts:143`           |
| CMD-18-O10 | `--hold`           | -                             | Todo                  | `schedule.mts:144`           |
| CMD-18-O11 | `--backlog`        | -                             | Todo                  | `schedule.mts:145`           |
| CMD-18-O12 | `--in`             | `<duration>`                  | none                  | `schedule.mts:146`           |
| CMD-18-O13 | `--at`             | `<time>`                      | none                  | `schedule.mts:147`           |
| CMD-18-O14 | `--every`          | `<duration>`                  | none                  | `schedule.mts:151`           |
| CMD-18-O15 | `--cron`           | `<expr>`, repeatable up to 10 | none                  | `schedule.mts:152`           |
| CMD-18-O16 | `--after`          | `<schedule>`                  | none                  | `schedule.mts:157`           |
| CMD-18-O17 | `--delay`          | `<duration>`, with `--after`  | none                  | `schedule.mts:161`           |
| CMD-18-O18 | `--max-concurrent` | `<n>`                         | none                  | `schedule.mts:162`           |
| CMD-18-O19 | `--times`          | `<n>`                         | forever               | `schedule.mts:166`           |
| CMD-18-O20 | `--until`          | `<time>`                      | forever               | `schedule.mts:167`           |
| CMD-18-O21 | `--polish`         | -                             | off                   | `schedule.mts:168`           |
| CMD-18-O22 | `--new`            | -                             | duplicate check runs  | `schedule.mts:169`           |
| CMD-18-O23 | `--key`            | `<key>`                       | none                  | `schedule.mts:170`           |
| CMD-18-O24 | `--version`        | `<version>`, with `--key`     | none                  | `schedule.mts:174`           |
| CMD-18-O25 | `--json`           | -                             | text                  | `register-scheduling.mts:50` |
| CMD-18-O26 | `--dry-run`        | -                             | off                   | `register-scheduling.mts:50` |

#### CMD-19 `schedules` (DR, `--json` readable)

Actions: `pause <id>`, `resume <id>`, `rm <id>`, `edit <id> [text...|-|--file <path>]` (`register-scheduling.mts:187`). `--json` only prints the list (`:184`). The setting flags are errors outside `edit` (`:177-178`).

| ID         | Option             | Arg                                   | Default | file:line                     |
| ---------- | ------------------ | ------------------------------------- | ------- | ----------------------------- |
| CMD-19-O1  | `--title`          | `<title>`                             | keep    | `register-scheduling.mts:117` |
| CMD-19-O2  | `--file`           | `<path>`                              | none    | `:118`                        |
| CMD-19-O3  | `--priority`       | `<priority>`                          | keep    | `:119`                        |
| CMD-19-O4  | `--model`          | `<model>` or `default`                | keep    | `:120`                        |
| CMD-19-O5  | `--effort`         | `<level>` or `default`                | keep    | `:121`                        |
| CMD-19-O6  | `--icon`           | `<emoji>` or `none`                   | keep    | `:122`                        |
| CMD-19-O7  | `--label`          | `<label>`, repeatable; `none` removes | keep    | `:123`                        |
| CMD-19-O8  | `--lane`           | `<name>` or `default`                 | keep    | `:129`                        |
| CMD-19-O9  | `--auto-done`      | `<on\|off>`                           | keep    | `:132`                        |
| CMD-19-O10 | `--agent`          | `<name>` or `none`                    | keep    | `:133`                        |
| CMD-19-O11 | `--dir`            | `<path>` (a listed dir) or `none`     | keep    | `:134-137`                    |
| CMD-19-O12 | `--every`          | `<duration>`                          | keep    | `:138`                        |
| CMD-19-O13 | `--cron`           | `<expr>`, repeatable                  | keep    | `:139`                        |
| CMD-19-O14 | `--after`          | `<schedule>`                          | keep    | `:144`                        |
| CMD-19-O15 | `--delay`          | `<duration>`                          | keep    | `:145`                        |
| CMD-19-O16 | `--in`             | `<duration>`                          | keep    | `:146`                        |
| CMD-19-O17 | `--at`             | `<time>`                              | keep    | `:147`                        |
| CMD-19-O18 | `--times`          | `<n>`                                 | keep    | `:148`                        |
| CMD-19-O19 | `--until`          | `<time>`                              | keep    | `:149`                        |
| CMD-19-O20 | `--forever`        | -                                     | keep    | `:150`                        |
| CMD-19-O21 | `--max-concurrent` | `<n>` or `none`                       | keep    | `:151`                        |
| CMD-19-O22 | `--json`           | -                                     | text    | `program.mts:88`              |
| CMD-19-O23 | `--dry-run`        | -                                     | off     | `program.mts:116`             |

#### CMD-20 `feeds` (no own options; global `--dry-run` only)

Actions: `list` (default), `add <name> <file|->`, `rm <name>`, `run <name>`, `pause <name>`, `resume <name>` (`register-feeds.mts:20`). Name rule: 1-40 letters/digits/dot/dash/underscore, starting with letter or digit (`feeds/config.mts:36-45`). Cap per machine: `MAX_MACHINE_FEEDS` = 30 (`packages/shared/src/machineFeeds.mts:55`), the rest is not shown on the board.
Feed entry JSON keys (`feeds/config.mts:24-34`): `integration` (`<marketplace>:<integration>`), `action`, `options`, `every` (min 60 s), `dir`, `agent`, `lane`, `timeout`, `prompts` {`new`, `update`}.

#### CMD-21 `delay` (DR)

| CMD-21-O1 | `--in` | `<duration>` | - | both | `register-scheduling.mts:221` |
| CMD-21-O2 | `--at` | `<time>` | - | both | `:222` |
| CMD-21-O3 | `--now` | - | - | both | `:223` |
| CMD-21-O4 | `--dry-run` | - | off | both | `program.mts:116` |

#### CMD-22 `dirs` (DR)

| CMD-22-O1 | `--from-config` | - (add only) | off | main, v2 | `register-dirs.mts:34` |
| CMD-22-O2 | `--no-repo` | - (add only; negatable, `repo` defaults true) | repo auto-set | main, v2 | `register-dirs.mts:35` |
| CMD-22-O3 | `--force` | - (rm only) | off | main, v2 | `register-dirs.mts:36` |
| CMD-22-O4 | `--dry-run` | - | off | main, v2 | `program.mts:116` |

`dirs set <key> <value> [path]` / `unset <key> [path]` keys (`DIR_SETTINGS` at `config/config.mts:88`: label, repo, default, lane, ciIgnore):

| ID        | Key        | Value rule                                          | file:line                                          |
| --------- | ---------- | --------------------------------------------------- | -------------------------------------------------- |
| CMD-22-S1 | `label`    | 1-64 safe chars; the only setting sent to the board | `config/config.mts:184`                            |
| CMD-22-S2 | `repo`     | `owner/name`                                        | `config.mts:186`                                   |
| CMD-22-S3 | `default`  | must be `true`                                      | `config.mts:188`                                   |
| CMD-22-S4 | `lane`     | a lane of this config                               | `config.mts:190`                                   |
| CMD-22-S5 | `ciIgnore` | comma-separated check names, up to 20, `*` wildcard | `config.mts:194`, split in `commands/dirs.mts:409` |

Limits: at most `MAX_DIRS` = 200 entries (`config/config.mts:91`).

#### CMD-23 `plugins`: no options. Actions `list`, `install <url>`, `update <name>`, `remove <name>` (`register-plugins.mts:11`).

#### CMD-24 `config` (DR, `--json`)

| CMD-24-O1 | `--json` | - (only with `show`) | text | main, v2 | `register-config.mts:27` |
| CMD-24-O2 | `--dry-run` | - | off | main, v2 | `register-config.mts:28` |

Actions: `show`, `get <key>`, `set <key> <value>`, `unset <key>`, `edit`, `path` (`register-config.mts:14`). `set` value is JSON when it parses, else a string. Keys the CLI reads (`set` refuses unknown ones and names the nearest, refuses keys below `dirs`):

- Top level `TOP_KEYS` (`config/config.mts:678-691`): `machine`, `lanes`, `defaultCwd`, `pauseAfterMinutes`, `inactivityMinutes`, `maxRunHours`, `autoUpdate` (`incompatible|always|never`, `config.mts:68`), `agents`, `repos`, `dirs`, `usageLimits`, `feeds`.
- Lane keys `LANE_KEYS` (`:692`): `slots`, `cwd`, `default`, `skills` (dotted: `lanes.<name>.<key>`).
- `usageLimits` keys (`:102`): `fiveHour`, `sevenDay`, `priority`.
- Agent keys `AGENT_KEYS` (`:344-355`): `description`, `prompt`, `tools`, `allowedTools`, `disallowedTools`, `mcpServers`, `env`, `model`, `version`, `source` (unknown agent key is an error, not a warning).
- Feed entries: keys of CMD-20.

#### CMD-25 `agents` (DR)

| CMD-25-O1 | `--json` | - (list, show, export) | text/YAML | main, v2 | `register-agents.mts:39` |
| CMD-25-O2 | `--yaml` | - (show, export); not with `--json` | YAML | main, v2 | `:40` |
| CMD-25-O3 | `--name` | `<name>` (add, push) | document name, else file name | main, v2 | `:41` |
| CMD-25-O4 | `--replace` | - (add) | refuse existing | main, v2 | `:42` |
| CMD-25-O5 | `-y, --yes` | - (add, push) | asks at a terminal | main, v2 | `:43` |
| CMD-25-O6 | `--board` | - (rm) | local rm | main, v2 | `:44` |
| CMD-25-O7 | `--dry-run` | - | off | main, v2 | `program.mts:116` |

Sources for `add`/`push`: file, `-`, https URL (`#sha256=<hex>` pin), `example:<name>`. `show` = YAML with `source`, `export` = without.

#### CMD-26 `init`

| CMD-26-O1 | `--url` | `<url>` (https, or http for localhost) | prompt | main, v2 | `register-setup.mts:103` |
| CMD-26-O2 | `--token-file` | `<path>` (mode 600/400 or pipe) | prompt; refused with credentials command [v2] | main, v2 | `:104` |
| CMD-26-O3 | `--data-key-file` | `<path>` | prompt; refused with credentials command [v2] | main, v2 | `:108` |
| CMD-26-O4 | `--machine` | `<name>` | main: host name. [v2] only a check against the name the board reports (`[v2] register-setup.mts:100-103`) | main, v2 | `:112` |
| CMD-26-O5 | `--force` | - | keep existing files | main, v2 | `:113` |

#### CMD-27 `doctor`: `--json` (`register-setup.mts:145`, via `jsonOption`; plain, not readable). No `--dry-run`.

#### CMD-28 `setup`

| CMD-28-O1 | `--enable` | - | print enable lines only | `register-setup.mts:172` |
| CMD-28-O2 | `--force` | - | refuse foreign checkout/tmp binary | `:173` |
| CMD-28-O3 | `--print` | - | write units | `:177` |

#### CMD-29 `uninstall` (DR)

| CMD-29-O1 | `--include-optional` | - | keep config, state, run dirs | main | `register-setup.mts:195` |
| CMD-29-O2 | `--dry-run` | - | off | main | `program.mts:116` |

#### CMD-30 `restart`: argument `[unit...]` `Argument.choices(dispatch|listen|watch)`, default all three (`register-setup.mts:225`). No options.

#### CMD-31 `logs`

| CMD-31-O1 | `-f, --follow` | - | off | `register-setup.mts:243` |
| CMD-31-O2 | `-n, --lines` | `<n>` | `100` (`setup/units.mts:126`) | `:244` |
| CMD-31-O3 | `--since` | `<time>` (Linux units only) | none | `:245` |

#### CMD-32 `self-update`

| CMD-32-O1 | `--check` | - | off | main, v2 | `register-setup.mts:281` |
| CMD-32-O2 | `--resume` | - | off | main only | `:282` |
| CMD-32-O3 | `--rollback` | - | off | main only | `:283` |
| CMD-32-O4 | `--server` | `<url>` | none | main only | `:284` |

#### CMD-33 `completion`: argument `<shell>` choices `bash|zsh|fish`. CMD-34 `example`: `[name]`. No options.

#### CMD-36..45 hidden internals

| ID        | Option      | Arg               | Default                                                     | Branch | file:line                       |
| --------- | ----------- | ----------------- | ----------------------------------------------------------- | ------ | ------------------------------- |
| CMD-37-O1 | `--dry-run` | -                 | off                                                         | both   | `register-internal.mts:31`      |
| CMD-42-O1 | `--json`    | -                 | (output is JSON anyway)                                     | main   | `register-internal.mts:65`      |
| CMD-44-O1 | `--grace`   | `<seconds>` (> 0) | `20` (`[v2] setup/shutdown.mts` `DEFAULT_SHUTDOWN_GRACE_S`) | v2     | `[v2] register-internal.mts:69` |

`internal worker` takes `<task>`; `internal hook` takes `[args...]` with unknown options allowed; `internal listen`, `watch`, `intake`, `units` take nothing.

### 1.4 Environment variables the CLI reads

Process environment (via `env[...]`/`process.env`):

| ID     | Variable                                                                | Effect                                                                                                                                                                              | file:line                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV-01 | `AGENT_BOARD_CONFIG_DIR`                                                | Config dir (`web.json`, `env`, `config.json`); default `~/.config/agent-board`                                                                                                      | `apps/cli/src/config/config.mts:154`; forwarded to units at `setup/launchd.mts:30`, `setup/process-system.mts:41`, `setup/system.mts:116`; read by uninstall `setup/uninstall.mts:154` |
| ENV-02 | `AGENT_BOARD_STATE_DIR`                                                 | State dir (logs, sessions, waits, watches, catalog); default `$XDG_STATE_HOME/agent-board` or `~/.local/state/agent-board`                                                          | `config/config.mts:156`                                                                                                                                                                |
| ENV-03 | `XDG_STATE_HOME`                                                        | Base of the default state dir                                                                                                                                                       | `config/config.mts:156`; forwarded `setup/launchd.mts:33`, `setup/process-system.mts:44`, `setup/system.mts:119`                                                                       |
| ENV-04 | `AGENT_BOARD_RUN_DIR`                                                   | Run/lock directory                                                                                                                                                                  | `worker/runtime.mts:57`; forwarded `setup/launchd.mts:32`, `setup/process-system.mts:43`, `setup/system.mts:118`                                                                       |
| ENV-05 | `XDG_RUNTIME_DIR`                                                       | Run dir parent and Linux lock dir (fallback `/tmp`)                                                                                                                                 | `worker/runtime.mts:58,67`; forwarded `setup/launchd.mts:34`, `setup/system.mts:120`                                                                                                   |
| ENV-06 | `XDG_CONFIG_HOME`                                                       | Where systemd user units are written                                                                                                                                                | `setup/setup.mts:197`                                                                                                                                                                  |
| ENV-07 | `BOARD_INSTALL_DIR`                                                     | Where the installed `board` lives (default `~/.local/bin`)                                                                                                                          | `setup/setup.mts:228`                                                                                                                                                                  |
| ENV-08 | `AGENT_BOARD_TASK`                                                      | Task id of the run; its presence = "inside a board run"                                                                                                                             | `cli.mts:49`, `commands/program.mts:80,103`, `register-agents.mts:88`, `register-internal.mts:85`, `register-tasks.mts:247,326,412,435,521,550`                                        |
| ENV-09 | `AGENT_BOARD_RUN`                                                       | Board's id of the run; sent with calls for the run's own task                                                                                                                       | `cli.mts:50`                                                                                                                                                                           |
| ENV-10 | `AGENT_BOARD_RESTRICTED`                                                | `1` for an agent's run: refuses `wait --check`, command watches, `agents add/push/rm`                                                                                               | `register-tasks.mts:315,325`, `register-agents.mts:88`, `commands/board.mts:602-615`                                                                                                   |
| ENV-11 | `AGENT_BOARD_START_DIR`                                                 | Directory the run started in; source of `settings.json` env for checks and where `board add` defaults                                                                               | `register-tasks.mts:316,327,520`, set at `worker/worker.mts:355`                                                                                                                       |
| ENV-12 | `VISUAL`, `EDITOR`                                                      | Editor for `board config edit` (VISUAL first; no default)                                                                                                                           | `register-config.mts:79`                                                                                                                                                               |
| ENV-13 | `PATH`                                                                  | Finds `claude`, `gh`, `flock`, ...                                                                                                                                                  | `register-setup.mts:67`, `setup/setup.mts:258,288`, `catalog/catalog.mts:289`; also in the worker passthrough `setup/process-system.mts:32`                                            |
| ENV-14 | `HOME`                                                                  | Home dir for doctor/migration                                                                                                                                                       | `register-setup.mts:68`, `commands/migration-deps.mts:28`, `setup/setup.mts:274`                                                                                                       |
| ENV-15 | `CLAUDE_CONFIG_DIR`                                                     | Where the skills/catalogue probe looks (default `~/.claude`)                                                                                                                        | `catalog/catalog.mts:313`                                                                                                                                                              |
| ENV-16 | `NO_PROXY`, `no_proxy`                                                  | The CLI APPENDS loopback entries before the first request so a local board never goes through `HTTP_PROXY`                                                                          | `cli.mts:165-175`, called at `main.mts:4`                                                                                                                                              |
| ENV-17 | `NO_COLOR`, `FORCE_COLOR`, `TERM`                                       | Colour decision through Node's `stream.hasColors(env)`                                                                                                                              | `output/style.mts:8-13`, `cli.mts:107`                                                                                                                                                 |
| ENV-18 | `USER`, `LOGNAME`, `SHELL`, `SSH_AUTH_SOCK`, `TMPDIR`, `LANG`, `LC_ALL` | Not read by the CLI; passed to the worker process on Linux/macOS (`PASSED_ENV`)                                                                                                     | `setup/process-system.mts:31-46`                                                                                                                                                       |
| ENV-19 | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`                                       | Read from the `env` blocks of Claude settings layers (not process env)                                                                                                              | `worker/settings-env.mts:61`                                                                                                                                                           |
| ENV-20 | `AGENT_BOARD_CREDENTIALS_COMMAND`                                       | `[v2]` absolute path of an executable that prints `AGENT_BOARD_TOKEN=` and `AGENT_BOARD_DATA_KEY=`; no shell, no args, 10 s timeout, 64 KB output; replaces the `env` file entirely | `[v2] config/credentials-source.mts:8,21,43-64`, forwarded to launchd `[v2] setup/launchd.mts` PASSED_ENV                                                                              |

Not process environment (read from the `env` FILE in the config dir via `loadEnvFile`, `config/env-file.mts`):

| ID     | Key                    | Effect                                          | file:line                                                                                                |
| ------ | ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ENV-21 | `AGENT_BOARD_TOKEN`    | Machine token, must start `abm_`, no whitespace | `backend/web-config.mts:34,40`; `setup/init.mts:129`; `setup/doctor.mts:299`; `migrate/rollback.mts:134` |
| ENV-22 | `AGENT_BOARD_DATA_KEY` | Data key `abk1_` + 43 chars                     | `backend/web-config.mts:45,55`; `setup/init.mts:130`; `setup/doctor.mts:322,342`                         |

Also: `web.json` holds the single board `url` (`backend/web-config.mts`). Nothing reads `AGENT_BOARD_URL`.

### 1.5 Exit codes at a glance

| Code | Where                                                                                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success; `events` after Ctrl-C; `internal hook` always (`main.mts:19`); `__complete` always (`main.mts:14`, `register-setup.mts:449`); `schedule --key` for created/exists/requeued/rescheduled; `internal intake`                                                                             |
| 1    | expected failures (`ConfigError`, `BackendError`, `GitHubError`, `SystemError`, unexpected) (`cli.mts:123-136`); `doctor`/`init` with a failed check; `feeds run` failed; `restart` failed; `uninstall` partly failed; `self-update --resume` stopped; `events` write failure or refused token |
| 2    | usage error (`cli.mts:135`)                                                                                                                                                                                                                                                                    |
| 3    | `move --expect` mismatch (`register-tasks.mts:258`)                                                                                                                                                                                                                                            |
| 75   | `flock -E 75` / `lockf -s -t 0`: another dispatch tick holds the lock; accepted as success by systemd `SuccessExitStatus=75` (`setup/setup.mts:129-131`)                                                                                                                                       |
| 124  | `internal dispatch` tick passed its time limit (`dispatch/dispatch.mts:353,805`)                                                                                                                                                                                                               |
| n    | `attach`: the exit status of `claude` (`commands/board.mts:341-342`); `logs`: journalctl/tail status                                                                                                                                                                                           |

## 2. Deliverable 2 - gap review

Frame: the CLI authenticates with a machine token (`/api/machine/<command>`, `docs/machine-api.md`). The 71 UI procedures (`packages/shared/src/ui/procedures.mts`) authenticate with a user session. A CLI equivalent of a UI procedure needs either a machine-API command or a user credential. Where the machine API has no such command it says "no machine API".

"Worth it?" = `engine` (host worker needs it), `user tool` (a person at a terminal), `no`.

### 2.1 UI procedures with no CLI equivalent

Covered (not gaps): `tasks.list`/`get` (`tasks`, `show`), `tasks.create` (`schedule`, `add`), `tasks.move`/`done` (`move`), `tasks.setPriority`/`configure`/`edit` (`task set ...`), `tasks.setNotBefore`/`wakeNow` (`delay`), `tasks.removePr` (`pr --remove`), `schedules.list/setPaused/update/remove` (`schedules`), `agents.shared` (`agents list/push/rm --board`), `feeds.list` (partial: `feeds` lists this machine only).

| #    | UI procedure                                                                  | CLI today                                                                    | Machine API today                                                                              | Worth having?           | Reasoning                                                                                                                     |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| G-01 | `tasks.answer`                                                                | none; `ask` is the agent side                                                | no (the answer note is author `user`; `add-note` allows only `agent`/`system`)                 | user tool               | Answering from a terminal or script is the obvious counterpart of `board ask`; needs a server command that seals as the user. |
| G-02 | `tasks.dismissQuestion`                                                       | none                                                                         | no                                                                                             | user tool               | Same family as G-01, tiny.                                                                                                    |
| G-03 | `tasks.reply` (with `resume` flag)                                            | `comment` adds an agent-authored note that does not resume                   | no                                                                                             | user tool               | `board comment` posting as `agent` is a known mismatch for a human; a `reply` with `--resume` matches the UI.                 |
| G-04 | `tasks.send` (message to a running agent / Send & continue)                   | none                                                                         | no (`run-inbox`/`ack-messages` are the worker side)                                            | user tool               | Steering a running agent from a terminal is the highest-value interactive gap.                                                |
| G-05 | `tasks.stop` ("Stop", "Stop & send")                                          | none; `move` only changes status                                             | no (nearest: `update-task status`)                                                             | user tool               | Interrupting a run belongs to the person; `move <task> needs-me` does not interrupt the process.                              |
| G-06 | `tasks.takeBack`                                                              | none                                                                         | no                                                                                             | user tool               | Same as G-05 for a stale run (UI allows after `TAKE_BACK_AFTER_MS` = 20 min, `contract.mts:91`).                              |
| G-07 | `tasks.rerun` ("Re-run fresh")                                                | `move <task> todo` resumes the session                                       | `update-task {status:"todo", next:"fresh"}` exists, but the CLI never sends `next`             | user tool               | One flag (`move --fresh`) or `task rerun`; no server work.                                                                    |
| G-08 | `tasks.setClosed` (close/reopen)                                              | `tasks --all` only reads closed                                              | no (core never writes a closed task)                                                           | user tool               | Housekeeping; needs a server command.                                                                                         |
| G-09 | `tasks.fork`                                                                  | none                                                                         | no (`forkOf` is read-only; `attach --fork` forks the claude session locally only)              | user tool               | Needs the sealed prompt for a fork link; the CLI already seals for the user, so feasible, but low frequency.                  |
| G-10 | `tasks.applyPolish`                                                           | `polish` posts, nobody applies                                               | no                                                                                             | user tool               | Applying a polished prompt from a terminal is rare; skip unless the user tool is a goal.                                      |
| G-11 | `tasks.stopWatch`                                                             | `unwatch` stops a watch on THIS machine only                                 | machine side: `ack-watch-stops`                                                                | no                      | Watches live on the machine; `unwatch` run there is enough.                                                                   |
| G-12 | `schedules.update` fields not in `schedules edit`                             | `edit` covers the dialog, `--dir`, `--agent`                                 | `edit-schedule`                                                                                | no                      | Equivalent exists.                                                                                                            |
| G-13 | `machines.list`                                                               | none (used only inside `self-update --server`, `register-setup.mts:320-322`) | `list-machines` (`docs/machine-api.md:1111`)                                                   | user tool               | `board machines` would help to see which hosts are online; cheap.                                                             |
| G-14 | `machines.issue`                                                              | none                                                                         | no (user session only)                                                                         | user tool (via `init`)  | Issuing a token belongs with the local-server story: `init --issue` against a local server with a user credential.            |
| G-15 | `machines.revoke`                                                             | none                                                                         | no                                                                                             | user tool + `uninstall` | See B-04.                                                                                                                     |
| G-16 | `machines.catalogs`, `machines.advertisedCli`                                 | none                                                                         | `set-catalog` is write-only; advertised CLI comes back in `version` and drives the update hint | no                      | Display data for the UI; `advertisedCli` already surfaces as the update hint.                                                 |
| G-17 | `feeds.request` (UI asks a machine to run/pause/resume a feed)                | `feeds run/pause/resume` act locally only                                    | `feedRequests` in `version`, `ack-feed-requests` (machine side)                                | no                      | The other direction (CLI asking another machine's feed) is rarely needed.                                                     |
| G-18 | `links.get/set` (link rules)                                                  | none                                                                         | no machine API (browser-only sealed doc)                                                       | no                      | Pure rendering rule for the browser.                                                                                          |
| G-19 | `titleRules.get/set`                                                          | none; the worker applies rules (`get-title-rules`, `apply-title-rule`)       | read only                                                                                      | user tool (low)         | Editing rules in a file/CLI could be nice; machine can read already. Writes are compare-and-set on the browser's sealed doc.  |
| G-20 | `transcript.runs/events/context/output`                                       | `logs <task>` reads the local log file only; `attach` opens the session      | machine side is upload-only (`transcript` command)                                             | user tool               | A `board transcript <task>` for reading a run would be useful and read-only; needs a server read command.                     |
| G-21 | `account.export/import/summary/delete`                                        | none; `self-update --server` tells the person to do it in the browser        | no                                                                                             | user tool               | A scripted export/import would make server moves non-interactive; needs user credentials, so low priority.                    |
| G-22 | `keys.get/setup/replaceSlots`                                                 | none                                                                         | no                                                                                             | no                      | Key setup stays in the browser: the data key must not travel through a machine token.                                         |
| G-23 | `auth.*`, `passkeys.*`, `me`, `revision`, `ui.version`                        | none                                                                         | no                                                                                             | no                      | Browser session concerns. `version` handshake: see B-07.                                                                      |
| G-24 | `tasks.list/get` extras: `noteCount`, `forkOf`, `watches`, `held` in `--json` | `taskJson`                                                                   | yes                                                                                            | no                      | Verify field parity with `taskJson` if a script needs it (not checked).                                                       |

Totals: 71 UI procedures. 19 are covered by a CLI command (tasks list/get/create/move/done/setPriority/configure/edit/setNotBefore/wakeNow/removePr, schedules x4, agents.shared, feeds.list partly). The rest have no CLI equivalent and fall into 23 gap rows (G-01..G-23): 9 are worth having as a user tool and need a new machine-API command (G-01, 02, 03, 04, 05, 06, 08, 09, 20), 2 need only a CLI change (G-07 `move --fresh`, G-13 `board machines`), 3 are optional (G-10, G-19, G-21), and the remaining rows (G-11, 12, 16, 17, 18, 22, 23) are not worth a CLI command (browser-only, machine-local or already covered).

### 2.2 Known missing items

| ID   | Item                                                       | State in code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Needed                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B-01 | One CLI, several servers (profiles)                        | One `web.json` + one `env` per config dir (`backend/web-config.mts`). Separation only through `AGENT_BOARD_CONFIG_DIR`/`STATE_DIR`/`RUN_DIR` (ENV-01,02,04), which every command honours and which `setup` forwards into units (`setup/launchd.mts:30-34`). No `--profile` flag, no `board profile list/use`, no per-profile unit names. `self-update --server <url>` MOVES a machine to another board instead (`register-setup.mts:301-326`).                                                                                                                 | A profile concept: name -> config dir/state dir/run dir, selected by flag or env, shown by `doctor`, used by completion (`__complete` asks one board) and by `events`.                                                               |
| B-02 | Several servers' workers on one macOS user                 | Launchd labels are fixed: `de.codeplant.agent-board.<dispatch\|listen\|watch>` (`setup/launchd.mts:16-21`). Linux units fixed: `agent-board-<name>.service/.timer` (`setup/setup.mts:49,53,121,136`). Lock file `agent-board-dispatch.lock` (`dispatch/tick.mts:15`). Worker units `agent-board-<taskId>` (`task-id.mts:9`). `setup` refuses another checkout unless `--force` (`setup/setup.mts:231-252`), and a second profile's `setup` would overwrite the first one's agents.                                                                             | Profile-qualified labels/unit names/lock names and a way for `restart`, `logs`, `uninstall`, `doctor` to address them.                                                                                                               |
| B-03 | Credentials in the macOS Keychain directly                 | Credentials are read only from the mode-600 `env` file (`config/env-file.mts`, `backend/web-config.mts:78`). `[v2]` adds `AGENT_BOARD_CREDENTIALS_COMMAND` (absolute executable, no args, no shell, 10 s, 64 KB; `credentials-source.mts`) so a wrapper script can call `security find-generic-password`. `init` with it writes no `env` and refuses `--token-file`/`--data-key-file`. No `security` call from the CLI, no `board credentials set/get`, no Keychain write by `init`. `docs/setup.md:167` notes that only `claude`/`gh` use the login keychain. | A built-in Keychain source (and Secret Service on Linux) with `init` writing to it; units must be able to read it from a launchd agent (gui domain).                                                                                 |
| B-04 | `uninstall` revoking the token                             | `setup/uninstall.mts` stops units, deletes the installed binary and (optionally) dirs; it keeps the token in `env` by default and never calls the server (`uninstall.mts:117`). Revocation exists only as `machines.revoke` in the UI.                                                                                                                                                                                                                                                                                                                         | A machine-API self-revoke (`revoke-self`) plus `uninstall --revoke`; today a removed machine's token stays valid.                                                                                                                    |
| B-05 | Projects (new server entity owning tasks, schedules, dirs) | No project concept in code or docs (grep of `apps`, `packages`, `docs`: only the English word). Nearest things: `dirs` entries with `label`, `repo`, `lane` sent to the board via `set-dirs` (`commands/dirs.mts`, `docs/machine-api.md:980`), and `repos` in config.                                                                                                                                                                                                                                                                                          | `board projects` (list/select), a `--project` option or `project` binding on `add`, `schedule`, `tasks`, `events`, `dirs set project <id>`, and a way to bind a dir to a project (like `dirs set lane`). Also `__complete projects`. |
| B-06 | Machine-readable units recipe for packagers                | `[v2]` `board internal units` prints `ResolvedWorkerUnits` JSON, schema 1 (`[v2] setup/worker-units.mts`), hidden command. `main` has none: the unit text is built inside `setup/setup.mts` and `setup/launchd.mts`.                                                                                                                                                                                                                                                                                                                                           | Merge it, and consider promoting it from `internal` (hidden, refuses to run in a run and on other platforms) to a documented command.                                                                                                |
| B-07 | Version/handshake command (contract version + features)    | `board --version` prints `board <ver> (api <N>, ...)` only (`self/version.mts:27-30`). The server's `version` answer (api, minClient, features, owner, keyId, cli, `[v2]` machine) is fetched by `verifyContract` (`backend/contract-check.mts`) and only reaches the person as `doctor` check lines (`setup/doctor.mts:366` names missing features). `doctor --json` returns check results, not the handshake.                                                                                                                                                | `board version [--json]` printing CLI version, CLI contract range and client vocabulary, and (when reachable) the server's api/minClient/features, plus which CLI-side features are enabled.                                         |
| B-08 | Branch divergence                                          | See section 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Reconcile `main` and `local-server-v2` before deriving a spec.                                                                                                                                                                       |

### 2.3 Things marked TODO, deferred or "not supported" in code/docs

A grep of `apps/cli/src` and `docs/` for `TODO|FIXME|XXX|not implemented|deferred|for now` found no TODO/FIXME markers in non-test CLI code. Explicit limits found:

| ID   | Where                                                                                                                                                                      | What                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | `docs/cli.md:1569` (`logs --since`)                                                                                                                                        | Not available on macOS or for a task log.                                                                                                                                                                                                            |
| T-02 | `apps/cli/src/commands/register-internal.mts:26-29`                                                                                                                        | `internal ...` refuses on any platform other than Linux/macOS: no Windows worker.                                                                                                                                                                    |
| T-03 | `setup/doctor.mts` worker checks                                                                                                                                           | "Left out on a system other than Linux and macOS, where no worker runs" (`register-setup.mts:153`).                                                                                                                                                  |
| T-04 | `setup/launchd.mts` / `docs/setup.md:167`                                                                                                                                  | launchd agents run in the `gui` domain only while the user is logged in; checkouts under `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive are warned about. No headless macOS service.                                                        |
| T-05 | `commands/dirs.mts:154`, `config/dirs.mts:90,112`, `config/board-agents.mts:290,338`, `catalog/catalog.mts:176,240`, `feeds/publish.mts:96`, `backend/sealing.mts:413-456` | Result `unsupported` = the server lacks the feature (`machine.dirs`, `machine.catalog`, `agents.shared`, `machine.feeds`, ...); the CLI warns and carries on. Older boards need a `server-older` skip: `skipTickWhileServerOlder` (`cli.mts:69-79`). |
| T-06 | `backend/web-backend.mts:306-315`                                                                                                                                          | `comment --suggest` degrades to a plain note on a server without `note.suggestion`.                                                                                                                                                                  |
| T-07 | `docs/machine-api.md` update-task table                                                                                                                                    | `waiting` can only be entered through `wait`; `move <task> waiting` is a 400; a proposal's status change is a 403.                                                                                                                                   |
| T-08 | `docs/setup.md:462,576`, `docs/workers.md:576`                                                                                                                             | A CLI older than shared agents ignores board agents.                                                                                                                                                                                                 |
| T-09 | `register-tasks.mts:269-270`, `register-task-settings.mts:49`                                                                                                              | Questions limited to 1-4; `set prompt` only on the user's own unclaimed Todo/Backlog task; schedule cards edit through `schedules edit`.                                                                                                             |
| T-10 | `docs/cli.md` `schedule --polish`                                                                                                                                          | Cannot combine with `--hold`, `--in`, `--at`, a repeat. `--key` cannot combine with a repeat, `--polish`, `--hold`, `--backlog`.                                                                                                                     |
| T-11 | `register-config.mts` description                                                                                                                                          | `config set/unset` refuse keys below `dirs` (use `board dirs`); `config edit` needs a terminal and has no default editor.                                                                                                                            |
| T-12 | `docs/machine-api.md:271,420`                                                                                                                                              | The core never writes to a closed task, and there is no machine command to close one.                                                                                                                                                                |
| T-13 | `commands/register-setup.mts:296` and others                                                                                                                               | Many commands refuse inside a run by design (see NIR column); `polish` only works inside one.                                                                                                                                                        |

### 2.4 Short list of the most important gaps

1. B-05 projects: nothing exists; every command that lists, creates or binds work needs a project argument and `dirs` needs a binding.
2. B-01/B-02 profiles and fixed unit names: the CLI cannot serve two servers on one user (fixed launchd label prefix and systemd unit names).
3. G-01..G-06 interactive task control (answer, reply, send, stop, take back): the CLI is write-only for the agent side; the machine API has no user-authored commands.
4. B-03/B-04 credential story: Keychain only through an external command on the unmerged branch; uninstall leaves a live token.
5. B-07 handshake command and B-06 units recipe: both partial/unmerged.
6. Branch divergence (section 0).

## 3. Decisions for the new CLI

The census above is the requirement (cli-012): every command, option, sub-action key, environment variable and exit
code listed in §1 is supported by the new CLI, merged from both lines (`main` and `local-server-v2`), with the
exceptions below. Release names and unit labels change where noted; behaviour does not.

### 3.1 Not carried over

| Item                                                                            | Reason                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CMD-38 `internal intake`                                                        | Already a removed feature that only prints "removed" so stale timers do not fail. No install of the new CLI has such a timer. |
| `de.codeplant.agent-board.*` launchd labels, `agent-board-<name>` systemd names | Replaced by per-profile labels (cli-051); the old labels collide across servers.                                              |
| Release source `mloureiro/agent-board` `cli-v*`                                 | Replaced by this repository's CLI releases (cli-056).                                                                         |

### 3.2 Gaps adopted as catalogue rows

| Gap                           | Catalogue row                                                 |
| ----------------------------- | ------------------------------------------------------------- |
| G-01, G-02 answer, dismiss    | cli-028                                                       |
| G-03, G-04 reply, send        | cli-029                                                       |
| G-05, G-06 stop, take back    | cli-030                                                       |
| G-07 re-run fresh             | cli-031                                                       |
| G-08 close, reopen            | cli-032                                                       |
| G-09 fork                     | cli-033                                                       |
| G-13 machines list            | cli-035                                                       |
| G-20 transcript               | cli-034                                                       |
| G-24 JSON field parity        | cli-013                                                       |
| B-01 profiles                 | cli-050                                                       |
| B-02 several servers' workers | cli-051                                                       |
| B-03 Keychain                 | cli-008                                                       |
| B-04 uninstall revokes        | cli-052, api-089                                              |
| B-05 projects                 | cli-039, cli-013, cli-023, cli-024, cli-026, cli-036, cli-038 |
| B-06 units recipe             | cli-054, contract-010                                         |
| B-07 version and handshake    | cli-011                                                       |
| B-08 branch divergence        | cli-012 (both lines merged)                                   |

The user-tool commands (cli-028…035) need user-authored machine commands in the contract (today the machine API
only writes `agent` and `system` notes). Step 2 decides how a machine token may act as its owner for these.

### 3.3 Gaps not adopted

| Gap                                 | Reason                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| G-10 apply polish                   | Rare from a terminal; the browser client applies it (web-046).                                                           |
| G-11 stop another machine's watch   | `unwatch` on the owning machine is enough; the browser stops any watch (web-044).                                        |
| G-12 schedule fields                | Already covered by `schedules edit`.                                                                                     |
| G-14 issue a machine token          | Needs a user session, not a machine token; issuing stays in the browser client (web-069) and the server app's enrolment. |
| G-16 catalogues, advertised CLI     | Display data; the advertised CLI already drives the update hint.                                                         |
| G-17 request another machine's feed | Rarely needed; each machine runs its own feeds.                                                                          |
| G-18 link rules                     | A browser rendering rule.                                                                                                |
| G-19 title rules editing            | Low value; rules are edited in the browser (web-072) and the worker already reads them.                                  |
| G-21 account export/import          | Needs user credentials, which the CLI does not hold by design.                                                           |
| G-22 keys                           | The data key must not travel through a machine token.                                                                    |
| G-23 sign-in, passkeys              | Browser session concerns.                                                                                                |
