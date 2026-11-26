# App icons

One source image per app. Every macOS and Android icon size is generated from it.

| Source          | Used by                                   |
| --------------- | ----------------------------------------- |
| `client-app.png` | `apps/client-app` and `apps/mobile` (Android) |
| `server-app.png` | `apps/server-app`                         |

## Contract

- PNG, exactly 1024x1024 pixels, square.
- RGBA. Transparent corners are allowed.
- One file per app, named as in the table above.

## Status

Both files are placeholders built from the previous icons (upscaled to 1024). They wait for the owner's final files: replace them in place and regenerate.

## Regenerate

```bash
pnpm icons
```

This runs `tauri icon` for each app and writes only the files each app references into its `src-tauri/icons` directory. Commit the regenerated outputs together with the source change.
