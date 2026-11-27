# board CLI

The `rumo` command: the engine on each host that runs `claude`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mloureiro/rumo/main/apps/cli/scripts/install.sh | sh
```

The script picks the newest `cli-v*` release for linux-x64, linux-arm64 or darwin-arm64, checks it against the
release's `SHA256SUMS` and installs it at `$RUMO_INSTALL_DIR/rumo` (default `~/.local/bin/rumo`).
Use `--version x.y.z` to pin a release.

## Update

- `rumo self-update` installs the newest release, after a backup of the config and state files. A local
  migration step runs after the swap. `--check` only reports, `--resume` finishes a migration that stopped, and
  `--rollback` restores the newest backup and holds auto-update until the next manual update.
- `rumo self-update --server <url>` points this machine at another server after checking the token, owner and
  key id there.
- `autoUpdate` in `config.yaml` is `incompatible` (default: update only when the server needs a newer CLI),
  `always` or `never`. A failed automatic update is retried one hour later.

## Shell completion

```sh
rumo completion bash > ~/.local/share/bash-completion/completions/rumo
rumo completion zsh  > "${fpath[1]}/_rumo"
rumo completion fish > ~/.config/fish/completions/board.fish
```

## Build and release

- `pnpm --filter @rumo/cli run build` builds the Node bundle `dist/rumo`.
- `node scripts/compile.ts [--target <t> | --all]` builds the Bun binaries in `dist/release/`.
- `node scripts/smoke.ts <binary>` runs the smoke checks CI runs on each binary.
- `node scripts/release.ts <x.y.z> --notes <text>` sets the version in `package.json`, `src/version.ts` and
  `CHANGELOG.md`, builds the three binaries with `SHA256SUMS`, and prints the commit, tag and push commands.
  It tags and publishes nothing. Pushing the `cli-v<x.y.z>` tag runs the CLI release workflow.
