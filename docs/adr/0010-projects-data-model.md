# ADR-0010: Projects data model

## Status

Accepted.

## Context

A project is a server entity owning tasks, schedules and directories (R3.1). The board shows all projects or one.
Directories today live only inside a sealed per-machine document the server cannot read, and each task carries its
directory sealed, so the server could not enforce that a directory belongs to one project.

## Decision

- `project` (owner, id, sealed name or null, sealed icon or null, position, is_default, archived_at, timestamps).
  One default project per owner; it cannot be deleted or archived.
- `directory` (owner, id, machine_id, project_id, sealed path, sealed repo) replaces the sealed directory
  document; the CLI's `set-dirs` writes it, and the machine's version answer no longer carries a directory
  document index.
- `task` and `schedule` gain `project_id` (not null) and `directory_id` (null), with a composite foreign key
  (owner, directory_id, project_id) to `directory`, checked at commit, so a task's directory is always in the
  task's project.
- The default project is created with the user row and by migration, with a null name, because only clients can
  seal. Clients show "Default" until the user renames it.
- Occurrences copy their schedule's project; forks copy the parent's.
- **Deleting a project** that still has tasks, schedules or directories is refused unless the request says
  `then: "move-to-default"` (move them all to the default project) or `then: "delete"` (delete the tasks with
  their notes and transcripts, the schedules and the directories). A running task refuses either. Archived projects
  take no new tasks.
- **Moving a directory** to another project is refused with 409 `directory-in-use` while tasks or schedules use it,
  unless the request says `withUsers: true`; then they all move in one transaction. A running task refuses it.
- **Migrated boards.** The import keeps each machine's legacy `dirs` document (`legacy_dirs`) and each task's and
  schedule's sealed directory (`legacy_directory`) as stored. A CLI holding the data key converts them on
  `rumo init`, at listener start or before `set-dirs`: it writes `directory` rows in the default project and
  back-fills `directory_id` for its machine's tasks and schedules, and unassigned ones, whose paths match. The
  server applies the conversion in one transaction, clears the matched legacy values and deletes the document.
- Task, schedule and client event queries take an optional project filter.

## Consequences

- Moving a task to another project also moves or clears its directory, in one request.
- Directory paths stay sealed; the server sees only ids.
- Until a migrated machine's CLI connects, its tasks show no directory; a task whose legacy path matches nothing
  keeps showing none until the user sets one.

## Rows affected

api-071, api-087, api-102 … api-106, api-116 (new), api-117 (new), api-125 (new), cli-038, cli-039,
cli-085 (new), web-081 … web-084, web-106 (new), migrate-005.
