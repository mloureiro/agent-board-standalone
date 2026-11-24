# Sealing specification, version 1

This document is the byte-level description of how board content is sealed. A second implementation that follows it
and passes the vectors in `test/vectors/` interoperates with this package. The vectors were produced by the board
this repository replaces (reference board 011f7be) and are the authority where this text is unclear.

## 1. Purpose and non-goals

- Every user-authored or machine-reported value that the server stores is sealed by a client before it leaves the
  device. The server holds no key, never opens a value and never receives plaintext. Sealing is always on: there is no
  unsealed mode.
- Every sealed value is bound to its owner, its field and a context naming the row it belongs to, so the server cannot
  move a value to another row, field or owner without making it unreadable.
- Non-goals: hiding the existence, size, timing or relationships of rows; hiding the clear columns of the data model;
  protecting a client that is already compromised; key escrow.

## 2. Encodings

- **base64url**: the alphabet `A-Z a-z 0-9 - _`, no padding. Decoding refuses any other character, refuses a length
  that is 1 modulo 4, and refuses a non-canonical encoding: re-encoding the decoded bytes must give back exactly the
  input text, so the unused trailing bits of the last character are zero. One byte string has one text.
- **hex**: lower-case, two characters per byte.
- **Text**: UTF-8. Decoding a decrypted value uses a fatal decoder: invalid UTF-8 is an error, never replaced.

## 3. Data key

A data key is 32 bytes from a cryptographically secure random source. Its text form is `abk1_` followed by the
base64url of the 32 bytes (the form the CLI reads from `AGENT_BOARD_DATA_KEY`). Decoding refuses a missing prefix, a
non-canonical body and any length other than 32 bytes.

## 4. Key derivation

Four keys come from the data key with HKDF using SHA-256:

- input key material: the 32 data-key bytes;
- salt: the UTF-8 bytes of `agent-board/v1/salt`;
- info: the UTF-8 bytes of `agent-board/v1/<purpose>`.

| Purpose      | Output                         | Use                                                  |
| ------------ | ------------------------------ | ---------------------------------------------------- |
| `enc`        | 256-bit AES-GCM key            | every envelope whose field does not start with `tr.` |
| `transcript` | 256-bit AES-GCM key            | every envelope whose field starts with `tr.`         |
| `index`      | 256-bit HMAC-SHA-256 key       | blind indexes                                        |
| `id`         | 256 raw bits, not a usable key | the key id                                           |

The three usable keys are imported as non-extractable. Implementations keep no copy of the data key after
derivation.

**Key id**: the first 8 bytes of the `id` output written as 16 lower-case hex characters. It identifies a data key
without revealing it.

**The owner name is not a derivation input.** It enters only the additional data of envelopes (section 5). Key ids
and blind indexes therefore depend on the data key alone. Two owners differ in their indexes because each has their
own random data key, not because of their names.

## 5. Envelopes

Text form: `abe1.` followed by the base64url of

```text
nonce (12 bytes) || ciphertext (same length as the plaintext) || tag (16 bytes)
```

- Cipher: AES-256-GCM, 12-byte random nonce, 128-bit tag, a fresh nonce for every sealing.
- Key: the `transcript` key when the field starts with `tr.`, the `enc` key otherwise.
- Additional data: the UTF-8 bytes of the four parts joined by NUL (U+0000), in this order:
  `v1`, owner, field, context. A NUL inside the owner, the field or the context is refused when sealing and opening.
- Plaintext: UTF-8 of the value. The empty string is a valid value.
- Length: an envelope for `n` plaintext bytes is `5 + ceil((n + 28) * 4 / 3)` characters.
- `isEnvelope(text)`: the prefix `abe1.`, a body made only of base64url characters, and a body of at least 38
  characters (the encoding of 28 bytes). It is a shape check: it does not test canonical encoding and does not
  decrypt.
- Opening fails, without saying which part was wrong, when: the text is not an envelope; the body is not canonical
  base64url; the body decodes to fewer than 28 bytes; authentication fails (different key, owner, field or context,
  or any changed byte); or the plaintext is not valid UTF-8.

## 6. Bindings

A binding is a pair `{ field, context }`. A value that does not open under exactly its binding is unreadable, and
an unreadable value is never replaced by a looser reading. The fields:

