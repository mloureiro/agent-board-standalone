# ADR-0004: Sessions for bundled and cross-origin clients

## Status

Accepted.

## Context

The client app and Android bundle the browser client, so their pages run on `tauri://localhost` or
`http://tauri.localhost`, never on the server's origin. A `SameSite=Lax` cookie is not sent from there, and WebKit
blocks third-party cookies. A plain browser showing a second server has the same problem. Today's desktop client
already moved requests into Rust to get around this.

## Decision

- **Same origin:** the HttpOnly `abs_` cookie, unchanged.
- **Wrappers:** a native bridge of named Rust commands.
  - `server_fetch(serverId, method, path, headers, body)` resolves the address from the native server list. It
    normalises the path and refuses `..`, `%2e` in any case, `//`, backslashes, and anything outside `/api/` and
    `/healthz`. It refuses credential routes: `/api/auth/handoff/finish`, `/api/pair` and every route the contract
    marks `issuesCredential`. It strips page-supplied `Authorization`, `Cookie` and signature headers, adds the
    client token and the request signature, and streams the response back over a Tauri channel.
  - `handoff_finish(serverId, flowId, verifier)` calls the finish with `tokenKind: "client"` and, when the server
    requires signatures, the stored public key; it keeps the token in the Keychain or Android Keystore.
  - `pair(serverId, code, label)` calls `POST /api/pair` with the stored public key.
  - `sign_out(serverId)` logs out and deletes the token.
  - Server-list commands; an add or remove started by the page needs a native confirmation.
  - The token and the signing key never reach page code.
- **Plain browser, other server:** an `abc_` client token from the hand-off, kept in that server's IndexedDB
  namespace and sent as `Authorization: Bearer`. The target server must list the page's origin in
  `ALLOWED_ORIGINS`; CORS answers carry no `Allow-Credentials`.
- A client token is a session row of kind `client` with the same expiry and logout as a cookie session.
  `Authorization` is accepted only for `abc_` and `abm_` tokens.
- Wrappers and cross-origin pages sign in through the hand-off only. Method buttons open the server's approval page
  in the system browser, where the user signs in by that method.
- The browser client talks through a `Transport` interface with `sameOrigin`, `crossOrigin` and `native`
  implementations. The bridge interface is defined by the browser client in `apps/web/src/bridge/types.ts` and
  implemented by the wrappers.
- The wrappers' own CSP allows `connect-src` only to the IPC origin.

## Consequences

- No CORS is involved for the wrappers; their native fetch makes the request.
- Only dedicated commands can obtain or bind a credential, so a script injected into the page cannot mint a token
  or pair a key of its own.
- In-app OIDC and SAML redirects are gone from the client app: client-app-030 is retired.
- A plain browser's cross-origin token is readable by page code. Sealing, the CSP and token expiry bound the damage.
- The browser client's CSP `connect-src` widens to `https:` and loopback http.

## Rows affected

api-025, api-026, api-039, api-107, api-113, api-114 (new), contract-008, client-app-002, client-app-030
(retired), client-app-037, client-app-049 (new), client-app-052 (new), mobile-008 (new), mobile-010 (new),
web-011, web-079, web-101, web-103 (new), ST-16.
