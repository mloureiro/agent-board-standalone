import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContract } from '../scripts/build.js';
import { checkAddress } from '../src/address/rule.js';
import {
  ADDRESS_CASES,
  checkServerAddress,
  PINNED_LAN_ENABLED,
  type AddressCase,
} from '../src/index.js';

const run = (entry: AddressCase) => {
  const options =
    entry.pinnedFingerprint === undefined
      ? undefined
      : { pinnedFingerprint: entry.pinnedFingerprint };
  return entry.pinnedLanEnabled
    ? checkAddress(entry.input, options, true)
    : checkServerAddress(entry.input, options);
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('address', () => {
  it('[contract-007] pinned LAN stays off', () => {
    expect(PINNED_LAN_ENABLED).toBe(false);
  });

  for (const entry of ADDRESS_CASES) {
    it(`[contract-007] address case: ${entry.input}${entry.pinnedFingerprint ? ' (pinned)' : ''}${entry.conditional ? ' (flag on)' : ''}`, () => {
      expect(run(entry)).toEqual(entry.expect);
    });
  }

  it('[contract-007] address cases from the emitted JSON give the same results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contract-build-'));
    dirs.push(dir);
    await buildContract(dir);
    const emitted = JSON.parse(
      await readFile(join(dir, 'cases', 'address.json'), 'utf8'),
    ) as AddressCase[];
    expect(emitted).toEqual(ADDRESS_CASES);
    for (const entry of emitted) expect(run(entry)).toEqual(entry.expect);
  });
});
