import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContract } from '../scripts/build.js';

describe('build', () => {
  it('[contract-007] buildContract writes the three case tables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contract-build-'));
    try {
      await buildContract(dir);
      expect((await readdir(join(dir, 'cases'))).sort()).toEqual([
        'address.json',
        'bundle-id.json',
        'handover.json',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
