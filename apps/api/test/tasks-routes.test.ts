import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  knownMachine,
  MACHINE_TOKEN,
  noLoginEnv,
  JSON_HEADERS,
  CONTRACT_HEADERS,
} from './helpers.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { loadConfig } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createOpenStreams } from '../src/streams.js';
import { envelope, seedUser, uniqueBlind } from './integration/support.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';

const pglite = TARGETS[0]!;

describe('task routes on pglite', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;

  const machine = (command: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: payload as object,
    });
  const client = (command: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/client/${command}`,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: payload as object,
    });

  beforeAll(async () => {
    opened = await pglite.open();
    await seedUser(opened.database, 'owner');
    app = await createServer(
      loadConfig(noLoginEnv()),
      { database: opened.database, credentials: knownMachine, streams: createOpenStreams() },
      { handlerSets: HANDLER_SETS },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('[api-055] add-task answers created false for a known dedupe key', async () => {
    const draft = { title: envelope(), input: envelope(), dedupeKey: uniqueBlind() };
    const first = await machine('add-task', { id: 'dup-1', ...draft });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: true, task: { id: 'dup-1', status: 'todo' } });
    const again = await machine('add-task', { id: 'dup-2', ...draft });
    expect(again.json()).toMatchObject({ created: false, task: { id: 'dup-1' } });
  });

  it('[api-057] claim-task is refused for another machine than the token and answers the running task', async () => {
    await machine('add-task', { id: 'claim-1', title: envelope(), input: envelope() });
    const other = await machine('claim-task', { id: 'claim-1', machine: 'machine-2' });
    expect(other.statusCode).toBe(403);
    const claimed = await machine('claim-task', { id: 'claim-1', machine: 'machine-1' });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ status: 'running', machine: 'machine-1' });
    const second = await machine('claim-task', { id: 'claim-1', machine: 'machine-1' });
    expect(second.statusCode).toBe(409);
  });

  it('[api-060] update-task with a stale run answers 409 and an expected status mismatch answers 409', async () => {
    await machine('add-task', { id: 'fence-1', title: envelope(), input: envelope() });
    const claimed = (await machine('claim-task', { id: 'fence-1', machine: 'machine-1' })).json();
    const stale = await machine('update-task', {
      id: 'fence-1',
      run: 'stale-run-identifier',
      sessionId: '5c1c3d9e-0f6a-4b43-9a0b-3f3b4a6a9e11',
    });
    expect(stale.statusCode).toBe(409);
    const mismatch = await machine('update-task', {
      id: 'fence-1',
      expect: 'todo',
      priority: 'high',
    });
    expect(mismatch.statusCode).toBe(409);
    const ok = await machine('update-task', {
      id: 'fence-1',
      run: claimed.run,
      expect: 'running',
      priority: 'high',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ priority: 'high', status: 'running' });
  });

  it('[api-062] the client list shows tasks in column order and closed tasks only when asked', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/client/tasks/list?closed=false',
      headers: CONTRACT_HEADERS,
    });
    expect(listed.statusCode).toBe(200);
    const ids = listed.json().tasks.map((entry: { id: string }) => entry.id);
    expect(ids.indexOf('dup-1')).toBeLessThan(ids.indexOf('claim-1'));
  });

  it('[api-056] a client create and a drag move a task by the contract and a proposal needs its prompt again', async () => {
    const created = await client('tasks/create', {
      id: 'ui-1',
      title: envelope(),
      input: envelope(),
      when: 'backlog',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().task).toMatchObject({
      status: 'backlog',
      proposed: false,
      started: false,
    });
    await machine('add-task', {
      id: 'proposal-1',
      title: envelope(),
      input: envelope(),
      createdBy: 'agent',
    });
    const noPrompt = await client('tasks/move', { id: 'proposal-1', status: 'todo' });
    expect(noPrompt.statusCode).toBe(400);
    const started = await client('tasks/move', {
      id: 'proposal-1',
      status: 'todo',
      startInput: envelope(70),
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'todo', proposed: false, createdBy: 'user' });
  });

  it('[api-063] a client drag into running is refused', async () => {
    const refused = await client('tasks/move', { id: 'ui-1', status: 'running' });
    expect(refused.statusCode).toBe(400);
  });
});
