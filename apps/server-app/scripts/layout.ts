import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PART_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PART_ROOT, '../..');
export const RESOURCES_DIR = path.join(PART_ROOT, 'src-tauri', 'resources');
export const APP_NAME = 'Rumo Server';
export const APP_BINARY = 'rumo-server';
export const BUNDLE_DIR = path.join(PART_ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos');
export const BUNDLED_APP = path.join(BUNDLE_DIR, `${APP_NAME}.app`);

export const LAYOUT = {
  api: 'api/rumo-api',
  schemaVersion: 'api/schema-version',
  apiVersion: 'api/version',
  cliVersion: 'cli/version',
  cli: 'cli/rumo',
  web: 'web',
} as const;

export const SCHEMA_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const PART_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

export const DEFAULT_SOURCES = {
  api: path.join(REPO_ROOT, 'apps/api/dist/rumo-api'),
  cli: path.join(REPO_ROOT, 'apps/cli/dist/release/rumo-darwin-arm64'),
  web: path.join(REPO_ROOT, 'apps/web/dist'),
  apiManifest: path.join(REPO_ROOT, 'apps/api/package.json'),
  cliManifest: path.join(REPO_ROOT, 'apps/cli/package.json'),
  migrations: path.join(REPO_ROOT, 'apps/api/migrations/meta/_journal.json'),
} as const;
