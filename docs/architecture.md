# Architecture

How the parts of this repository fit together. The requirements live in [`requirements/`](../requirements/README.md);
each catalogue row id (`api-025`, `web-085`, …) named here is a requirement this design satisfies. Decisions with
alternatives are recorded as ADRs in [`docs/adr/`](adr/).

## 1. Parts and the dependency rule

| Part           | Path                | Runs as                                                  | Code dependencies                                                                 |
| -------------- | ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| contract       | `packages/contract` | Library: wire schemas, routes, versions, shared tables   | nothing in the repository                                                         |
| sealing        | `packages/sealing`  | Library: envelopes, blind indexes, keys, request signing | nothing in the repository                                                         |
| API            | `apps/api`          | Node service, also one executable                        | contract, sealing (envelope shape, signature verify)                              |
| CLI            | `apps/cli`          | Node program, also one Bun-compiled binary               | contract, sealing                                                                 |
| Browser client | `apps/web`          | Static single-page app                                   | contract, sealing                                                                 |
| Server app     | `apps/server-app`   | Tauri 2 tray app (macOS)                                 | wraps the API                                                                     |
| Client app     | `apps/client-app`   | Tauri 2 desktop app (macOS)                              | wraps the browser client                                                          |
| Mobile         | `apps/mobile`       | Tauri 2 Android app                                      | wraps the browser client                                                          |
| Migration tool | `apps/migrate`      | Node program                                             | contract (export format), sealing (envelope shape check)                          |
| E2E suite      | `e2e`               | Test harness                                             | contract, sealing (unlock fixtures, sealing-at-rest checks); runs the built parts |

Rules ([ADR-0001](adr/0001-dependency-rule-and-versioning.md)):

- **Code dependencies.** API, CLI and browser client import no code from each other. They share only `contract` and
  `sealing`. A lint rule fails on any other import across parts (repo-001).
