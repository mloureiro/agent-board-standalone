import { describe, expect, it } from 'vitest';

import { releaseProblems, type ReleaseInputs } from '../scripts/release-check.js';

const ready: ReleaseInputs = {
  target: '1.0.0',
  packageVersion: '1.0.0',
  sourceVersion: '1.0.0',
  changelog: '# Changelog\n\n## 1.0.0\n\nNotes\n',
  built: { version: '1.0.0', contract: 1 },
  contract: 1,
};

describe('release check for web-v1.0.0', () => {
  it('passes when the versions, the changelog and the built version file agree', () => {
    expect(releaseProblems(ready)).toEqual([]);
  });

  it('names every disagreement', () => {
    const problems = releaseProblems({
      ...ready,
      packageVersion: '0.0.0',
      sourceVersion: '0.0.1',
      changelog: '# Changelog\n',
      built: { version: '0.0.0', contract: 2 },
    });
    expect(problems).toHaveLength(5);
  });

  it('refuses a release before the build wrote dist/version.json', () => {
    expect(releaseProblems({ ...ready, built: null })).toEqual([
      'dist/version.json is missing: run the build first',
    ]);
  });
});
