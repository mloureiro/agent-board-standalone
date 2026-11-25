import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../domain/values.js';
import { writeAtomic } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';
import { COMMIT, NAME } from './manifest.js';

export interface Installed {
  readonly url: string;
  readonly commit: string;
}

export type Registry = Readonly<Record<string, Installed>>;

export const pluginsDir = (dirs: ProfileDirs): string => path.join(dirs.state, 'plugins');
export const checkoutDir = (dirs: ProfileDirs, name: string): string =>
  path.join(pluginsDir(dirs), 'marketplaces', name);
const registryFile = (dirs: ProfileDirs): string => path.join(pluginsDir(dirs), 'installed.json');

export function readRegistry(dirs: ProfileDirs): Registry {
  const file = registryFile(dirs);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const table = isRecord(raw) && isRecord(raw.marketplaces) ? raw.marketplaces : {};
  const registry: Record<string, Installed> = {};
  for (const [name, entry] of Object.entries(table)) {
    if (
      NAME.test(name) &&
      isRecord(entry) &&
      typeof entry.url === 'string' &&
      typeof entry.commit === 'string' &&
      COMMIT.test(entry.commit)
    ) {
      registry[name] = { url: entry.url, commit: entry.commit };
    }
  }
  return registry;
}

export function writeRegistry(dirs: ProfileDirs, registry: Registry): void {
  mkdirSync(pluginsDir(dirs), { recursive: true, mode: 0o700 });
  writeAtomic(
    registryFile(dirs),
    `${JSON.stringify({ marketplaces: registry }, null, 2)}\n`,
    0o600,
  );
}
