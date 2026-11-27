import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseProblems } from '../scripts/release-check.ts';
import {
  cargoLockWith,
  cargoManifestWith,
  changelogWith,
  prepareRelease,
} from '../scripts/release.ts';

const folders: string[] = [];

const CARGO =
  '[workspace]\nmembers = ["core"]\n\n[package]\nname = "rumo-server"\nversion = "0.0.0"\nedition.workspace = true\n\n[dependencies]\ntauri = { version = "=2.12.6" }\n';
const LOCK =
  '[[package]]\nname = "rumo-server"\nversion = "0.0.0"\n\n[[package]]\nname = "rumo-server-core"\nversion = "0.0.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n';

const part = (changelog = '# Changelog\n\n## 0.0.0\n\nNot released\n'): string => {
  const root = mkdtempSync(join(tmpdir(), 'server-app-release-'));
  folders.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'src-tauri/core'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    '{\n  "name": "@rumo/server-app",\n  "version": "0.0.0"\n}\n',
  );
  writeFileSync(
    join(root, 'src/version.ts'),
    "export const PART_NAME = 'server-app';\nexport const PART_VERSION = '0.0.0';\n",
  );
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), CARGO);
  writeFileSync(
    join(root, 'src-tauri/core/Cargo.toml'),
    CARGO.replace('"rumo-server"', '"rumo-server-core"'),
  );
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), LOCK);
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return root;
};

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('server app release preparation', () => {
  it('sets the version everywhere and writes the notes over the unreleased entry', async () => {
    const root = part();
    await prepareRelease(root, '1.0.0', 'First release.');

    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.0.0"');
    expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toContain("PART_VERSION = '1.0.0'");
    expect(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')).toContain(
      'name = "rumo-server"\nversion = "1.0.0"',
    );
    expect(readFileSync(join(root, 'src-tauri/core/Cargo.toml'), 'utf8')).toContain(
      'version = "1.0.0"',
    );
    const lock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
    expect(lock).toContain('name = "rumo-server"\nversion = "1.0.0"');
    expect(lock).toContain('name = "rumo-server-core"\nversion = "1.0.0"');
    expect(lock).toContain('name = "serde"\nversion = "1.0.0"');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## 1.0.0\n\nFirst release.\n\n',
    );
  });

  it('keeps notes already written under the version heading', async () => {
    const changelog = '# Changelog\n\n## 1.0.0\n\nWritten ahead.\n\n## 0.0.0\n\nNot released\n';
    const root = part(changelog);
    await prepareRelease(root, '1.0.0', '');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
    await expect(prepareRelease(part(changelog), '1.0.0', 'More.')).rejects.toThrow(/already has/);
  });

  it('refuses missing notes, an older version and a malformed version', async () => {
    await expect(prepareRelease(part(), '1.0.0', '')).rejects.toThrow(/release notes/);
    await expect(prepareRelease(part(), '0.0.0', 'x')).rejects.toThrow(/not newer/);
    await expect(prepareRelease(part(), '1.0', 'x')).rejects.toThrow(/not a release version/);
  });

  it('puts a new entry above the previous release and edits only the package versions', () => {
    expect(changelogWith('# Changelog\n\n## 1.0.0\n\nFirst.\n', '1.1.0', 'More.')).toBe(
      '# Changelog\n\n## 1.1.0\n\nMore.\n\n## 1.0.0\n\nFirst.\n',
    );
    expect(cargoManifestWith(CARGO, '2.0.0')).toContain('tauri = { version = "=2.12.6" }');
    expect(cargoLockWith(LOCK, '2.0.0')).toContain('name = "serde"\nversion = "1.0.0"');
  });
});

describe('server app release check', () => {
  const ready = {
    target: '1.0.0',
    packageVersion: '1.0.0',
    sourceVersion: '1.0.0',
    cargoVersions: { 'src-tauri/Cargo.toml': '1.0.0' },
    changelog: '# Changelog\n\n## 1.0.0\n\nx\n',
    bundleVersion: '1.0.0',
  };

  it('accepts a prepared and built release', () => {
    expect(releaseProblems(ready)).toEqual([]);
  });

  it('names every file that is off and a missing or stale build', () => {
    const problems = releaseProblems({
      ...ready,
      packageVersion: '0.0.0',
      cargoVersions: { 'src-tauri/Cargo.toml': '0.9.0' },
      changelog: '# Changelog\n',
      bundleVersion: null,
    });
    expect(problems).toHaveLength(4);
    expect(releaseProblems({ ...ready, bundleVersion: '0.0.0' })).toEqual([
      'the built .app is 0.0.0, not 1.0.0',
    ]);
  });
});
