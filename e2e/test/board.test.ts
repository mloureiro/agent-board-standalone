import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBoard, missingFeatures, resolveDatabaseKind } from '../src/harness/board.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { featureSkipReason, partSkipReason } from '../src/harness/skip.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');

describe('missingFeatures', () => {
  it('lists declared features the server lacks, with their labels', () => {
    const missing = missingFeatures(['projects', 'forks', 'legacy-dirs'], ['projects']);
    expect(missing).toEqual([
      { name: 'forks', label: 'forks' },
      { name: 'legacy-dirs', label: 'legacy directory conversion' },
    ]);
    expect(featureSkipReason(missing)).toBe('missing feature: forks (forks)');
  });

  it('is empty when the server serves every declared feature', () => {
    expect(missingFeatures(['projects'], ['projects', 'forks'])).toEqual([]);
  });
});

describe('part skip reason', () => {
  it('names the first missing part and its path', () => {
    expect(partSkipReason([{ part: 'api', path: 'apps/api/dist/main.js' }])).toBe(
      'part missing: api (apps/api/dist/main.js)',
    );
  });
});

describe('resolveDatabaseKind', () => {
  const url = { E2E_POSTGRES_URL: 'postgres://localhost/postgres' };

  it('uses postgres only when allowed and configured', () => {
    expect(resolveDatabaseKind({}, true, url)).toBe('postgres');
    expect(resolveDatabaseKind({}, false, url)).toBe('pglite');
    expect(resolveDatabaseKind({}, true, {})).toBe('pglite');
  });

  it('lets a file force PGlite', () => {
    expect(resolveDatabaseKind({ database: 'pglite' }, true, url)).toBe('pglite');
  });
});

describe('createBoard', () => {
  const stops: (() => Promise<void>)[] = [];
  const originalBin = process.env.AGENT_BOARD_API_BIN;

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    if (originalBin === undefined) delete process.env.AGENT_BOARD_API_BIN;
    else process.env.AGENT_BOARD_API_BIN = originalBin;
  });

  it('yields missing feature: <name> (<label>) for a feature the version answer lacks', async () => {
    process.env.AGENT_BOARD_API_BIN = fakeApi;
    const board = await createBoard({
      parts: ['api'],
      features: ['projects', 'forks'],
      auth: 'no-login',
      database: 'pglite',
      env: { FAKE_API_FEATURES: JSON.stringify(['projects']) },
    });
    stops.push(() => board.stop());
    expect(board.serverFeatures).toEqual(['projects']);
    expect(featureSkipReason(board.missingFeatures)).toBe('missing feature: forks (forks)');
    expect(featureSkipReason(board.missing(['watches']))).toBe(
      'missing feature: watches (watches)',
    );
  });

  it('refuses a declaration without the api part', async () => {
    await expect(
      createBoard({ parts: ['cli'], features: [], auth: 'no-login', database: 'pglite' }),
    ).rejects.toThrow(/api part/);
  });
});
