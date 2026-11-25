import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { changelogWith, prepareRelease } from '../scripts/release.js';

const folders: string[] = [];

const part = (
  version = '0.0.0',
  changelog = '# Changelog\n\n## 0.0.0\n\nNot released\n',
): string => {
  const root = mkdtempSync(join(tmpdir(), 'board-migrate-release-'));
  folders.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    `{\n  "name": "@agent-board/migrate",\n  "version": "${version}"\n}\n`,
  );
  writeFileSync(
    join(root, 'src', 'version.ts'),
    `export const PART_NAME = 'migrate';\nexport const PART_VERSION = '${version}';\n`,
  );
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return root;
};

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('release preparation', () => {
  it('sets the version in the manifest and in the source and replaces the unreleased entry', async () => {
    const root = part();
    await prepareRelease(root, '1.0.0', 'First release.');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.0.0"');
    expect(readFileSync(join(root, 'src', 'version.ts'), 'utf8')).toContain(
      "PART_VERSION = '1.0.0'",
    );
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## 1.0.0\n\nFirst release.\n\n',
    );
  });

  it('puts a new entry above the previous release', () => {
    expect(changelogWith('# Changelog\n\n## 1.0.0\n\nFirst.\n', '1.1.0', 'More.')).toBe(
      '# Changelog\n\n## 1.1.0\n\nMore.\n\n## 1.0.0\n\nFirst.\n',
    );
  });

  it('refuses a version that is not newer, one that is not semver, and missing notes', async () => {
    const root = part('1.0.0', '# Changelog\n\n## 1.0.0\n\nFirst.\n');
    await expect(prepareRelease(root, '1.0.0', 'Again.')).rejects.toThrow('not newer');
    await expect(prepareRelease(root, '0.9.0', 'Older.')).rejects.toThrow('not newer');
    await expect(prepareRelease(root, '2.0', 'Short.')).rejects.toThrow('not a release version');
    await expect(prepareRelease(root, '1.1.0', '  ')).rejects.toThrow('release notes');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.0.0"');
  });
});
