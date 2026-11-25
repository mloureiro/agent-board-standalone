# Changelog

## 1.0.0

Not released. The web part is complete for its first release when this section is moved above `0.0.0` by the steps
below.

The browser client is the one client for the API: a board with Backlog, Todo, Waiting, Running, Needs me and Done
columns, the task page with its transcript and action panel, New task, Schedules, Closed, Settings, and the project
filter and sidebar. It seals and opens every value in the browser with the keys the passphrase unlocks, keeps those
keys non-extractable in a per-server IndexedDB database, and signs each request when the server asks for it.

One client reaches several servers. Each server in the list has its own sign-in, keys, drafts and cache under its own
namespace, the board shows one server or several together with each card naming its server, and the sidebar lists the
projects of every server. The server list (name and address, nothing else) is the one item kept in `localStorage`
outside a server namespace. The Servers dialog adds, tests, renames and removes entries; removing one deletes its whole
namespace.

It declares contract level 1 and the sealing package it was built with, and states clearly when a server is too old or
too new. The build writes `dist/version.json` with the part version and the contract level.

Release steps for `web-v1.0.0`:

1. Set `version` in `apps/web/package.json` and `PART_VERSION` in `apps/web/src/version.ts` to `1.0.0`, and update
   `test/version.test.ts`.
2. Run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` at the root.
3. Run `pnpm --filter @agent-board/web build`, then `pnpm --filter @agent-board/web release:check 1.0.0`. It refuses to
   pass while the versions, the heading above or `dist/version.json` disagree.
4. Remove `apps/web/dist`, merge, and run `pnpm release:tags --dry-run`, then `pnpm release:tags` on `main` to create
   the annotated tag `web-v1.0.0`.

## 0.0.0

Not released
