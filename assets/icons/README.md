# App icons

Approved SVG sources. `pnpm icons` generates every size from them (needs `rsvg-convert` and `magick`).

| Source            | Background  | Used by                                                                 |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| `client.svg`      | transparent | client app icon, Android adaptive foreground, browser favicon           |
| `server.svg`      | transparent | server app icon                                                         |
| `client-grey.svg` | grey tile   | Android legacy and round icons, `apple-touch-icon.png`                  |
| `server-grey.svg` | grey tile   | not used: no platform requires a tile for the server app               |
| `server-tray.svg` | transparent | server app menu-bar icon: black shapes, loaded as a macOS template image |

## Rules

- No background, except where the platform requires one: the Android adaptive background layer (`#E9E9EC`), the Android legacy and round icons, and iOS-style touch icons.
- The Android foreground is the client mark scaled into the adaptive-icon safe zone (61% of the canvas).

## Outputs

- `apps/client-app/src-tauri/icons`, `apps/server-app/src-tauri/icons` (also `tray.png`, `tray@2x.png`), `apps/mobile/src-tauri/icons` (including `android`).
- `apps/web/public`: `favicon.svg`, `apple-touch-icon.png`, `icon-512.png`.

## Regenerate

```bash
pnpm icons
```
