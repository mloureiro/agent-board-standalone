# Changelog

## 1.0.0

Not released. The client app is complete for its first release when this section is moved above `0.0.0` by the steps
below.

The macOS desktop wrapper around the browser client. One window per server with its own tab bar, split panes, the
home board, and an "All servers" window. The native bridge keeps each server's session token and request-signing key in
the Keychain, signs requests when the server asks for it, signs in through the browser hand-off and pairs with a server
app code. It raises native notifications for tasks that need you, also from hidden or minimised windows, opens
`agentboard://` handover links, and zooms the pages of the key window.

On first launch it deletes the stores of the previous client app (its per-server WebKit data, `tabs/` and the Keychain
session entry) and keeps `servers.json`.

Runs on macOS 14 or later. The release attaches two universal, ad-hoc signed bundles: `Agent Board` and
`Agent Board Debug`, which has the Web Inspector and the same bundle id. Ad-hoc signing means macOS asks once per update
whether the new build may read the Keychain items of the previous one.

Release steps for `client-app-v1.0.0`:

1. Set `version` in `apps/client-app/package.json` and `src-tauri/Cargo.toml`, and `PART_VERSION` in
   `apps/client-app/src/version.ts`, to `1.0.0`, and update `test/version.test.ts`.
2. Run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` at the root.
3. Run `pnpm --filter "@agent-board/client-app..." run build`, then
   `pnpm --filter @agent-board/client-app release:check 1.0.0`. It refuses to pass while the versions, the heading
   above or `dist/version.json` disagree.
4. Remove `apps/client-app/dist` and `dist-bridge`, merge, and run `pnpm release:tags --dry-run`, then
   `pnpm release:tags` on `main` to create the annotated tag `client-app-v1.0.0`. Push it: the `Release assets` workflow
   builds both bundles and attaches them to the release.
5. Walk `docs/manual/client-app.md` on a Mac with the attached zips.

## 0.0.0

Not released
