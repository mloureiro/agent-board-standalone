import { describe, expect, it } from 'vitest';
import { PART_NAME, PART_VERSION } from '../src/index.js';

describe('sealing', () => {
  it('exposes its name and version', () => {
    expect(PART_NAME).toBe('sealing');
    expect(PART_VERSION).toBe('1.0.0');
  });
});
