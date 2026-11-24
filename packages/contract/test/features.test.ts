import { describe, expect, it } from 'vitest';
import { FEATURE_LABELS, FEATURES, isFeature } from '../src/index.js';

describe('features', () => {
  it('[contract-005] every feature has a label', () => {
    for (const feature of FEATURES) expect(FEATURE_LABELS[feature].length).toBeGreaterThan(0);
    expect(Object.keys(FEATURE_LABELS).sort()).toEqual([...FEATURES].sort());
  });

  it('[contract-005] isFeature refuses a name not in FEATURES', () => {
    expect(isFeature('projects')).toBe(true);
    expect(isFeature('teleport')).toBe(false);
    expect(isFeature(3)).toBe(false);
  });
});
