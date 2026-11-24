# Changelog

## 1.0.0

First release. Sealed envelopes, blind indexes, bindings and the data key with its derived keys; passphrase
(Argon2id) and recovery-key slots with passphrase replacement; recovery key text with checksum; ECDSA P-256 request
signing primitives (key generation, SPKI export and import, key id, P1363 signatures, `Content-Digest`). Runs on
WebCrypto in Node 24, Bun and browsers (Chromium and WebKit), checked against the byte-level vectors in each.
