import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(E2E_ROOT, '..');
export const STUBS_DIR = path.join(E2E_ROOT, 'stubs');

export type PartName = 'api' | 'cli' | 'web' | 'migrate' | 'postgres';

interface PartSpec {
  readonly entry: string;
  readonly override: string;
}

const FILE_PARTS: Record<Exclude<PartName, 'postgres'>, PartSpec> = {
  api: { entry: 'apps/api/dist/main.js', override: 'RUMO_API_BIN' },
  cli: { entry: 'apps/cli/dist/rumo', override: 'RUMO_CLI_BIN' },
  web: { entry: 'apps/web/dist', override: 'RUMO_WEB_ROOT' },
  migrate: { entry: 'apps/migrate/dist/main.js', override: 'RUMO_MIGRATE_BIN' },
};

export const POSTGRES_URL_VARIABLE = 'E2E_POSTGRES_URL';

export interface PartLocation {
  readonly part: PartName;
  readonly path: string;
  readonly absolute: string | null;
}

export function locatePart(part: PartName, env: NodeJS.ProcessEnv = process.env): PartLocation {
  if (part === 'postgres') {
    return { part, path: POSTGRES_URL_VARIABLE, absolute: null };
  }
  const spec = FILE_PARTS[part];
  const override = env[spec.override];
  if (override) {
    return { part, path: override, absolute: path.resolve(REPO_ROOT, override) };
  }
  return { part, path: spec.entry, absolute: path.join(REPO_ROOT, spec.entry) };
}

export function partIsPresent(part: PartName, env: NodeJS.ProcessEnv = process.env): boolean {
  const location = locatePart(part, env);
  if (location.absolute === null) return Boolean(env[POSTGRES_URL_VARIABLE]);
  return existsSync(location.absolute);
}

export function missingParts(
  parts: readonly PartName[],
  env: NodeJS.ProcessEnv = process.env,
): { part: PartName; path: string }[] {
  return parts
    .filter((part) => !partIsPresent(part, env))
    .map((part) => ({ part, path: locatePart(part, env).path }));
}

export function partPath(
  part: Exclude<PartName, 'postgres'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  return locatePart(part, env).absolute as string;
}

export function commandFor(
  bin: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (/\.(?:c|m)?[jt]s$/.test(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args: [...args] };
}
