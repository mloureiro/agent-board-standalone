import { describe, expect, it } from 'vitest';
import { PART_NAME, PART_VERSION } from '../src/index.js';

describe('migrate', () => {
  it('exposes its name and version', () => {
    expect(PART_NAME).toBe('migrate');
    expect(PART_VERSION).toBe('0.0.0');
  });
});
