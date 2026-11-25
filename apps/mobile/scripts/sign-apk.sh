#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${here}/dist-apk"
mkdir -p "${out}"

unsigned="$(find "${here}/src-tauri/gen/android/app/build/outputs/apk" -name '*-unsigned.apk' | head -n 1)"
if [ -z "${unsigned}" ]; then
  echo "no unsigned APK was built" >&2
  exit 1
fi

tools="${ANDROID_HOME}/build-tools/${BUILD_TOOLS_VERSION}"
keystore="$(mktemp -d)/signing.jks"

if [ -n "${KEYSTORE_B64:-}" ]; then
  printf '%s' "${KEYSTORE_B64}" | base64 --decode > "${keystore}"
  password="${KEYSTORE_PASSWORD}"
  alias_name="agent-board"
else
  password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  alias_name="ci-throwaway"
  keytool -genkeypair -keystore "${keystore}" -alias "${alias_name}" -keyalg EC -groupname secp256r1 \
    -validity 3650 -dname "CN=agent-board ci build" -storepass "${password}" -keypass "${password}"
  echo "signed with a throwaway key: updates over an installed build need the same key" >&2
fi

"${tools}/zipalign" -f -p 4 "${unsigned}" "${out}/aligned.apk"
"${tools}/apksigner" sign --ks "${keystore}" --ks-key-alias "${alias_name}" \
  --ks-pass "pass:${password}" --out "${out}/agent-board-mobile.apk" "${out}/aligned.apk"
"${tools}/apksigner" verify --print-certs "${out}/agent-board-mobile.apk"
rm -f "${out}/aligned.apk" "${out}/aligned.apk.idsig"
