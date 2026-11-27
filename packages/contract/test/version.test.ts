import { describe, expect, it } from 'vitest';
import {
  CLIENT_KINDS,
  CONTRACT,
  FEATURES,
  MIN_CLIENT,
  MIN_SERVER,
  PART_NAME,
  PART_VERSION,
} from '../src/index.js';

describe('version', () => {
  it('exposes its name and version', () => {
    expect(PART_NAME).toBe('contract');
    expect(PART_VERSION).toBe('1.2.0');
  });

  it('[contract-001] declares contract 1, minimum clients and server, and a non-empty feature list', () => {
    expect(CONTRACT).toBe(1);
    expect(MIN_CLIENT).toEqual({ cli: 1, web: 1 });
    expect(MIN_SERVER).toBe(1);
    expect(CLIENT_KINDS).toEqual(['cli', 'web']);
    expect(FEATURES.length).toBeGreaterThan(0);
  });

  it('[contract-001] feature names are unique kebab-case', () => {
    expect(new Set(FEATURES).size).toBe(FEATURES.length);
    for (const name of FEATURES) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
