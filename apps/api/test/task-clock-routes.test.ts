import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../src/clock.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import {
  CONTRACT_HEADERS,
  JSON_HEADERS,
  MACHINE_TOKEN,
  knownMachine,
  noLoginEnv,
} from './helpers.js';
import { envelope, seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const pglite = TARGETS[0]!;
const HOUR_MS = 3_600_000;

describe('task routes read the server clock', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;
  const clock = fixedClock(new Date());

  const post = (scope: 'machine' | 'client', command: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/${scope}/${command}`,
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        ...(scope === 'machine' ? { authorization: `Bearer ${MACHINE_TOKEN}` } : {}),
      },
      payload,
    });

  beforeAll(async () => {
    opened = await pglite.open();
    await seedUser(opened.database, 'owner');
    app = await createServer(
      loadConfig(noLoginEnv()),
      {
        database: opened.database,
        credentials: knownMachine,
        streams: createOpenStreams(),
        events: createMemoryEvents(),
      },
      { clock, handlerSets: HANDLER_SETS },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await opened.cleanup();
  });

  it('[api-057] a claim is refused before the start time and accepted once the clock passes it', async () => {
    const notBefore = new Date(Date.now() + HOUR_MS).toISOString();
    const added = await post('machine', 'add-task', {
      id: 'clocked-claim',
      title: envelope(41),
      input: envelope(42),
      notBefore,
    });
    expect(added.statusCode).toBe(200);
    const early = await post('machine', 'claim-task', {
      id: 'clocked-claim',
      machine: 'machine-1',
    });
    expect(early.statusCode).toBe(409);

    clock.set(new Date(Date.now() + 2 * HOUR_MS));
    const claimed = await post('machine', 'claim-task', {
      id: 'clocked-claim',
      machine: 'machine-1',
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ status: 'running' });
  });

  it('[api-064] a client take-back is accepted once the clock shows twenty quiet minutes', async () => {
    clock.set(new Date());
    await post('machine', 'add-task', {
      id: 'clocked-take-back',
      title: envelope(41),
      input: envelope(42),
    });
    await post('machine', 'claim-task', { id: 'clocked-take-back', machine: 'machine-1' });
    const early = await post('client', 'tasks/take-back', { id: 'clocked-take-back' });
    expect(early.statusCode).toBe(409);

    clock.set(new Date(Date.now() + 21 * 60_000));
    const taken = await post('client', 'tasks/take-back', { id: 'clocked-take-back' });
    expect(taken.statusCode).toBe(200);
  });
});
