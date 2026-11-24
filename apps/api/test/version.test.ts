import { describe, expect, it } from 'vitest';
import { PART_NAME, PART_VERSION } from '../src/index.js';

describe('api', () => {
  it('exposes its name and version', () => {
    expect(PART_NAME).toBe('api');
    expect(PART_VERSION).toBe('0.0.0');
  });
});
