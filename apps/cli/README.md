# board CLI

The `board` command: the engine on each host that runs `claude`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mloureiro/agent-board-standalone/main/apps/cli/scripts/install.sh | sh
```

The script picks the newest `cli-v*` release for linux-x64, linux-arm64 or darwin-arm64, checks it against the
release's `SHA256SUMS` and installs it at `$BOARD_INSTALL_DIR/board` (default `~/.local/bin/board`).
Use `--version x.y.z` to pin a release.

## Update

- `board self-update` installs the newest release, after a backup of the config and state files. A local
  migration step runs after the swap. `--check` only reports, `--resume` finishes a migration that stopped, and
  `--rollback` restores the newest backup and holds auto-update until the next manual update.
- `board self-update --server <url>` points this machine at another server after checking the token, owner and
  key id there.
- `autoUpdate` in `config.yaml` is `incompatible` (default: update only when the server needs a newer CLI),
  `always` or `never`. A failed automatic update is retried one hour later.

## Shell completion

```sh
board completion bash > ~/.local/share/bash-completion/completions/board
board completion zsh  > "${fpath[1]}/_board"
board completion fish > ~/.config/fish/completions/board.fish
```

## Build and release

- `pnpm --filter @agent-board/cli run build` builds the Node bundle `dist/board`.
- `node scripts/compile.ts [--target <t> | --all]` builds the Bun binaries in `dist/release/`.
- `node scripts/smoke.ts <binary>` runs the smoke checks CI runs on each binary.
- `node scripts/release.ts <x.y.z> --notes <text>` sets the version in `package.json`, `src/version.ts` and
  `CHANGELOG.md`, builds the three binaries with `SHA256SUMS`, and prints the commit, tag and push commands.
  It tags and publishes nothing. Pushing the `cli-v<x.y.z>` tag runs the CLI release workflow.
