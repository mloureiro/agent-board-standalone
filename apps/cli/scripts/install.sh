#!/bin/sh
set -eu

REPOSITORY="mloureiro/rumo"
RELEASES_URL="${RUMO_RELEASES_URL:-https://api.github.com/repos/${REPOSITORY}/releases?per_page=30}"
DOWNLOAD_URL="${RUMO_DOWNLOAD_URL:-https://github.com/${REPOSITORY}/releases/download}"
INSTALL_DIR="${RUMO_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${RUMO_VERSION:-}"

usage() {
  cat <<'TEXT'
Install the rumo CLI from the newest cli-v* release of this repository.

  sh install.sh [--version x.y.z] [--dir <directory>]

Environment: RUMO_INSTALL_DIR (default ~/.local/bin), RUMO_VERSION.
TEXT
}

fail() {
  echo "install: $1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) TARGET="linux-x64" ;;
  Linux-aarch64|Linux-arm64) TARGET="linux-arm64" ;;
  Darwin-arm64) TARGET="darwin-arm64" ;;
  *) fail "no release build for $(uname -s) $(uname -m); builds exist for linux-x64, linux-arm64 and darwin-arm64" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

if [ -z "$VERSION" ]; then
  LIST="$(curl -fsSL "$RELEASES_URL")" || fail "could not read the release list at $RELEASES_URL"
  VERSION="$(printf '%s\n' "$LIST" \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' \
    | sed 's/.*cli-v//; s/"$//' \
    | sort -t . -k 1,1n -k 2,2n -k 3,3n \
    | tail -n 1)"
  [ -n "$VERSION" ] || fail "this repository has no cli-v* release yet"
fi
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "\"$VERSION\" is not an x.y.z version"

TAG="cli-v${VERSION}"
ASSET="rumo-${TARGET}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

curl -fsSL -o "$WORK/SHA256SUMS" "$DOWNLOAD_URL/$TAG/SHA256SUMS" || fail "could not download SHA256SUMS of $TAG"
curl -fsSL -o "$WORK/$ASSET" "$DOWNLOAD_URL/$TAG/$ASSET" || fail "could not download $ASSET of $TAG"

EXPECTED="$(awk -v name="$ASSET" '$2 == name || $2 == "*" name { print $1 }' "$WORK/SHA256SUMS" | head -n 1)"
[ -n "$EXPECTED" ] || fail "SHA256SUMS of $TAG has no checksum for $ASSET"
ACTUAL="$(sha256 "$WORK/$ASSET")"
[ "$EXPECTED" = "$ACTUAL" ] || fail "the checksum of $ASSET does not match (expected $EXPECTED, got $ACTUAL); nothing was installed"

chmod 755 "$WORK/$ASSET"
"$WORK/$ASSET" --version >/dev/null 2>&1 || fail "the downloaded rumo does not run on this machine; nothing was installed"

mkdir -p "$INSTALL_DIR"
mv -f "$WORK/$ASSET" "$INSTALL_DIR/rumo.new"
mv -f "$INSTALL_DIR/rumo.new" "$INSTALL_DIR/rumo"
echo "installed rumo $VERSION ($TARGET) at $INSTALL_DIR/rumo"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "add $INSTALL_DIR to your PATH to run \`rumo\`" ;;
esac
