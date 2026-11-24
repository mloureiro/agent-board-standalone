# ADR-0014: What clients may keep in web and native storage

## Status

Accepted.

## Context

Web storage may hold volatile state only (R3.4). The storage audit found titles, icons and settings in
`localStorage`, and decrypted text copied into drafts and tab files.

## Decision

| Store                            | May hold                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `localStorage`, `sessionStorage` | Drafts as typed plus a hash of the base text, last tab, project filter, colour scheme, the server list |
| IndexedDB per server             | Non-extractable keys, the signing key, the cross-origin client token                                   |
| Memory only                      | The query cache and every decrypted value                                                              |
| Server database                  | Everything the user would miss on another device; per-user settings as one sealed document             |
| Wrapper native stores            | Keychain or Keystore: client token, signing key. Tab file: paths and selection only                    |

- All access goes through the per-server storage module (ADR-0005).
- The query cache is never persisted.
- A test clears web storage after a full journey and finds nothing missing. It names the server list as the one
  exemption, because the list is per-device configuration.
- A test scans web storage and IndexedDB after a journey and finds no decrypted content outside a draft.

## Consequences

- Notification on/off, recent icons and similar settings move to the server and follow the user across devices.
- The colour scheme and the project filter stay per device.
- A reload refetches everything; nothing decrypted survives it.

## Rows affected

api-101, web-003, web-063 … web-066, web-073, web-074, web-081, web-096, web-099, web-100, client-app-024,
client-app-036, ST-01 … ST-21.