`title`, `input`, `workdir`, `agent`, `icon`, `labels`, `pr`, `watches`, `machine.dirs`, `machine.catalog`,
`machine.usage`, `machine.feeds`, `agents.shared`, `links`, `titles`, `note.body`, `note.preview`,
`note.suggestion`, `note.questions`, `note.answers`, `tr.data`, `tr.output` (the 22 of the reference board), and
five new ones: `project.name`, `project.icon`, `directory.path`, `directory.repo`, `settings`.

Context formats, one builder each. In the vectors (`bindings.json`) the arguments of a builder are named as below.
A row is `{ kind: 'task', id, createdBy, scheduleId, agent, forkOf }` or `{ kind: 'schedule', id, agent }`; `agent`,
`scheduleId` and `forkOf` are null when absent. The **origin** of a row is `task:<id>` for a task without a schedule,
and `schedule:<id>` for a schedule and for a task that is an occurrence of one (the server copies the schedule's
ciphertext into the occurrence). The **creator** of a task is its `createdBy` (`user`, `agent` or `intake`); a
schedule's creator is `user`.

| Builder             | Arguments                                                                            | Field            | Context                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`             | row                                                                                  | `title`          | origin                                                                                                                                         |
| `input`             | row, optional `directoryId`                                                          | `input`          | `<origin>:<creator>`, then `:fork:<parentId>` for a fork, then `:agent:<name>` with an agent, then `:directory:<directoryId>` with a directory |
| `agent`             | row                                                                                  | `agent`          | origin                                                                                                                                         |
| `icon`              | row                                                                                  | `icon`           | origin                                                                                                                                         |
| `labels`            | row                                                                                  | `labels`         | origin                                                                                                                                         |
| `workdir`           | row                                                                                  | `workdir`        | origin; for an occurrence `task:<id>:schedule:<scheduleId>`                                                                                    |
| `occurrenceWorkdir` | occurrence row                                                                       | `workdir`        | `schedule:<scheduleId>`, the binding of the copied schedule value                                                                              |
| `pr`                | taskId                                                                               | `pr`             | `task:<taskId>:agent`                                                                                                                          |
| `watches`           | taskId                                                                               | `watches`        | `task:<taskId>:agent`                                                                                                                          |
| `machineDocument`   | field (`machine.dirs`, `machine.catalog`, `machine.usage`, `machine.feeds`), machine | that field       | `machine:<machine>`                                                                                                                            |
| `sharedAgents`      | version                                                                              | `agents.shared`  | `agents:v<version>`                                                                                                                            |
| `links`             | version                                                                              | `links`          | `links:v<version>`                                                                                                                             |
| `titles`            | version                                                                              | `titles`         | `titles:v<version>`                                                                                                                            |
| `note`              | field (`note.*`), taskId, author, kind                                               | that field       | `note:<taskId>:<author>:<kind>`                                                                                                                |
| `transcript`        | field (`tr.data`, `tr.output`), taskId, runId, seq                                   | that field       | `<taskId>:<runId>:<seq>` (seq in decimal)                                                                                                      |
| `projectName`       | projectId                                                                            | `project.name`   | `project:<projectId>`                                                                                                                          |
| `projectIcon`       | projectId                                                                            | `project.icon`   | `project:<projectId>`                                                                                                                          |
| `directoryPath`     | directoryId                                                                          | `directory.path` | `directory:<directoryId>`                                                                                                                      |
| `directoryRepo`     | directoryId                                                                          | `directory.repo` | `directory:<directoryId>`                                                                                                                      |
| `settings`          | version                                                                              | `settings`       | `settings:v<version>`                                                                                                                          |

- The agent name sits inside the context of `input` as well as sealed on its own, and the parent of a fork sits there
  before the agent: a server that drops or swaps the agent or the fork parent leaves a prompt that opens under no
  binding, so the task never runs.
- The optional directory segment binds a task's prompt to its directory. Without a directory id the context is
  byte-identical to the one the reference board produces. The vectors mark the directory forms and the five new
  builders with `"new": true`: their contexts come from this specification, not from the reference board.
- Migrated values keep today's bindings: a migrated legacy directory keeps `workdir`, a migrated machine directory
  document keeps `machine.dirs`.

## 7. Blind indexes

`abh1.` followed by the base64url of `HMAC-SHA-256(index key, UTF-8 value)`: always 43 characters after the prefix
(48 in all). No owner, field or context enters the MAC, so equal values under one data key give equal indexes. They
differ between owners because their data keys differ. `isBlindIndex(text)`: the prefix, base64url characters only,
a body of exactly 43 characters. The empty string has an index like any other value.

## 8. Key slots

A **setup** is `{ keyId, slots }`: the key id of the data key and one to four slots, each holding a wrapped copy of
the data key.

- **Wrapped key**: `abw1.` followed by the base64url of `nonce (12) || AES-256-GCM(data key) || tag (16)`, with
  the additional data being the UTF-8 bytes of `v1`, NUL, `wrap-data-key`. 80 base64url characters after the `abw1.` prefix, 85 in all. The wrapping key is
  supplied by the slot.
- **Passphrase slot**: `{ kind: 'passphrase', kdf: 'argon2id', m, t, p, salt, wrapped }`. `salt` is base64url of
  16 to 64 random bytes (22 to 86 characters). The wrapping key is the 32-byte Argon2id output (version 0x13,
  implemented with `hash-wasm`) of the normalised passphrase with that salt, parallelism `p`, iterations `t` and
  memory `m` KiB, used directly as the AES key.
  - Production parameters: `m = 65536`, `t = 3`, `p = 1`, salt of 16 bytes.
  - Accepted bounds when reading a slot: `m` 8192 to 262144, `t` 1 to 10, `p` 1 to 4. A slot outside them is
    refused without computing anything, so a hostile value cannot make a client allocate gigabytes.
- **Recovery slot**: `{ kind: 'recovery', wrapped }`. The wrapping key is the 32 recovery-key bytes themselves; there
  is no key derivation.
- **Passphrase normalisation**: remove leading and trailing whitespace, then apply Unicode NFKC. The minimum length
  is 14 code points of the normalised text. Everything that reaches the hash goes through this one function.
- **Slot set**: 1 to 4 slots, at most one of each kind, and a passphrase slot always present. In practice a setup
  has one passphrase slot and one recovery slot, in that order. A reader refuses a set without a passphrase slot before opening anything.
- **Unlock**: open the slot of the kind the secret names, derive the keys from the data key, and require the derived
  key id to equal the stored `keyId`; otherwise fail with a "does not match" error. Any failure to open a slot is one
  wrong-secret error that does not say which part was wrong.
- **Passphrase replacement**: unlock with any secret, wrap the same data key under the new passphrase with a new salt
  and nonce, and keep every other slot unchanged. The data key and the key id do not change, so nothing already
  sealed needs re-sealing.
- Every routine that holds data-key, wrapping-key or recovery-key bytes zeroes its own copies when it finishes.

## 9. Recovery key text

The recovery key is 32 random bytes. Text form:

- Alphabet: Crockford base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
- Key characters: the 256 bits are written five at a time, most significant bit first, giving 52 characters; the
  last character carries 1 bit of key and 4 padding bits, which are zero.
- Checksum: 4 characters, being the first 20 bits (3 bytes, read the same way, the last 4 bits dropped) of
  SHA-256 over the UTF-8 bytes of `agent-board/v1/recovery-key-check` followed by the 32 key bytes.
- The 56 characters are written in 14 groups of 4 joined by `-`.
- Parsing is lenient on form and strict on content: convert to upper case, delete whitespace and `-`, read `O` as `0`
  and `I` and `L` as `1`. Then the text must be exactly 56 characters, all in the alphabet; the 4 padding bits must
  be zero; the checksum must match. Any failure is one error that does not say which check failed.

## 10. Token hash

A bearer token is stored only as its hash: the **lower-case hex SHA-256 of the UTF-8 bytes of the whole token, prefix
included** (64 characters). Tokens are a prefix (`abs_` session, `abm_` machine, `abc_` client) followed by the
base64url of 32 random bytes. The reference board hashes `abs_` and `abm_` tokens with the same expression in two
places; the scheme was confirmed to equal a plain `sha256sum` of the token text, with no salt, no key and no prefix
stripping.

## 11. Request signatures

New in this repository; the vectors for it come from an independent implementation, not from the reference board.

- Key type: ECDSA on P-256 with SHA-256. The private key is non-extractable.
- Public key text: SPKI DER, base64url.
- Key id (sent as `x-board-key`): base64url SHA-256 of the SPKI DER, 43 characters, computed by both sides. A text that does not import as a P-256 SPKI key has no key id and is refused.
- Signature: IEEE P1363 `r || s`, 64 bytes, base64url.
- `Content-Digest`: `sha-256=:<standard base64 with padding of SHA-256 of the body>:` (RFC 9530).
- Timestamp: decimal Unix seconds. Nonce: 16 random bytes, base64url (22 characters).
- Canonical string: five values joined by a newline (U+000A), encoded as UTF-8, with the empty string where there is
  no digest. The values and their order are defined by the contract package.

## 12. Vectors

`test/vectors/` holds eight files. Seven come from the reference board and begin with `"source": "reference board 011f7be"`
and `"generatedBy": "scripts/generate-vectors.mts"`. `signatures.json` comes from the independent implementation of
section 11, begins with its own `note` and `generatedBy`, and is not reproducible byte for byte because ECDSA
signatures are randomised. Its private JWKs are synthetic test keys.

| File                 | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys.json`          | the two synthetic owners (`vector-owner`, `vector-owner-2`): data key, `abk1_` text, key id                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `envelopes.json`     | `cases`: owner, field, context, plaintext and envelope, for ASCII, emoji and combining marks, the empty string, a 10 KiB text, directory, machine, note and transcript values, for both owners. `refusals`: an envelope an implementation must refuse, with the reason; `openAsOwner`, when present, is the owner name used in the additional data while the data key is the one of `owner`                                                                                                                   |
| `blind-indexes.json` | five values (empty, URL, 40-hex sha, unicode, 1 KiB text) indexed under each owner                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `bindings.json`      | builder, arguments, field and context for every builder in section 6                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `slots.json`         | `setups`: a key setup under production parameters and one under the minimum (`m = 8192`, `t = 1`, `p = 1`), with the passphrase, data key, key id, recovery key text and bytes. `variants`: typed passphrases and whether each unlocks every setup (surrounding whitespace and a full-width form that NFKC maps to the same text open; a different capitalisation does not). `replaced`: the second setup after a passphrase replacement, showing the same data key and key id and an unchanged recovery slot |
| `recovery-keys.json` | `cases`: bytes and text, including all-zero and all-0xFF; `typed`: lenient inputs and the bytes they read as; `refusals`: inputs that must be refused, by reason (`checksum`, `length`, `alphabet`, `spare-bits`)                                                                                                                                                                                                                                                                                             |
| `token-hashes.json`  | one token per prefix and its hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

