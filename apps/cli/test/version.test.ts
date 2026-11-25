import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PART_NAME, PART_VERSION } from '../src/index.js';

describe('cli', () => {
  it('exposes its name', () => {
    expect(PART_NAME).toBe('cli');
  });

  it('declares the version of its package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(PART_VERSION).toBe(manifest.version);
  });
});
