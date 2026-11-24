import { describe, expect, it } from 'vitest';
import { MIN_PASSPHRASE_LENGTH, normalizePassphrase, passphraseProblem } from '../src/index.js';

describe('passphrase', () => {
  it('[sealing-004] a passphrase shorter than 14 characters after normalisation is refused', () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(14);
    expect(passphraseProblem('a'.repeat(13))).not.toBeNull();
    expect(passphraseProblem(`   ${'a'.repeat(13)}   `)).not.toBeNull();
    expect(passphraseProblem('a'.repeat(14))).toBeNull();
    expect(passphraseProblem('😀'.repeat(14))).toBeNull();
    expect(passphraseProblem('😀'.repeat(13))).not.toBeNull();
  });

  it('[sealing-004] normalisation trims whitespace and applies NFKC', () => {
    expect(normalizePassphrase('　ｃｏｒｒｅｃｔ　ｈｏｒｓｅ\n')).toBe('correct horse');
    expect(normalizePassphrase('é')).toBe('é');
  });
});