All random values (data keys, nonces, salts, recovery keys, tokens) come from a fixed stream: the SHA-256 of the
ASCII text `agent-board-vectors` followed by a 32-bit big-endian counter starting at 0, concatenated for counter 0, 1,
2, and so on, consumed byte by byte in call order. The owners and passphrase are synthetic. Because every
random draw is fixed, a sealing run that reuses a recorded nonce must reproduce the recorded envelope byte for byte,
and every recorded envelope must open.

### Regeneration

The generator takes the extracted reference tree and the output directory; no path is built in. Running it twice
leaves identical files (`git status` stays clean).

```bash
mkdir -p <scratch>/ref
git --git-dir=<reference checkout>/.git archive 011f7be packages/shared apps/backend/src | tar -x -C <scratch>/ref
mkdir -p <scratch>/ref/packages/shared/node_modules
ln -s <reference checkout>/packages/shared/node_modules/hash-wasm <scratch>/ref/packages/shared/node_modules/hash-wasm
ln -s <reference checkout>/apps/backend/node_modules <scratch>/ref/apps/backend/node_modules
<reference checkout>/apps/backend/node_modules/.bin/tsx packages/sealing/scripts/generate-vectors.mts <scratch>/ref packages/sealing/test/vectors
```

The reference checkout is only read. The generator checks each refusal against the reference implementation and
stops if one is accepted.
