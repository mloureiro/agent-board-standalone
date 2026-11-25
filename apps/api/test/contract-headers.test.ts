import { CONTRACT, MIN_CLIENT, formatClientHeader, routes } from '@agent-board/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { PART_VERSION } from '../src/version.js';
import {
  CONTRACT_HEADERS,
  JSON_HEADERS,
  MACHINE_TOKEN,
  boot,
  knownMachine,
  noLoginEnv,
  type TestBoard,
} from './helpers.js';

const boards: TestBoard[] = [];
const started = async (options?: Parameters<typeof boot>[1]): Promise<TestBoard> => {
  const board = await boot(noLoginEnv(), options);
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.app.close()));
});

const machineHeaders = (extra: Record<string, string>): Record<string, string> => ({
  ...JSON_HEADERS,
  authorization: `Bearer ${MACHINE_TOKEN}`,
  ...extra,
});

describe('contract headers', () => {
  it('[api-098] a client route without x-board-contract gets 412 naming the missing header', async () => {
    const { app } = await started();
    const answer = await app.inject({ url: '/api/client/me' });
    expect(answer.statusCode).toBe(412);
    expect(answer.json().error.code).toBe('upgrade-required');
    expect(answer.json().error.message).toMatch(/did not send its contract version/i);
  });

  it('[api-098] a machine route without x-board-contract gets the same 412, even with a valid token', async () => {
    const { app } = await started({ credentials: knownMachine });
    const answer = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: machineHeaders({}),
      payload: '{}',
    });
    expect(answer.statusCode).toBe(412);
    expect(answer.json().error.message).toMatch(/did not send its contract version/i);
  });

  it('[api-098] a client below the minimum gets 412 with an upgrade hint naming both versions', async () => {
    const { app } = await started({ credentials: knownMachine });
    const web = await app.inject({
      url: '/api/client/me',
      headers: {
        'x-board-contract': String(MIN_CLIENT.web - 1),
        'x-board-client': formatClientHeader('web', '3.1.4'),
      },
    });
    expect(web.statusCode).toBe(412);
    expect(web.json().error.code).toBe('upgrade-required');
    expect(web.json().error.message).toMatch(/upgrade/i);
    expect(web.json().error.message).toContain('3.1.4');
    expect(web.json().error.message).toContain(PART_VERSION);

    const cli = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: machineHeaders({ 'x-board-contract': String(MIN_CLIENT.cli - 1) }),
      payload: '{}',
    });
    expect(cli.statusCode).toBe(412);
    expect(cli.json().error.message).toMatch(/upgrade/i);
  });

  it('[api-098] a malformed contract header gets 412', async () => {
    const { app } = await started();
    for (const value of ['abc', '1.5', '-1', '']) {
      const answer = await app.inject({
        url: '/api/client/me',
        headers: { 'x-board-contract': value },
      });
      expect(answer.statusCode, value).toBe(412);
    }
  });

  it('[api-098] the contract check comes before authentication and before the body is read', async () => {
    const { app } = await started();
    const answer = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, 'x-board-contract': '0' },
      payload: '{not json',
    });
    expect(answer.statusCode).toBe(412);
  });

  it('[api-098] a client at or above the minimum passes, and the client kind in the header decides the minimum', async () => {
    const { app } = await started();
    const current = await app.inject({
      url: '/api/client/me',
      headers: { 'x-board-contract': String(CONTRACT), 'x-board-client': 'web/1.0.0' },
    });
    expect(current.statusCode).toBe(200);
    const newer = await app.inject({
      url: '/api/client/me',
      headers: { 'x-board-contract': String(CONTRACT + 5) },
    });
    expect(newer.statusCode).toBe(200);
    const garbageClient = await app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, 'x-board-client': 'nonsense' },
    });
    expect(garbageClient.statusCode).toBe(200);
  });

  it('[api-098] public routes, /healthz and unknown paths need no contract header', async () => {
    const { app } = await started();
    expect((await app.inject({ url: '/api/version' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/config' })).statusCode).not.toBe(412);
    expect((await app.inject({ url: '/api/client/unknown-route' })).statusCode).toBe(404);
  });
});

describe('route table', () => {
  it('[api-021] serves exactly the routes the contract declares', async () => {
    const { app } = await started();
    for (const route of routes) {
      expect(app.hasRoute({ method: route.method, url: route.path }), route.name).toBe(true);
    }
  });
});
