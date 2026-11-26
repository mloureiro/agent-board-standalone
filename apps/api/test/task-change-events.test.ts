import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HANDLER_SETS } from '../src/handlers/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createMemoryEvents, type EventMessage } from '../src/modules/events/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS, knownMachine, noLoginEnv } from './helpers.js';
import { envelope, seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const pglite = TARGETS[0]!;

describe('task writes announce the project they changed', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;
  const heard: EventMessage[] = [];

  beforeAll(async () => {
    opened = await pglite.open();
    ({ projectId } = await seedUser(opened.database, 'owner'));
    const events = createMemoryEvents();
    await events.subscribe('owner', (message) => heard.push(message));
    app = await createServer(
      loadConfig(noLoginEnv()),
      {
        database: opened.database,
        credentials: knownMachine,
        streams: createOpenStreams(),
        events,
      },
      { handlerSets: HANDLER_SETS },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await opened.cleanup();
  });

  it('[api-104] a client create raises changed for the project of the new task', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/client/tasks/create',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: { id: 'announced-1', title: envelope(41), input: envelope(42), when: 'backlog' },
    });
    expect(created.statusCode).toBe(200);
    expect(heard).toContainEqual({ kind: 'change', projectId });
    expect(heard).not.toContainEqual({ kind: 'change' });
  });
});
