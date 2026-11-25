import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { machine, task } from '../src/db/schema/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import {
  CONTRACT_HEADERS,
  JSON_HEADERS,
  knownMachine,
  MACHINE_TOKEN,
  noLoginEnv,
} from './helpers.js';
import { envelope, seedUser } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const pglite = TARGETS[0]!;
const MINUTE = 60_000;

describe('schedule and feed routes on pglite', () => {
  let opened: OpenedTarget;
  let counter = 0;

  beforeAll(async () => {
    opened = await pglite.open();
  });

  afterAll(async () => {
    await opened.cleanup();
  });

  const board = async (env: Env = {}, existing?: string) => {
    counter += 1;
    const owner = existing ?? `routes${counter}`;
    if (existing === undefined) await seedUser(opened.database, owner);
    const app = await createServer(
      loadConfig(noLoginEnv({ NO_LOGIN_USER: owner, ...env })),
      {
        database: opened.database,
        credentials: {
          ...knownMachine,
          findMachine: async () => ({ owner, machineId: 'machine-1' }),
        },
        streams: createOpenStreams(),
        events: createMemoryEvents(),
      },
      { handlerSets: HANDLER_SETS },
    );
    await app.ready();
    const call = (side: 'machine' | 'client', command: string, payload: unknown = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/${side}/${command}`,
        headers: {
          ...JSON_HEADERS,
          ...CONTRACT_HEADERS,
          ...(side === 'machine' ? { authorization: `Bearer ${MACHINE_TOKEN}` } : {}),
        },
        payload: payload as object,
      });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: CONTRACT_HEADERS });
    return { app, owner, call, get };
  };

  it('[api-079] a machine adds, lists, pauses, edits and removes a schedule', async () => {
    const { call } = await board();
    const added = await call('machine', 'add-schedule', {
      id: 'nightly',
      title: envelope(),
      input: envelope(),
      everyMs: 5 * MINUTE,
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().schedule).toMatchObject({ id: 'nightly', paused: false, ended: false });
    expect(added.json().task).toMatchObject({ status: 'todo', scheduleId: 'nightly' });
    const listed = await call('machine', 'list-schedules');
    expect(listed.json().schedules.map((entry: { id: string }) => entry.id)).toEqual(['nightly']);
    const paused = await call('machine', 'update-schedule', { id: 'nightly', paused: true });
    expect(paused.json()).toMatchObject({ paused: true, occurrenceTaskId: null });
    const edited = await call('machine', 'edit-schedule', {
      id: 'nightly',
      title: envelope(50),
      input: envelope(51),
    });
    expect(edited.json()).toMatchObject({ pending: 'none', schedule: { title: envelope(50) } });
    const removed = await call('machine', 'remove-schedule', { id: 'nightly' });
    expect(removed.statusCode).toBe(200);
    const missing = await call('machine', 'remove-schedule', { id: 'nightly' });
    expect(missing.statusCode).toBe(404);
  });

  it('[api-079] a client lists by project, pauses, updates and removes a schedule', async () => {
    const { call, get } = await board();
    await call('machine', 'add-schedule', {
      id: 'daily',
      title: envelope(),
      input: envelope(),
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    const listed = await get('/api/client/schedules/list');
    expect(listed.statusCode).toBe(200);
    const [schedule] = listed.json().schedules;
    expect(schedule).toMatchObject({ id: 'daily', cron: '0 9 * * *' });
    const unknown = await get(
      '/api/client/schedules/list?project=7f1b8e28-3a52-4c3e-bb0e-7b7d6c4c1c11',
    );
    expect(unknown.json().schedules).toEqual([]);
    const paused = await call('client', 'schedules/set-paused', { id: 'daily', paused: true });
    expect(paused.json().paused).toBe(true);
    const updated = await call('client', 'schedules/update', {
      id: 'daily',
      title: envelope(),
      input: envelope(),
      place: null,
      priority: 'high',
      model: null,
      autoDone: false,
      repeat: { everyMs: 10 * MINUTE },
      runsLeft: null,
      until: null,
      maxConcurrent: null,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      pending: 'none',
      schedule: { priority: 'high', everyMs: 10 * MINUTE },
    });
    const removed = await call('client', 'schedules/remove', { id: 'daily' });
    expect(removed.statusCode).toBe(200);
  });

  it('[api-075] a client creates a repeating task as a schedule with its first occurrence', async () => {
    const { call } = await board();
    const every = await call('client', 'tasks/create', {
      id: 'repeating',
      title: envelope(),
      input: envelope(),
      when: { every: 5 * MINUTE, times: 3 },
    });
    expect(every.statusCode).toBe(200);
    expect(every.json().task).toMatchObject({ status: 'todo', scheduleId: 'repeating' });
    await call('client', 'tasks/create', {
      id: 'chained',
      title: envelope(),
      input: envelope(),
      when: { after: { scheduleId: 'repeating', delayMs: 0 } },
    }).then((answer) => expect(answer.json()).toEqual({ task: null }));
  });

  it('[api-023] with scheduling off the schedule routes answer not-enabled and a claim creates no occurrence', async () => {
    const on = await board();
    const added = await on.call('machine', 'add-schedule', {
      id: 'sched',
      title: envelope(),
      input: envelope(),
      everyMs: MINUTE,
      startAt: new Date(Date.now() - 30 * MINUTE).toISOString(),
    });
    const occurrenceId = added.json().task.id as string;

    const off = await board({ SCHEDULING: 'off' }, on.owner);
    for (const [side, command] of [
      ['machine', 'add-schedule'],
      ['machine', 'list-schedules'],
      ['machine', 'update-schedule'],
      ['machine', 'edit-schedule'],
      ['machine', 'remove-schedule'],
      ['client', 'schedules/set-paused'],
      ['client', 'schedules/update'],
      ['client', 'schedules/remove'],
    ] as const) {
      const answer = await off.call(side, command, {});
      expect(answer.statusCode, command).toBe(404);
      expect(answer.json().error.code, command).toBe('not-enabled');
    }
    expect((await off.get('/api/client/schedules/list')).json().error.code).toBe('not-enabled');
    const repeating = await off.call('client', 'tasks/create', {
      id: 'repeat-off',
      title: envelope(),
      input: envelope(),
      when: { every: 5 * MINUTE },
    });
    expect(repeating.json().error.code).toBe('not-enabled');

    const claimed = await off.call('machine', 'claim-task', {
      id: occurrenceId,
      machine: 'machine-1',
    });
    expect(claimed.statusCode).toBe(200);
    const rows = await opened.database.withOwner(on.owner, (tx) =>
      tx.select({ id: task.id }).from(task).where(eq(task.scheduleId, 'sched')),
    );
    expect(rows).toHaveLength(1);
  });
  it('[api-023] with feeds off the feed routes answer not-enabled and with feeds on they queue requests', async () => {
    const off = await board({ FEEDS: 'off' });
    expect((await off.get('/api/client/feeds/list')).json().error.code).toBe('not-enabled');
    const refused = await off.call('client', 'feeds/request', {
      machine: 'machine-1',
      action: 'run',
      id: 'abcdef0123456789',
    });
    expect(refused.json().error.code).toBe('not-enabled');

    const on = await board();
    await opened.database.withOwner(on.owner, (tx) =>
      tx.insert(machine).values({ id: 'machine-1', tokenHash: 'a'.repeat(64) }),
    );
    const request = { machine: 'machine-1', action: 'run', id: 'abcdef0123456789' };
    expect((await on.call('client', 'feeds/request', request)).statusCode).toBe(200);
    await on.call('client', 'feeds/request', request);
    expect((await on.get('/api/client/feeds/list')).json().machines).toEqual([]);
    const unknown = await on.call('client', 'feeds/request', { ...request, machine: 'nobody' });
    expect(unknown.statusCode).toBe(404);
  });
});
