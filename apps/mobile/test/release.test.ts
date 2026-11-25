import { describe, expect, it } from 'vitest';
import { releaseProblems, type ReleaseInputs } from '../scripts/release-check.js';

const ready: ReleaseInputs = {
  target: '1.0.0',
  packageVersion: '1.0.0',
  sourceVersion: '1.0.0',
  tauriVersion: '1.0.0',
  cargoVersion: '1.0.0',
  changelog: '# Changelog\n\n## 1.0.0\n\nFirst release.\n',
};

describe('mobile release check', () => {
  it('[mobile-001] passes when the package, source, Tauri and Cargo versions and the changelog agree', () => {
    expect(releaseProblems(ready)).toEqual([]);
  });

  it('[mobile-001] names every file whose version differs and a missing changelog heading', () => {
    const problems = releaseProblems({
      ...ready,
      tauriVersion: '0.1.0',
      cargoVersion: '0.0.0',
      changelog: '## 0.0.0\n',
    });
    expect(problems).toEqual([
      'src-tauri/tauri.conf.json is 0.1.0, not 1.0.0',
      'src-tauri/Cargo.toml is 0.0.0, not 1.0.0',
      'CHANGELOG.md has no "## 1.0.0" heading',
    ]);
  });
});
