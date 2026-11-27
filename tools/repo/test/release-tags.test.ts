import { describe, expect, it } from 'vitest';
import { planTags, type PartInfo } from '../src/release-tags.js';

function part(overrides: Partial<PartInfo> = {}): PartInfo {
  return {
    name: 'contract',
    version: '1.0.0',
    changelog: '# Changelog\n\n## 1.0.0\n\nFirst release\n',
    ranges: {},
    ...overrides,
  };
}

describe('planTags', () => {
  it('[repo-005] plans a tag for a versioned part without one', () => {
    expect(planTags([part()], new Set()).map((plan) => plan.tag)).toEqual(['contract-v1.0.0']);
  });

  it('[repo-005] skips a part at 0.0.0', () => {
    const unreleased = part({ version: '0.0.0', changelog: '## 0.0.0' });
    expect(planTags([unreleased], new Set())).toEqual([]);
  });

  it('[repo-005] skips a part whose tag exists', () => {
    expect(planTags([part()], new Set(['contract-v1.0.0']))).toEqual([]);
  });

  it('[repo-005] refuses a version missing from the changelog', () => {
    expect(() => planTags([part({ changelog: '# Changelog\n\n## 0.9.0\n' })], new Set())).toThrow(
      'contract: CHANGELOG.md has no "## 1.0.0" heading',
    );
  });

  it('[repo-005] message states the contract and sealing ranges', () => {
    const [plan] = planTags(
      [part({ name: 'api', ranges: { contract: '^1.0.0', sealing: '^1.2.0' } })],
      new Set(),
    );
    expect(plan?.message).toBe(
      'api 1.0.0\nsupports @rumo/contract ^1.0.0\nsupports @rumo/sealing ^1.2.0',
    );
  });
});
