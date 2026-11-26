import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const pglite = TARGETS[0]!;

describe('a machine token on the client routes of a no-login server', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;

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
      { handlerSets: HANDLER_SETS },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await opened.cleanup();
  });

  const setGrant = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/client/machines/set-grant',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, ...headers },
      payload: { name: 'machine-1', grant: true },
    });

  it('[api-119] a machine token cannot set the grant', async () => {
    const refused = await setGrant({ authorization: `Bearer ${MACHINE_TOKEN}` });
    expect(refused.statusCode).toBe(401);
  });

  it('[api-029] a request with no credential still acts as the configured user', async () => {
    const answered = await setGrant({});
    expect(answered.statusCode).not.toBe(401);
  });
});
