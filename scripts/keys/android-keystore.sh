#!/bin/sh
set -eu

repo="mloureiro/agent-board-standalone"
alias_name="agent-board"
folder="${1:-$HOME/agent-board-keys}"
keystore="${folder}/agent-board-release.jks"

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool is missing: install a JDK (for example \`brew install openjdk\`) and run this again" >&2
  exit 1
fi

if [ -e "${keystore}" ]; then
  echo "${keystore} already exists: it is never overwritten" >&2
  exit 1
fi

mkdir -p "${folder}"
chmod 700 "${folder}"

echo "keytool asks for the keystore password now; the same password signs the key."
keytool -genkeypair \
  -keystore "${keystore}" \
  -storetype PKCS12 \
  -alias "${alias_name}" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=Agent Board"
chmod 600 "${keystore}"

cat <<EOF

Keystore written to ${keystore} (alias ${alias_name}).

Give it to the mobile release workflow with these two commands (the second asks for the password):

  base64 -i "${keystore}" | gh secret set MOBILE_KEYSTORE_B64 --repo ${repo}
  gh secret set MOBILE_KEYSTORE_PASSWORD --repo ${repo}

Back up the keystore and its password somewhere safe outside this Mac.
Losing either means the Android app can no longer be updated in place: every phone has to uninstall it first.
EOF
