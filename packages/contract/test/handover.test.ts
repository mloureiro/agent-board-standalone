import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContract } from '../scripts/build.js';
import {
  buildHandover,
  CLIENT_APP_BUNDLE_ID,
  HANDOVER_CASES,
  parseHandover,
  type HandoverCase,
} from '../src/index.js';

const check = (entry: HandoverCase): void => {
  if ('expect' in entry) expect(parseHandover(entry.link)).toEqual(entry.expect);
  else expect(buildHandover(entry.url)).toBe(entry.link);
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('handover', () => {
  for (const entry of HANDOVER_CASES) {
    it(`[contract-012] handover case: ${entry.link}`, () => {
      check(entry);
    });
  }

  it('[contract-012] buildHandover round-trips through parseHandover', () => {
    for (const url of ['http://localhost:4000/', 'https://127.0.0.1/x?y=1', 'http://[::1]:9/']) {
      expect(parseHandover(buildHandover(url))).toEqual({ ok: true, url: new URL(url).href });
    }
  });

  it('[contract-012] parseHandover refuses non-loopback, credentials and unknown v', () => {
    const link = (v: string, url: string) =>
      `agentboard://open?v=${v}&url=${encodeURIComponent(url)}`;
    expect(parseHandover(link('1', 'http://example.com/'))).toEqual({
      ok: false,
      problem: 'not-loopback',
    });
    expect(parseHandover(link('1', 'http://a:b@localhost/'))).toEqual({
      ok: false,
      problem: 'credentials',
    });
    expect(parseHandover(link('9', 'http://localhost/'))).toEqual({
      ok: false,
      problem: 'unknown-version',
    });
    expect(() => buildHandover('http://example.com/')).toThrow(TypeError);
  });

  it('[contract-012] handover cases and bundle id from the emitted JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contract-build-'));
    dirs.push(dir);
    await buildContract(dir);
    const read = async (name: string): Promise<unknown> =>
      JSON.parse(await readFile(join(dir, 'cases', name), 'utf8'));
    const emitted = (await read('handover.json')) as HandoverCase[];
    expect(emitted).toEqual(HANDOVER_CASES);
    for (const entry of emitted) check(entry);
    expect(await read('bundle-id.json')).toEqual({ bundleId: CLIENT_APP_BUNDLE_ID });
    expect(CLIENT_APP_BUNDLE_ID).toBe('com.mloureiro.agent-board-client');
  });
});
