# Changelog

## 1.0.1

Unwrapping refuses a slot set without a passphrase slot. `signingKeyId` refuses text that is not a P-256 public key. SPEC
wording for the wrapped-key length and the vector files.

## 1.0.0

First release. Sealed envelopes, blind indexes, bindings and the data key with its derived keys; passphrase
(Argon2id) and recovery-key slots with passphrase replacement; recovery key text with checksum; ECDSA P-256 request
signing primitives (key generation, SPKI export and import, key id, P1363 signatures, `Content-Digest`). Runs on
WebCrypto in Node 24, Bun and browsers (Chromium and WebKit), checked against the byte-level vectors in each.
