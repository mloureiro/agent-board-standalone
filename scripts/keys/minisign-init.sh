#!/bin/sh
set -eu

repo="$(cd "$(dirname "$0")/../.." && pwd)"
public_key="$repo/apps/cli/update-key.pub"
secret_key="${MINISIGN_SECRET_KEY:-$HOME/.minisign/minisign.key}"

if ! command -v minisign >/dev/null 2>&1; then
  echo "minisign is not installed (brew install minisign)" >&2
  exit 1
fi
if [ -e "$public_key" ]; then
  echo "$public_key already exists; refusing to overwrite the key the CLI trusts" >&2
  exit 1
fi

mkdir -p "$(dirname "$secret_key")"
minisign -G -p "$public_key" -s "$secret_key"

cat <<EOF

Created the CLI update signing key.

  public key: $public_key
  secret key: $secret_key

Keep the secret key and its password off GitHub. Back both up somewhere safe:
a lost key means a new key and a CLI release built with it.

Commit apps/cli/update-key.pub and merge it BEFORE building the CLI release you
want to trust it. A CLI built earlier has no key built in and checks checksums only.
Sign each release with: pnpm --filter @agent-board/cli release:sign <cli-vX.Y.Z>
EOF
