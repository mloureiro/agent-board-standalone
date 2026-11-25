# Changelog

## 1.0.0

Not released. The Android wrapper is complete for its first release when this section is moved above `0.0.0` by the
steps below.

An installable Android APK that bundles the browser client of the same release and loads no page from a server. The
page reaches servers only through the native bridge: `server_fetch` normalises paths and refuses credential routes,
the client token and the ECDSA P-256 signing key stay in the Android Keystore, sign-in goes through the system browser
hand-off, and a device pairs with a one-time code. Links to other origins open in the system browser and dangerous
schemes are dropped. A foreground service, running only while a server has notifications on, polls the attention
route every 60 seconds and raises "A task needs you on <server>"; tapping it opens the task.

Release steps for `mobile-v1.0.0`:

1. Set `version` in `apps/mobile/package.json`, `PART_VERSION` in `apps/mobile/src/version.ts`, `version` in
   `apps/mobile/src-tauri/tauri.conf.json` and the `[package]` version in `apps/mobile/src-tauri/Cargo.toml` to
   `1.0.0`, and update `test/version.test.ts`.
2. Run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` at the root.
3. Run `pnpm --filter @agent-board/mobile release:check 1.0.0`. It refuses to pass while the versions or the heading
   above disagree.
4. Merge, then run `pnpm release:tags --dry-run` and `pnpm release:tags` on `main` to create the annotated tag
   `mobile-v1.0.0`. The `Mobile APK` workflow builds the APK for the tag, signs it with the release key held in the
   `MOBILE_KEYSTORE_B64` and `MOBILE_KEYSTORE_PASSWORD` repository secrets, and attaches it to the release.

## 0.0.0

Not released
