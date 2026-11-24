# ADR-0009: A machine may act as its owner only with a grant

## Status

Accepted.

## Context

The CLI gap review adopted user commands (answer, dismiss, reply, send, stop, take back, re-run, close, reopen,
fork, transcript). The CLI holds only a machine token. Agents run on the same host as the CLI, so a machine that
can act as the user lets an agent answer its own questions or approve its own proposals, which the board's
human-in-the-loop rules forbid (api-056).

## Decision

- A machine has an `acts_as_owner` flag, false by default. Only a user session sets or clears it (Settings ›
  Machines).
- User-authored machine commands: `answer`, `dismiss-question`, `reply`, `send`, `stop`, `take-back`, `rerun`,
  `set-closed`, `fork`, `list-runs`, `transcript-events`, `transcript-output`.
- Without the grant: 403 `grant-required`. While the calling machine holds the active run of the target task:
  409 `run-holds-task`.
- Notes written this way are authored by the user and record `via_machine_id`.
- The CLI refuses these commands inside a run, before sending anything.

## Consequences

- A fresh install cannot use the user commands until the user grants them, and the CLI says how.
- An agent on a granted machine could still act on other tasks; the grant is a deliberate choice per machine.

## Rows affected

cli-028 … cli-035, cli-084 (new), api-119 (new), web-105 (new).
