import { describe, expect, it } from 'vitest';

import { useBoard } from '../src/harness/vitest.js';

describe('[harness] API', () => {
  const harness = useBoard({ parts: ['api'], features: [], auth: 'no-login' });

  it('[harness] API answers /healthz', async () => {
    const response = await fetch(`${harness.board.url}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('[harness] API restart keeps the data folder', async () => {
    const { api, database, url } = harness.board;
    await api.restart();
    expect(harness.board.url).toBe(url);
    expect(harness.board.database.dataDir).toBe(database.dataDir);
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
  });
});
