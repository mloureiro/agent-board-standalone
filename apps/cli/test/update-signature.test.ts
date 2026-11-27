import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { updateKeyDefine } from '../scripts/bundle.ts';
import { downloadVerified } from '../src/update/download.js';
import type { Release } from '../src/update/release-source.js';
import { parsePublicKey, verifySignature } from '../src/update/signature.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/minisign');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const KEY = fixture('test-only.pub');
const SUMS = readFileSync(path.join(FIXTURES, 'SHA256SUMS'));
const PREHASHED = fixture('SHA256SUMS.prehashed.minisig');
const LEGACY = fixture('SHA256SUMS.legacy.minisig');
const OTHER_KEY = fixture('SHA256SUMS.other-key.minisig');
const BINARY = 'binary of 9.9.9';

const replaceLine = (text: string, at: number, line: string): string => {
  const lines = text.split('\n');
  lines[at] = line;
  return lines.join('\n');
};

describe('minisign signature', () => {
  const key = parsePublicKey(KEY);

  it('reads the key id the way minisign prints it', () => {
    expect(key.keyId).toBe('568D210FAE45B160');
  });

  it.each([
    ['prehashed ED', PREHASHED],
    ['legacy Ed', LEGACY],
  ])('accepts a %s signature and returns its trusted comment', (_, signature) => {
    expect(verifySignature(key, SUMS, signature)).toEqual({
      keyId: '568D210FAE45B160',
      trustedComment: 'cli-v9.9.9',
    });
  });

  it.each([
    ['a tampered message', PREHASHED, Buffer.from(`${SUMS.toString()}x`), /does not match/],
    ['a tampered legacy message', LEGACY, Buffer.from(`${SUMS.toString()}x`), /does not match/],
    [
      'a tampered trusted comment',
      replaceLine(PREHASHED, 2, 'trusted comment: cli-v9.9.10'),
      SUMS,
      /trusted comment/,
    ],
    ['another key', OTHER_KEY, SUMS, /made with key .* not with 568D210FAE45B160/],
    ['garbage', 'not a signature at all\n', SUMS, /not a minisign signature/],
    ['a line that is not base64', replaceLine(PREHASHED, 1, 'RUS!!'), SUMS, /not base64/],
    [
      'a signature of the wrong length',
      replaceLine(PREHASHED, 1, Buffer.alloc(40).toString('base64')),
      SUMS,
      /wrong length/,
    ],
    [
      'an unknown algorithm',
      replaceLine(
        PREHASHED,
        1,
        Buffer.concat([
          Buffer.from('XX'),
          Buffer.from(PREHASHED.split('\n')[1] ?? '', 'base64').subarray(2),
        ]).toString('base64'),
      ),
      SUMS,
      /unknown algorithm "XX"/,
    ],
    ['an oversized file', `${PREHASHED}${'x'.repeat(5000)}`, SUMS, /too large/],
  ])('refuses %s', (_, signature, message, error) => {
    expect(() => verifySignature(key, message, signature)).toThrow(error);
  });

  it.each([
    ['garbage', 'nope', /not a minisign public key/],
    ['a short key', `untrusted comment: k\n${Buffer.alloc(10).toString('base64')}\n`, /length/],
  ])('refuses %s as a public key', (_, text, error) => {
    expect(() => parsePublicKey(text)).toThrow(error);
  });
});

describe('downloadVerified with a signature key', () => {
  const runtimes: TestRuntime[] = [];

  afterEach(() => {
    for (const test of runtimes.splice(0)) test.dispose();
  });

  const BASE = 'https://releases.test/cli-v9.9.9';

  function setup(assets: Record<string, string>): {
    test: TestRuntime;
    release: Release;
  } {
    const test = testRuntime({
      fetch: (async (input: string | URL | Request) => {
        const name = String(input).slice(BASE.length + 1);
        const body = assets[name];
        return body === undefined ? new Response('', { status: 404 }) : new Response(body);
      }) as typeof fetch,
    });
    runtimes.push(test);
    return {
      test,
      release: {
        version: '9.9.9',
        tag: 'cli-v9.9.9',
        assets: Object.keys(assets).map((name) => ({ name, url: `${BASE}/${name}` })),
      },
    };
  }

  it('installs a release whose checksums carry a valid signature', async () => {
    const { test, release } = setup({
      'rumo-linux-x64': BINARY,
      SHA256SUMS: SUMS.toString(),
      'SHA256SUMS.minisig': PREHASHED,
    });
    const downloaded = await downloadVerified(
      test.rt,
      release,
      'linux-x64',
      test.path('staging'),
      KEY,
    );
    expect(downloaded.signedBy).toBe('568D210FAE45B160');
    expect(readFileSync(downloaded.file, 'utf8')).toBe(BINARY);
  });

  it.each([
    [
      'has no signature',
      {},
      /cli-v9.9.9 is not signed with the key this rumo trusts.*no SHA256SUMS.minisig/,
    ],
    [
      'is signed by another key',
      { 'SHA256SUMS.minisig': OTHER_KEY },
      /not signed with the key this rumo trusts \(568D210FAE45B160\)/,
    ],
  ])('installs nothing when the release %s', async (_, extra, error) => {
    const { test, release } = setup({
      'rumo-linux-x64': BINARY,
      SHA256SUMS: SUMS.toString(),
      ...extra,
    });
    await expect(
      downloadVerified(test.rt, release, 'linux-x64', test.path('staging'), KEY),
    ).rejects.toThrow(error);
    expect(existsSync(test.path('staging'))).toBe(false);
  });

  it('installs nothing when the signature was made for another tag', async () => {
    const { test, release } = setup({
      'rumo-linux-x64': BINARY,
      SHA256SUMS: SUMS.toString(),
      'SHA256SUMS.minisig': PREHASHED,
    });
    await expect(
      downloadVerified(
        test.rt,
        { ...release, version: '9.9.10', tag: 'cli-v9.9.10' },
        'linux-x64',
        test.path('staging'),
        KEY,
      ),
    ).rejects.toThrow(/cli-v9.9.10 is not signed.*made for cli-v9.9.9/);
  });

  it('checks the checksum alone when no key is built in', async () => {
    const { test, release } = setup({ 'rumo-linux-x64': BINARY, SHA256SUMS: SUMS.toString() });
    const downloaded = await downloadVerified(
      test.rt,
      release,
      'linux-x64',
      test.path('staging'),
      null,
    );
    expect(downloaded.signedBy).toBeNull();
  });
});

describe('the build-time update key', () => {
  it('is defined only when the key file exists', () => {
    expect(updateKeyDefine(path.join(FIXTURES, 'absent.pub'))).toEqual({});
    expect(updateKeyDefine(path.join(FIXTURES, 'test-only.pub'))).toEqual({
      __BOARD_UPDATE_KEY__: JSON.stringify(KEY),
    });
  });
});
