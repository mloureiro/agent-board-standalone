import { describe, expect, it } from 'vitest';
import {
  COMMON_ERRORS,
  ERROR_CODES,
  ERROR_STATUS,
  errorBody,
  listOfKnown,
  oneOfKnown,
} from '../src/index.js';

describe('errors and enums', () => {
  it('[contract-006] every error code maps to one status; not-enabled is below 500', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) expect(Number.isInteger(ERROR_STATUS[code])).toBe(true);
    expect(ERROR_STATUS['not-enabled']).toBeLessThan(500);
    for (const codes of Object.values(COMMON_ERRORS)) {
      for (const code of codes) expect(ERROR_CODES).toContain(code);
    }
  });

  it('[contract-006] errorBody refuses extra keys and unknown codes', () => {
    expect(errorBody.safeParse({ error: { code: 'not-found', message: 'x' } }).success).toBe(true);
    expect(errorBody.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
    expect(
      errorBody.safeParse({ error: { code: 'not-found', message: 'x', extra: 1 } }).success,
    ).toBe(false);
    expect(
      errorBody.safeParse({ error: { code: 'not-found', message: 'x' }, more: 1 }).success,
    ).toBe(false);
  });

  it('[contract-006] listOfKnown drops unknown values; oneOfKnown refuses them', () => {
    const values = ['a', 'b'] as const;
    expect(listOfKnown(values).parse(['a', 'z', 'b'])).toEqual(['a', 'b']);
    expect(oneOfKnown(values).safeParse('a').success).toBe(true);
    expect(oneOfKnown(values).safeParse('z').success).toBe(false);
  });
});
