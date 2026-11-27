import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const PART_DIRECTORIES = [
  'apps/api',
  'apps/cli',
  'apps/web',
  'apps/migrate',
  'apps/server-app',
  'apps/client-app',
  'apps/mobile',
  'packages/contract',
  'packages/sealing',
];
const PACKAGE_DIRECTORIES = ['.', ...PART_DIRECTORIES, 'e2e', 'tools/repo'];

interface Manifest {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

function manifest(directory: string): Manifest {
  return JSON.parse(readFileSync(`${root}${directory}/package.json`, 'utf8')) as Manifest;
}

function admits(range: string, version: string): boolean {
  const match = /^workspace:\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) throw new Error(`unsupported range ${range}`);
  const wanted = match.slice(1).map(Number) as [number, number, number];
  const actual = version.split('.').map(Number) as [number, number, number];
  const [major, minor, patch] = wanted;
  if (actual[0] !== major) return false;
  if (major > 0) return actual[1] > minor || (actual[1] === minor && actual[2] >= patch);
  if (actual[1] !== minor) return false;
  return minor > 0 ? actual[2] >= patch : actual[2] === patch;
}

describe('repository', () => {
  it('[repo-004] every package declares MIT', () => {
    for (const directory of PACKAGE_DIRECTORIES) {
      expect(manifest(directory).license, directory).toBe('MIT');
    }
  });

  it('[repo-004] LICENSE exists at the root', () => {
    expect(readFileSync(`${root}LICENSE`, 'utf8')).toContain('MIT License');
  });

  it('[repo-005] every part has a CHANGELOG with a heading for its version', () => {
    for (const directory of PART_DIRECTORIES) {
      const path = `${root}${directory}/CHANGELOG.md`;
      expect(existsSync(path), directory).toBe(true);
      const lines = readFileSync(path, 'utf8').split('\n');
      expect(lines[0], directory).toBe('# Changelog');
      expect(lines, directory).toContain(`## ${manifest(directory).version}`);
    }
  });

  it("[contract-009] every workspace range on contract and sealing admits the package's version", () => {
    const versions: Record<string, string> = {
      '@rumo/contract': manifest('packages/contract').version,
      '@rumo/sealing': manifest('packages/sealing').version,
    };
    let checked = 0;
    for (const directory of PACKAGE_DIRECTORIES) {
      for (const [name, range] of Object.entries(manifest(directory).dependencies ?? {})) {
        const version = versions[name];
        if (version === undefined) continue;
        checked += 1;
        expect(admits(range, version), `${directory} ${name} ${range}`).toBe(true);
      }
    }
    expect(checked).toBe(10);
  });
});
