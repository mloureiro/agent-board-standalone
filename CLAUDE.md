# rumo

One pnpm monorepo replacing the `agent-board` fork, `agent-board-client` and `agent-board-local-server`.
Written from scratch against E2E tests; no code is copied from the old repositories.

## Layout

| Path                                    | Part                                          |
| --------------------------------------- | --------------------------------------------- |
| `apps/api`                              | API/server: database and orchestration        |
| `apps/cli`                              | CLI, the engine on each host running `claude` |
| `apps/web`                              | Browser client (responsive)                   |
| `apps/server-app`                       | Desktop wrapper around the API                |
| `apps/client-app`                       | Desktop wrapper around the browser client     |
| `apps/mobile`                           | Android wrapper around the browser client     |
| `apps/migrate`                          | Migration tool from existing boards           |
| `packages/contract`, `packages/sealing` | Shared, versioned wire contract and sealing   |
| `e2e`                                   | End-to-end suite connecting API, CLI, client  |

## Conventions

- Only a wrapper depends on what it wraps. API, CLI and browser client share only `contract` and `sealing`, pinned by version. Each part installs and runs alone.
- One version per part. Each part declares the contract versions it supports and states clearly when a peer is too old or too new.
- TypeScript strict. Rust only inside the Tauri wrappers.
- `index.ts` files hold only imports and exports.
- No code comments unless they carry obscure domain criteria or an edge case the code cannot show.
- `localStorage`/`sessionStorage` hold volatile state only; titles, icons and any content the user would miss on another device live in the database.
- Tests: most live in each part's own suite; `e2e/` connects the main parts and does not replace them.

## Gates

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

CI runs the same gates once per push, plus a placeholder job for the N vs N-1 compatibility matrix.

## Workflow

- Work in a worktree (`m-worktree new <branch>`); never in the main checkout.
- Delivery is solo: QA opens the PR, CI green, QA merges to `main`.
- Commit subjects are plain imperative summaries with no prefix and no ticket id; the bead id goes in the PR title.
- Beads (`bd`) stay local: `.beads/` is git-ignored; never `bd sync`, never commit it.
- Requirements and plan live in the git-ignored `wiki/` (`wiki/plan/REQUIREMENTS.md`, `wiki/plan/ORCHESTRATION.md`).