- **Data dependencies are allowed.** A part may read a data file another part publishes. The contract publishes
  JSON case tables (address cases, handover cases, the client app's bundle id) that the Tauri wrappers read as
  vectors in `cargo test` (contract-007, contract-012).
- **Workspace links carry a range.** A consumer declares `"@agent-board/contract": "workspace:^<major>.<minor>.0"`.
  An install fails when the local package no longer satisfies the range, so a breaking change of a shared package
  is visible in the consumer's own diff.
- **Release bundles compose artifacts.** A release bundle may carry the pinned release artifact of another part. The
  server app ships the API executable, the CLI binary and the browser client's static build (server-app-088). The
  client app and Android ship the browser client's build.
- **Each part installs and runs alone** (repo-002). The CLI needs no app; the client app needs no CLI; the API
  needs no server app.

### Versions, tags and the compatibility matrix

- Each part has one semver version in its `package.json` and a `CHANGELOG.md` (repo-005).
- A release is a git tag `<part>-v<semver>`: `contract-v1.0.0`, `sealing-v1.0.0`, `api-v1.0.0`, `cli-v1.0.0`,
  `web-v1.0.0`, `server-app-v1.0.0`, `client-app-v1.0.0`, `mobile-v1.0.0`, `migrate-v1.0.0` (repo-008).
- **N-1 of a part** is its newest release tag whose version is lower than the version at `HEAD`.
- The matrix job (repo-003) builds the N-1 artifacts of API, CLI and browser client from their tags and runs the
  `@matrix` subset of the E2E suite in four cells: API N with CLI N-1, API N with web N-1, API N-1 with CLI N,
  API N-1 with web N.
- An E2E test declares the contract features it needs. When the older peer lacks one, the test is skipped with
  the feature named, never failed.
- **A `CONTRACT` bump.** When `HEAD` raises `CONTRACT` and its `MIN_CLIENT` or `MIN_SERVER` no longer admits the
  N-1 peer, that cell runs one test instead of the suite: it asserts the refusal (412 or the CLI's "too old"
  message naming both versions). When the minimums still admit the peer, the cell runs normally.
- **First release.** A part with no release tag has no N-1. Its cells report "no N-1 for <part>" and pass.

## 2. Contract

([ADR-0002](adr/0002-contract-style-and-handshake.md))

### Style

- **Schemas** are zod 4 objects in `packages/contract`. Every request, response, event and error is declared
  once.
- **Routes** are plain HTTP with JSON bodies. Each route entry declares method, path, auth kind
  (`public`, `client`, `machine`), request schema, response schema and the errors it can return (contract-003).
  - Machine commands: `POST /api/machine/<command>`, bearer `abm_` token, checked before the body (api-084).
  - Client reads: `GET /api/client/<name>` with a query schema. Client writes: `POST /api/client/<name>` with a
    JSON body; a write without `Content-Type: application/json` gets 415 (api-011).
  - Public: `GET /api/version`, `/api/auth/*`, `POST /api/pair`, `GET /healthz`.
  - Streams: `GET /api/client/events`, `GET /api/machine/events`.
- **OpenAPI** is generated from the route table with `z.toJSONSchema`, written to
  `packages/contract/dist/openapi.json` and attached to every `contract-v*` release (contract-004).
- **Events** are Server-Sent Events. Every client reads them from a streamed `fetch` with its own parser, never
  `EventSource`, because `EventSource` cannot send headers and cannot pass through the wrappers' native bridge.
- **Shared tables** live in the contract as data: the address rule (contract-007), the header table for every
  answer and every static file (contract-015, web-079), cookie names and token prefixes (contract-008), the
  handover message (contract-012), the worker unit recipe (contract-010), doctor check ids (contract-011), the
  board export format (contract-013) and the request-signature canonical string (contract-014).
- **JSON case tables.** The address cases, the handover cases and the client app's bundle id are also written to
  `packages/contract/dist/cases/*.json` at build. TypeScript tests and the wrappers' `cargo test` both run them.

### Token prefixes and cookie names

| Credential                    | Prefix | Carried in                                                             | Stored by the server as                   |
| ----------------------------- | ------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| Browser session (same origin) | `abs_` | HttpOnly cookie `__Host-board-session` (https), `board-session` (http) | Lower-case hex SHA-256 of the whole token |
| Client token (cross-origin)   | `abc_` | `Authorization: Bearer abc_…`                                          | Lower-case hex SHA-256 of the whole token |
| Machine token                 | `abm_` | `Authorization: Bearer abm_…`                                          | Lower-case hex SHA-256 of the whole token |

Migrated machine tokens must stay valid (migrate-004). The stored hash equals the one today's boards store, and the
vector in `packages/sealing/test/vectors/token-hashes.json` pins it.

### Version and feature handshake

- The contract declares `CONTRACT` (an integer break level), `MIN_CLIENT` per client kind (`cli`, `web`),
  `MIN_SERVER`, and `FEATURES`, a list of named constants. An additive change adds a feature and bumps nothing
  (contract-001, contract-005).
- `compat(local, remote, needed?)` is one pure function used by API, CLI and browser client. It returns
  `compatible`, `client-too-old`, `client-too-new`, or `missing-features` with the names the server lacks, and a
  message naming both versions (contract-002).
- Every client request carries `x-board-contract: <n>` and `x-board-client: <kind>/<version>`. A client below
  `MIN_CLIENT` gets 412 `upgrade-required` with an upgrade hint before any read or write (api-098).
- A request to a client or machine route **without** `x-board-contract` gets the same 412, with the message "this
  client did not send its contract version". Public routes, `/healthz` and static files need no header.
- **`GET /api/version`** is public and answers `Access-Control-Allow-Origin: *` without credentials:

  ```json
  {
    "contract": 1,
    "minClient": { "cli": 1, "web": 1 },
    "features": ["…"],
    "server": { "version": "1.0.0", "commit": "abc1234" },
    "modules": {
      "signIn": ["passkeys", "handoff"],
      "requestSignature": false,
      "scheduling": true,
      "feeds": true
    },
    "session": "none"
  }
  ```

  `session` is `not-required` in no-login mode. Otherwise it is `none`, `valid` or `expired`, read from whatever
  credential came with the request (api-115).

- The machine handshake is the `version` machine command (api-096). It also returns owner, key id, document
  indexes, the newest known CLI and `legacyDirs` (true while a migrated directory document awaits conversion).

### Connection check (web-091, web-092)

| Aspect   | Rule                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request  | One `GET /api/version`, credentials attached as for any request to that server, redirects not followed                                                |
| Timeouts | 5 s to connect, 10 s total                                                                                                                            |
| Up       | Status below 500, `compat` says compatible, `session` is `valid` or `not-required`, and pairing is not needed                                         |
| Not up   | `unreachable`, `timeout`, `server-error` (≥ 500), `too-old`, `too-new`, `signed-out` (`none`/`expired`), `needs-pairing`                              |
| Pairing  | `needs-pairing` when `modules.requestSignature` is true and this client holds no key bound for that server, or when any request got 401 `key-unknown` |
| Retry    | A transient failure (unreachable, timeout, 502/503/504) retries twice at 1 s and 3 s before reporting                                                 |

## 3. API

TypeScript on Node 24, Fastify 5, Drizzle, zod. One process serves the client routes, the machine API, both
event streams and, when configured, the browser client's static files. It uses `sealing` only to shape-check
envelopes and to verify request signatures; it never opens content.

### Module registry

([ADR-0003](adr/0003-api-module-registry.md))

Every concern is a module with a zod schema for its environment variables. At start the registry parses each
module, then runs one cross-module validation pass; an invalid combination refuses the start with a message
naming the variables involved (api-021).

| Module            | Variables                                                                                                        | Default                   | Rows                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- |
| database          | `DATABASE_URL` (`postgres://…` or `pglite://<dir>`), `DATABASE_ADMIN_URL`                                        | required                  | api-001, 002, 015–018 |
| sign-in           | `AUTH_MODE` (`login`, `no-login`), `NO_LOGIN_USER`, `PUBLIC_URL`, `PASSKEYS`, `OIDC_*`, `SAML_*`, `SIGNUP_TOKEN` | required                  | api-005–007, 025–042  |
| listen            | `HOST`, `PORT`, `ALLOWED_HOSTS`, `TRUST_PROXY` (`on`, `off`)                                                     | loopback in no-login      | api-013, 014, 121     |
| cross-origin      | `ALLOWED_ORIGINS`                                                                                                | empty (same origin only)  | api-113, 114          |
| request signature | `REQUEST_SIGNATURE` (`on`, `off`)                                                                                | `off`                     | api-022, 120, 122     |
| events            | `EVENTS_DRIVER` (`memory`, `postgres`)                                                                           | `memory`                  | api-024, 094, 095     |
| scheduling        | `SCHEDULING` (`on`, `off`)                                                                                       | `on`                      | api-023, 075–080      |
| feeds             | `FEEDS` (`on`, `off`)                                                                                            | `on`                      | api-023, 092          |
| web               | `WEB_ROOT` (a directory holding the browser client's build)                                                      | unset: no static files    | api-108–110           |
| control           | `CONTROL_SOCKET` (a Unix socket path)                                                                            | unset: no control channel | api-111, 120          |
| access log        | `ACCESS_LOG` (a file path)                                                                                       | unset                     | api-112               |
| tls (conditional) | `TLS_CERT`, `TLS_KEY`, or `TLS_SELF_SIGNED_DIR`                                                                  | unset                     | api-124               |

Cross-module rules:

- `EVENTS_DRIVER=postgres` needs a `postgres://` database.
- No-login refuses any login-only variable (api-005).
- No-login with a non-loopback `HOST`, or with any non-loopback name in `ALLOWED_HOSTS`, needs
  `REQUEST_SIGNATURE=on` (api-121). A tunnel or reverse proxy that forwards to loopback is a non-loopback host
  name and falls under this rule.
- With scheduling off, schedule routes answer the contract error `not-enabled` and task transitions create no
  occurrences. With feeds off, feed routes answer `not-enabled` (api-023).

**Always on:** sealing checks (the database refuses non-envelopes, api-003, api-049) and tenancy (row-level
security, api-043–048). No variable can switch them off.

### Database, tenancy and PGlite

- One Drizzle schema and one migration history for both drivers.
- Every tenant table carries `owner` and has a row-level policy. Cross-row foreign keys include `owner`
  (api-045). Lookups before the owner is known go through narrow `SECURITY DEFINER` functions (api-046).
- **Postgres.** The admin URL creates or resets the application role and runs migrations; requests use the
  application URL. The start is refused when the application role is unsafe (api-002).
- **PGlite.** The session is a superuser underneath, so every request transaction begins with
  `SET LOCAL ROLE board_app` and sets the owner setting. A process-wide mutex serialises transactions on the one
  connection. Event streams never hold a transaction. No request path can issue raw SQL or a role reset
  (api-016). A test runs concurrent claims from several machines (api-093). A PGlite folder is opened by one
  process at a time.

### Sessions per client kind

([ADR-0004](adr/0004-wrapper-sessions-native-bridge.md))

| Client                             | Page origin                                   | Credential                                                                               | Transport                |
| ---------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| Browser, same origin as the server | The server's own origin                       | `abs_` HttpOnly cookie                                                                   | `fetch`, same origin     |
| Browser, another server            | Another server's origin                       | `abc_` client token from the hand-off, kept in that server's IndexedDB namespace         | `fetch` with CORS        |
| Client app, Android                | `tauri://localhost`, `http://tauri.localhost` | `abc_` client token held by Rust in the Keychain or Android Keystore; never in page code | Native bridge            |
| CLI                                | none                                          | `abm_` machine token                                                                     | `fetch` from Node or Bun |

- A client token is a session row of kind `client`. It expires and slides exactly like a cookie session
  (api-027) and is deleted by logout.
- `Authorization` is accepted for `abc_` and `abm_` tokens only. A cookie session is read only from its cookie
  (api-026).
- CORS: a request whose `Origin` is in `ALLOWED_ORIGINS` gets `Access-Control-Allow-Origin: <origin>`,
  `Access-Control-Allow-Headers` for the contract, signature and authorization headers, and no
  `Allow-Credentials`. Cookies never cross origins.
- Writes from a browser must come from the server's own origin or an allowed origin, and
  `Sec-Fetch-Site: cross-site` is refused unless the origin is allowed (api-107). A request without `Origin`
  (CLI, native bridge) is not a browser request and passes this check.

### Sign-in per client

| Client                | Methods                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser, same origin  | Every method the server offers on the client's own sign-in page, plus "Sign in with your browser"                                                                                   |
| Browser, other server | "Sign in with your browser" (hand-off) only; the approval page opens on that server's own origin                                                                                    |
| Client app, Android   | Hand-off only. Each method button opens the server's approval page in the system browser, where the user signs in by that method and approves (web-103, client-app-033, mobile-003) |
| CLI                   | Machine token from Settings › Machines or the server app's enrolment                                                                                                                |

The hand-off (api-039): a public start returns an `XXXX-XXXX` code and a flow id. A signed-in browser approves
it. The public finish, called with the verifier, returns either a cookie (same origin) or an `abc_` client token
in the body when the request asks for `tokenKind: "client"` (api-114). When the server has the request signature
on, the finish carries the client's public key and binds it to the new session. In the wrappers, Rust calls the
finish itself, so the token never reaches page code (client-app-037).

The public sign-in routes are rate limited per process and per client address: the counters live in memory, so
several API processes each count on their own. The address is the socket's, which behind a reverse proxy is the
proxy's. With `TRUST_PROXY=on` the address comes from `X-Forwarded-For` instead, so turn it on only when a
proxy that overwrites that header is the sole way in.

### Request signature

([ADR-0012](adr/0012-request-signature.md))

When `REQUEST_SIGNATURE=on`, every client and machine request is signed by a key the server knows:

- **Key.** ECDSA P-256. A browser keeps it as a non-extractable WebCrypto key in the server's IndexedDB
  namespace. The wrappers keep it in the Keychain or Android Keystore and sign in Rust. The CLI keeps it with its
  credentials.
- **Headers.** `x-board-key` (key id), `x-board-ts` (Unix seconds), `x-board-nonce` (128 random bits, base64url),
  `x-board-sig`, and `Content-Digest: sha-256=:…:` when there is a body.
- **Canonical string** (contract-014): method, path with query, timestamp, nonce and the content digest (or
  empty), joined by `\n`, UTF-8. Signing and verifying are `sealing` primitives.
- **Checks.** The signature over the headers is checked before the body is read; an unsigned or badly signed
  request gets 401, and a key the server does not know gets 401 `key-unknown` (api-022). The digest is checked
  after the body is read. The timestamp must be within 120 s and the nonce unused within that window (api-122).
- **Binding** (api-120):
  - Login mode: the sign-in finish (any method, hand-off included) carries the public key; the key is bound to the
    new session.
  - Machine: the first `register-key` command after a token is issued binds one key to that token; re-issuing the
    token clears it.
  - No-login: `POST /api/pair` with a one-time code, the public key and a label. The code is `XXXX-XXXX`, valid
    10 minutes and single use. It is created over the control channel: the server app's "Pair a device…", or
    `agent-board-api pair`, which is a client of `CONTROL_SOCKET` and never opens the database.
- Settings › Devices lists the bound keys and revokes them (web-104).

### Static files: the API serves the browser client

([ADR-0006](adr/0006-api-serves-browser-client.md))

With `WEB_ROOT` set, the API serves the browser client's build: GET and HEAD only, `/assets/` immutable, the rest
`no-cache`, non-asset misses fall back to `index.html`, traversal, NUL and backslash give 400, symlinks out of the
root are not followed, byte ranges as today (api-108, api-109). Every answer, API or static, carries the header
table from the contract (api-110, web-079). There is no separate front process.

The CSP for the browser client is the table's, with one widening:
`connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*`, because one browser client talks
to several servers (web-079, web-085). The wrappers set their own, narrower Tauri CSP: `connect-src` allows only
the IPC origin, because all server traffic goes through the bridge.

### Control channel

With `CONTROL_SOCKET` set, the API listens on a Unix socket (mode 600) for local administration by its wrapper:
`hold` (finish in-flight requests, close the database, answer 503 with the data headers on every route except
`/healthz`), `resume`, `pair-code`, and `status` (api-111). The server app uses `hold` and `resume` around a
backup (server-app-035) and `pair-code` for "Pair a device…".

### Events

- Driver `memory`: an in-process emitter. Driver `postgres`: `LISTEN/NOTIFY` on one channel per owner, for
  several replicas (api-024).
- The client stream sends an empty `changed` event after any committed write of that owner and pings every 25 s.
  With `?project=<id>` it sends `changed` only for commits that touched that project or owner-wide data (api-104).
- The machine stream sends an empty `tasks` event, debounced 500 ms, after dispatch-relevant commits (api-094).
- `GET /api/client/attention` returns the owner's Needs-me task ids with project id and the time they entered
  Needs me. It holds no content (api-118). The Android service and the client app's fallback notifications use
  it.

### Machine acting as its owner

([ADR-0009](adr/0009-machine-acts-as-owner-grant.md))

- A machine row has `acts_as_owner`, false by default. Only a user session sets it, in Settings › Machines
  (web-105).
- User-authored machine commands: `answer`, `dismiss-question`, `reply`, `send`, `stop`, `take-back`, `rerun`,
  `set-closed`, `fork`, `list-runs`, `transcript-events`, `transcript-output`.
- Without the grant they answer 403 `grant-required`. While the calling machine holds the active run of the
  target task they answer 409 `run-holds-task`. Notes they write are authored by the user with
  `via_machine_id` set (api-119).

### Projects data model

([ADR-0010](adr/0010-projects-data-model.md))

| Table         | Columns (besides `owner`)                                                                                                                 | Constraints                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `project`     | `id` uuid, `name` sealed or null, `icon` sealed or null, `position` integer, `is_default` bool, `archived_at`, `created_at`, `updated_at` | unique (`owner`, `id`); one `is_default` per owner                                               |
| `directory`   | `id` uuid, `machine_id`, `project_id`, `path` sealed, `repo` sealed or null, `created_at`                                                 | unique (`owner`, `id`, `project_id`); FK (`owner`, `machine_id`); FK (`owner`, `project_id`)     |
| `task`        | adds `project_id` not null, `directory_id` null, `legacy_directory` sealed or null                                                        | FK (`owner`, `project_id`); FK (`owner`, `directory_id`, `project_id`) → `directory`, deferrable |
| `schedule`    | adds `project_id` not null, `directory_id` null, `legacy_directory` sealed or null                                                        | same two foreign keys                                                                            |
| `legacy_dirs` | `machine_id`, `document` sealed                                                                                                           | one row per (`owner`, `machine_id`); exists only for migrated boards                             |

- The composite foreign key makes "a task's directory belongs to the task's project" a database fact (api-103,
  api-116).
- **Moving a directory** to another project is refused with 409 `directory-in-use` while a task or schedule uses
  it, unless the request says `withUsers: true`. Then the directory and every task and schedule using it move
  together in one transaction (the foreign key is checked at commit). A running task refuses the move (api-071).
- The default project is created with the user row and by migration. Its `name` is null, because only a client
  can seal; clients show "Default" until the user renames it (api-117, web-106). It cannot be deleted or archived.
- Occurrences copy their schedule's project; a fork copies its parent's (api-103).
- **Deleting a project** that still has tasks, schedules or directories is refused with 409 unless the request
  names what happens to them (api-105): `then: "move-to-default"` moves them all to the default project;
  `then: "delete"` deletes the tasks (with notes and transcripts), the schedules and the directories. A running
  task refuses either. An archived project takes no new tasks and is hidden from the switcher.
- The CLI's `set-dirs` writes `directory` rows instead of a sealed directory document (cli-038).
- Per-user settings that used to live in browser storage are one sealed settings document per owner with
  compare-and-set versioning, like title rules (api-101, web-073, web-074).

### Legacy directories from migrated boards

Today a machine's directories live in a sealed per-machine `dirs` document, and a task carries its directory
sealed. The migration tool holds no key, so it cannot create `directory` rows (api-125, cli-085):

1. The import stores each machine's `dirs` document in `legacy_dirs` and each task's and schedule's sealed
   directory in `legacy_directory`, as stored. `directory_id` stays null.
2. The machine's `version` answer reports `legacyDirs: true` while its document exists.
3. On `board init`, at listener start and before any `set-dirs`, a CLI that sees the flag runs the conversion: it
   reads the document (`get-legacy-dirs`), opens it with the data key, opens the `legacy_directory` of its own
   machine's tasks and schedules and of unassigned ones, and sends `convert-legacy-dirs` with the new directory
   rows (sealed paths, default project) and the (task or schedule, directory) pairs whose paths match.
4. The server applies it in one transaction: inserts the rows, sets `directory_id`, clears matched
   `legacy_directory` values and deletes the machine's `legacy_dirs` row. A repeat call is a no-op.
5. A task whose legacy path matched nothing keeps `legacy_directory` and shows no directory until the user sets
   one.

### Account export and board import

- `BoardExport` (contract-013) is a versioned JSON Lines format: a header with format version and source, then
  one record per row, grouped by owner and table. Sealed values are carried as stored.
- Account export and import (api-099, api-100) use it for one owner.
- `agent-board-api import --file <path>` imports a whole board, every owner, in one transaction, refusing a target
  that already holds any of the owners. In no-login mode it also refuses an export whose owner is not
  `NO_LOGIN_USER`, because content keys are derived from the owner name and a different name would open nothing.
  It prints per-table, per-owner counts (api-123). The migration tool targets this command.

## 4. CLI

TypeScript, commander, Bun-compiled binary for linux-x64, linux-arm64 and darwin-arm64, also runnable on Node
(cli-063). It replaces `board` with every command in the census (cli-012).

### Profiles

([ADR-0011](adr/0011-cli-profiles.md))

| Item             | Rule                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Selection        | Global `--profile <name>` or `AGENT_BOARD_PROFILE`; default profile `default`                                              |
| Name             | `^[a-z0-9][a-z0-9-]{0,31}$`                                                                                                |
| Config           | `$XDG_CONFIG_HOME/agent-board/profiles/<name>/` (`~/.config/…` when unset): `config.yaml`, `server.json`, `env` (mode 600) |
| State            | `$XDG_STATE_HOME/agent-board/profiles/<name>/` (`~/.local/state/…` when unset)                                             |
| Run (locks, pid) | `<state>/run/`                                                                                                             |
| Overrides        | `AGENT_BOARD_CONFIG_DIR`, `AGENT_BOARD_STATE_DIR`, `AGENT_BOARD_RUN_DIR` replace the three directories                     |
| launchd labels   | `agent-board.<profile>.dispatch`, `.listen`, `.watch`                                                                      |
| systemd units    | `agent-board-<profile>-dispatch.service` and `.timer`, `-listen.service`, `-watch.service`                                 |
| Keychain service | `agent-board.cli.<profile>` (cli-008)                                                                                      |

A second `board setup` under another profile installs beside the first (cli-051). The server app sets the three
directory overrides under its own root and installs no launchd units, so it never collides with a CLI install
(server-app-007).

### Install and doctor

`board setup` renders the worker units for the selected profile from the contract's unit recipe: systemd user units
(`agent-board-<profile>-dispatch.service` and `.timer`, `-listen.service`, `-watch.service`) on Linux and launchd agents
(`agent-board.<profile>.dispatch`, `.listen`, `.watch`) on macOS. `board uninstall` revokes the machine token before it
removes the units. `board doctor` checks one profile and reports each check under an id of the contract's
`DOCTOR_CHECK_IDS`. Two ids keep an old file name: `web.json` reports `server.json` and `config.json` reports
`config.yaml`. The contract is frozen, so the CLI maps its checks to those ids instead of renaming them.

### User commands

`board answer`, `dismiss`, `reply`, `send`, `stop`, `take-back`, `rerun`, `close`, `reopen`, `fork`,
`transcript` (cli-028–034) call the user-authored machine commands. They refuse inside a run (cli-009,
cli-084) and print the grant needed when the server answers `grant-required`.

## 5. Browser client

React 19, Mantine, TanStack Query, react-router, Vite. Built as static files; bundled unchanged by the client app
and Android.

### Transport

One `Transport` per server entry (web-101):

| Implementation | Chosen when                                        | Credential                         |
| -------------- | -------------------------------------------------- | ---------------------------------- |
| `sameOrigin`   | Plain browser and the entry's origin is the page's | Cookie                             |
| `crossOrigin`  | Plain browser, another origin                      | `abc_` token from the namespace    |
| `native`       | `window.agentBoardBridge` exists (a wrapper)       | Held natively; added by the bridge |

`Transport` has `request(method, path, { query, body, signal })` and `stream(path, signal)`, which yields parsed
SSE events. The bridge interface is defined by the browser client in `apps/web/src/bridge/types.ts`; the wrappers
implement it, so the dependency points from wrapper to client.

### Several servers and key isolation

([ADR-0005](adr/0005-per-server-key-isolation.md))

- The server list (id, name, address) is per-device configuration in `localStorage` (web-096). In the wrappers
  the list is kept natively and reached through the bridge, because the handover and the per-server windows need it
  before any page loads.
- Each server id owns a namespace: an IndexedDB database `agent-board:<serverId>` holding its keys, signing key
  and client token (cross-origin only), and `localStorage` keys prefixed `ab:<serverId>:` for drafts and volatile
  state. Two entries for the same address have two ids and share nothing (web-085, web-102).
- **The query cache lives in memory only.** It is never persisted to web storage, so no decrypted value outlives the
  page (web-100).
- Removing a server deletes exactly its namespace (web-095). Lock clears its keys, cache, drafts and dialogs
  (web-004).
- One page may hold several namespaces, which is what lets the board show several servers together (web-086).
  The client app opens one window per server and a separate "All servers" window for that view.
- **The server app's local server is opened from the client app or from its own origin**
  (`http://localhost:<port>`). The server app sets no `ALLOWED_ORIGINS`, so a page served by another server cannot
  reach it. A browser on the local server's own page can still open hosted servers that list
  `http://localhost:<port>` in their `ALLOWED_ORIGINS`.

### Storage rule

([ADR-0014](adr/0014-storage-rule.md))

| Store                            | May hold                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `localStorage`, `sessionStorage` | Drafts as typed (with a hash of the text they were based on), last tab, project filter, colour scheme, the server list |
| IndexedDB per server             | Non-extractable keys, the signing key, the cross-origin client token                                                   |
| Memory only                      | The query cache and every decrypted value                                                                              |
| Server database                  | Everything the user would miss on another device: titles, icons, labels, settings, recent icons                        |
| Wrapper native stores            | Keychain or Keystore: client token, signing key. Tab file: paths and selection only                                    |

A test clears web storage after a full journey and finds nothing missing; the server list is the one item it
names as exempt, because it is per-device configuration (web-099). Nothing in web storage or IndexedDB holds
decrypted content outside a draft (web-100).

## 6. Wrappers

### Native bridge (client app and Android)

([ADR-0004](adr/0004-wrapper-sessions-native-bridge.md))

The bundled page reaches its servers only through named Rust commands:

| Command                                               | What Rust does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_fetch(serverId, method, path, headers, body)` | Resolves the server's address from its own list; normalises the path and refuses `..`, `%2e` in any case, `//`, backslashes and anything outside `/api/` and `/healthz`; refuses credential routes (`/api/auth/handoff/finish`, `/api/pair` and every route the contract marks `issuesCredential`, among them `client.machines.issue`, `client.passkeys.register` and `client.account.import`); strips page-supplied `Authorization`, `Cookie` and signature headers; adds the client token and the signature; streams the response over a Tauri channel |
| `handoff_finish(serverId, flowId, verifier)`          | Calls the finish with `tokenKind: "client"` and, when the server requires signatures, the public key of the Keychain or Keystore signing key; stores the token                                                                                                                                                                                                                                                                                                                                                                                           |
| `pair(serverId, code, label)`                         | Calls `POST /api/pair` with the code and the stored public key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sign_out(serverId)`                                  | Calls logout, then deletes the token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Server list commands                                  | List, add, rename, remove. An add or remove started by the page needs a native confirmation dialog                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `notify`, `open_link`, `report_tab`                   | The client-app-002 set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Client app (macOS)

- One window per server with its own tab strip; the server list window; an "All servers" window.
- Windows stay alive when hidden or minimised; background throttling is off for server windows
  ([ADR-0008](adr/0008-hidden-windows-live-view.md)). If throttling cannot be turned off on a macOS version, the
  app falls back to generic notifications from the attention route.
- Handover from the server app ([ADR-0007](adr/0007-handover-deep-link.md)):
  `agentboard://open?v=1&url=<encoded server URL>`, delivered with `open -b <client app bundle id>`. The server app
  falls back to the default browser when that command fails. Only loopback URLs without credentials are accepted
  (client-app-014).

### Android

- One webview; servers isolated by namespace as in the browser.
- A foreground service, running only while the user has notifications on, polls the attention route with the
  natively held token and raises "A task needs you on <server>" with a link to the task. The task title shows
  only when the page is alive (mobile-005).

### Server app (macOS)

- A tray-only Tauri app supervising the API executable and the CLI's listener, watcher and dispatch tick. The API
  binds `127.0.0.1:<port>` directly; there is no front.
- Backups hold the API over the control channel.
- Settings add `remoteHosts` and `requestSignature` for remote devices; a remote host needs the signature on
  (server-app-089). The tray's "Pair a device…" shows a pairing code (server-app-090).

### Remote devices

([ADR-0013](adr/0013-remote-device-access.md))

| Option | How a device off the Mac reaches the server                                                                                                                                                            | Status              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| a      | Any https tunnel or reverse proxy that forwards to loopback (for example `tailscale serve`), with its host name in `remoteHosts`, the request signature on, and the device paired with a one-time code | Chosen; base design |
| c      | A hosted API in login mode with a public https URL                                                                                                                                                     | Base design         |
| b      | The server app binds the LAN with a self-signed certificate; the wrappers pin its fingerprint when the server is added                                                                                 | Conditional, parked |

## 7. Migration tool

([ADR-0015](adr/0015-migration-tool.md))

```
source board ──read-only──▶ reader (per source version) ──▶ BoardExport file ──▶ agent-board-api import
```

- **Sources:** a hosted Postgres database (admin URL, read-only transaction) or a local server's PGlite data
  folder. The folder's `PG_VERSION` picks a PGlite build installed under an npm alias, so older data folders open
  (migrate-001, migrate-010).
- **Output:** a `BoardExport` file. Sealed values and blind indexes are copied byte for byte (migrate-003). Tasks
  and schedules land in each owner's default project (migrate-005). Directories arrive as legacy documents and
  become rows when each machine's CLI first connects (§3, legacy directories).
- **Dry run** writes the export and a plan report and imports nothing (migrate-006).
- **Count check** compares per-table, per-owner counts of the source with the import's report and fails on any
  difference (migrate-007). Source `dirs` machine documents count against target `legacy_dirs` rows; the other
  machine documents count against target machine documents. The import is one transaction (migrate-008).
- **Owner name.** Into a no-login target the import refuses an owner other than `NO_LOGIN_USER` (api-123). For the
  server app, `userName` in its settings must equal the exported owner name.
- **Order for the server app.** Quit the server app (a PGlite folder has one process at a time), set `userName`,
  run the migration into its data folder through the bundled API executable, then start the app and enrol the
  worker with its existing token and data key. A data folder in which the owner already exists is refused.
- Machine token hashes are copied, so a worker running the new CLI keeps its token (migrate-004). Today's `board`
  binaries are out of scope; each worker host installs the new CLI and runs `board init` with its existing token
  and data key.
- **Test data** is synthetic: a script runs a reference board in a throwaway environment with a made-up user and
  passphrase, and the resulting database and vectors are committed. Real data never enters the repository or CI;
  the rehearsal on a copy of real data is a manual step (migrate-009, repo-007).

## 8. Tests

([ADR-0016](adr/0016-test-layering.md))

| Layer       | Where                       | Runs                                                                                                                                                                                             |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Each part's `test/`         | Vitest                                                                                                                                                                                           |
| Integration | `apps/api/test/integration` | Vitest against real Postgres 16 and PGlite                                                                                                                                                       |
| CLI         | `apps/cli/test`             | Vitest, black-box against the built binary for the smoke set                                                                                                                                     |
| Browser     | `apps/web/test`             | Vitest + Testing Library; Playwright component runs for layout rows, with a fake `Transport`                                                                                                     |
| Wrappers    | `apps/*-app`, `apps/mobile` | `cargo test` for Rust, with the contract's JSON case tables as vectors; Vitest for TypeScript; Playwright against the bundled client with a fake bridge                                          |
| E2E         | `e2e/`                      | Playwright (Chromium and WebKit, desktop and phone viewports) and Vitest, against a real API (Postgres and PGlite), the built CLI with a stub `claude`, and the browser client served by the API |
| Manual      | `docs/manual/`              | Written walks for tray, Keychain, notifications, the phone                                                                                                                                       |

- **E2E fixtures.** Most E2E tests run the API in no-login mode. Sign-in rows run it in login mode against a fake
  OIDC provider process that the harness starts, with the API configured through `OIDC_*`; passkey rows use
  Chromium's virtual authenticator. The suite imports `sealing` to unlock a key for fixtures and to assert that no
  column holds plaintext.
- Every test title carries its catalogue row id in brackets, for example `[api-025] cookie session is HttpOnly`.
  `pnpm catalogue:check` reads the catalogue and the test titles, fills the Test ids column and fails on a row
  with no test that is not manual or retired (R4.3).
- E2E tests written before their part are listed in `e2e/expected-red.json`. The E2E job fails when a listed test
  passes or an unlisted test fails, so `main` stays green while the list shrinks to empty.

## 9. Threat model notes

- **Server data is hostile to the page.** Content is sealed and rendered through a sanitising Markdown renderer
  with remote images blocked (web-047). The CSP keeps `script-src 'self'` with no inline scripts.
- **`connect-src https:` is an accepted risk.** A script injected into the plain browser client could send what it
  reads to any https host. The server list is per-device and dynamic, so the CSP cannot name the servers in
  advance. `script-src 'self'`, sanitised rendering and sealed content are the controls against injection. The
  wrappers do not take this risk: their CSP allows only the IPC origin.
- **Wrapper pages get no credentials.** Tokens and signing keys stay in Rust. The bridge refuses paths outside
  `/api/` and `/healthz`, path tricks, credential routes and servers not in its list. A page cannot add or remove a
  server without a native confirmation.
- **A cross-origin client token is readable by page code** in a plain browser. The CSP, the sealing of all content
  and the token's expiry bound the damage; the same-origin cookie stays HttpOnly.
- **Loopback.** Without the request signature any local process can act as the user of a no-login server; the
  signature makes that require a paired key. Malware running as the same macOS user can still read the Keychain
  after a prompt, so the signature raises the bar and is not a boundary.
- **The handover deep link** can be triggered by any local app; it only adds or opens loopback servers without
  credentials, and never carries a pairing code.
- **Machines acting as the owner** would let an agent on a worker host answer its own questions; the grant is off
  by default and refused for the task the machine is running.

## 10. Decision map

### Rows that deferred a decision to the architecture

| Row                                         | Decision                                                                    | Where                      |
| ------------------------------------------- | --------------------------------------------------------------------------- | -------------------------- |
| api-025, ST-16                              | Client token for bundled and cross-origin clients; cookie stays same-origin | §3 Sessions, ADR-0004      |
| client-app-037                              | Rust performs the hand-off finish and sends every request                   | §6 Native bridge, ADR-0004 |
| contract-012                                | Deep link `agentboard://open?v=1&url=…` via `open -b`                       | §6 Client app, ADR-0007    |
| client-app-016                              | Live view, throttling off, attention-route fallback                         | §6 Client app, ADR-0008    |
| client-app header (window model, isolation) | One window per server plus "All servers"; namespace per server id           | §5, ADR-0005               |
| server-app header (front)                   | No front; the API serves the browser client                                 | §3 Static files, ADR-0006  |
| cli-review §3.2 (machine as owner)          | Grant per machine, off by default                                           | §3, ADR-0009               |
| web-091 (connection check)                  | One `GET /api/version` with session and pairing state                       | §2, ADR-0002               |

### Amended rows

| Row                                                                        | Change                                                        | ADR                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------ |
| api-026                                                                    | `Authorization` accepted for `abc_` and `abm_` only           | ADR-0004           |
| api-039                                                                    | Finish can return a client token and bind a signing key       | ADR-0004, ADR-0012 |
| api-087                                                                    | No directory document in the version answer                   | ADR-0010           |
| api-098                                                                    | A missing contract header gets 412                            | ADR-0002           |
| api-103, api-105                                                           | Directory rows; delete with `then`; directory moves           | ADR-0010           |
| contract-002                                                               | `missing-features` result                                     | ADR-0002           |
| contract-007                                                               | JSON case table; conditional pinned-fingerprint case          | ADR-0001, ADR-0013 |
| contract-008                                                               | Token prefixes                                                | ADR-0004           |
| web-011                                                                    | Wrappers and cross-origin sign in through the hand-off        | ADR-0004           |
| web-079                                                                    | One header table in the contract; wider `connect-src`         | ADR-0004, ADR-0006 |
| web-085                                                                    | Namespace per server id                                       | ADR-0005           |
| web-091                                                                    | `needs-pairing` state                                         | ADR-0012           |
| web-099, web-100                                                           | Server-list exemption named; IndexedDB and memory-only cache  | ADR-0014           |
| client-app-002                                                             | Extended bridge; native confirmation for list changes         | ADR-0004           |
| client-app-030                                                             | Retired                                                       | ADR-0004           |
| mobile-005                                                                 | Generic background notification from the attention route      | ADR-0008           |
| cli-038                                                                    | `set-dirs` writes directory rows                              | ADR-0010           |
| cli-050                                                                    | `--profile` instead of `--server <profile>`                   | ADR-0011           |
| migrate-004, migrate-005                                                   | New CLI keeps the token; directories convert on first contact | ADR-0015           |
| server-app-010, 012, 017, 024, 028, 034, 035, 057, 070, 073, 074, 083, 088 | Reworded for the API without a front                          | ADR-0006, ADR-0012 |
| server-app-075 … 082                                                       | Retired; moved to api-107 … api-110 where behaviour stays     | ADR-0006           |

### Added rows

api-107 … api-125, contract-013 … contract-015, web-101 … web-106, client-app-049 … client-app-052,
server-app-089 … server-app-091, mobile-008 … mobile-010, cli-083 … cli-085, migrate-011, migrate-012, repo-008,
repo-009. Rows marked "Conditional" (api-124, server-app-091, mobile-009) are built only if option b of ADR-0013 is
chosen later.

### ADRs

| ADR                                                | Decision                                      |
| -------------------------------------------------- | --------------------------------------------- |
| [0001](adr/0001-dependency-rule-and-versioning.md) | Dependency rule, versions, N vs N-1 matrix    |
| [0002](adr/0002-contract-style-and-handshake.md)   | Contract style and handshake                  |
| [0003](adr/0003-api-module-registry.md)            | API module registry                           |
| [0004](adr/0004-wrapper-sessions-native-bridge.md) | Sessions for bundled and cross-origin clients |
| [0005](adr/0005-per-server-key-isolation.md)       | Per-server isolation                          |
| [0006](adr/0006-api-serves-browser-client.md)      | The API serves the browser client             |
| [0007](adr/0007-handover-deep-link.md)             | Handover deep link                            |
| [0008](adr/0008-hidden-windows-live-view.md)       | Hidden windows keep a live view               |
| [0009](adr/0009-machine-acts-as-owner-grant.md)    | Machine acting as owner                       |
| [0010](adr/0010-projects-data-model.md)            | Projects data model                           |
| [0011](adr/0011-cli-profiles.md)                   | CLI profiles                                  |
| [0012](adr/0012-request-signature.md)              | Request signature                             |
| [0013](adr/0013-remote-device-access.md)           | Remote device access                          |
| [0014](adr/0014-storage-rule.md)                   | Storage rule                                  |
| [0015](adr/0015-migration-tool.md)                 | Migration tool                                |
| [0016](adr/0016-test-layering.md)                  | Test layering                                 |
