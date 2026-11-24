# ADR-0011: CLI profiles for several servers

## Status

Accepted.

## Context

One CLI host may serve several servers (R3.5). Today's CLI uses fixed launchd labels, systemd names and config
paths, so a second server replaces the first. The server app must also never collide with a CLI install on the
same Mac.

## Decision

- A global `--profile <name>` option, or `AGENT_BOARD_PROFILE`, selects the profile; the default is `default`.
  Names match `^[a-z0-9][a-z0-9-]{0,31}$`. `--server` stays the per-command URL option of `self-update`.
- Per profile: config in `$XDG_CONFIG_HOME/agent-board/profiles/<name>/`, state in
  `$XDG_STATE_HOME/agent-board/profiles/<name>/`, run files in `<state>/run/`.
- `AGENT_BOARD_CONFIG_DIR`, `AGENT_BOARD_STATE_DIR` and `AGENT_BOARD_RUN_DIR` replace those directories.
- launchd labels `agent-board.<profile>.<unit>`; systemd units `agent-board-<profile>-<unit>`; Keychain service
  `agent-board.cli.<profile>`.
- The server app runs the CLI with the three directory overrides under its own root and installs no units.

## Consequences

- Locks, run folders and units never clash between profiles.
- `board version` and `board doctor` report per profile.

## Rows affected

cli-008, cli-050, cli-051, cli-053, server-app-007, server-app-044.
