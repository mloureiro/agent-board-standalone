import { randomUUID } from 'node:crypto';

import { routes } from '@agent-board/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_TOKEN } from './helpers.js';
import {
  call,
  envelope,
  errorCode,
  issue,
  listen,
  seedTask,
  startBoard,
  uniqueName,
  type MachineBoard,
} from './machine-support.js';

let board: MachineBoard;

beforeAll(async () => {
  board = await startBoard();
});

afterAll(async () => {
  await board.close();
});

const NOTE = { body: envelope() };

const machineStream = (token: string) => {
  const route = routes.find((entry) => entry.name === 'machine.events')!;
  return board.app.inject({
    method: 'GET',
    url: route.path,
    headers: { authorization: `Bearer ${token}`, 'x-board-contract': '1' },
  });
};

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('board wiring', () => {
  it('[api-095] a committed client write publishes a change and a task write also tells the machines', async () => {
    const heard = await listen(board);
    const id = randomUUID();
    await call(board, 'client.projects.create', { id, name: envelope(), icon: envelope() });
    expect(heard).toContainEqual({ kind: 'change', projectId: id });

    heard.length = 0;
    const created = await call(board, 'client.tasks.create', {
      id: uniqueName('t'),
      title: envelope(),
      input: envelope(),
    } as never);
    expect(created.status).toBe(200);
    expect(heard.map((message) => message.kind).sort()).toEqual(['change', 'tasks']);

    heard.length = 0;
    const refused = await call(board, 'client.projects.update', {
      id: randomUUID(),
      name: envelope(),
    });
    expect(refused.status).toBe(404);
    expect(heard).toEqual([]);
  });

  it('[api-094] machine writes tell the machine stream and the client streams', async () => {
    const token = await issue(board, uniqueName('writer'));
    const heard = await listen(board);
    const id = uniqueName('machine-task');
    const added = await call(
      board,
      'machine.add-task',
      { id, title: envelope(), input: envelope() },
      { token },
    );
    expect(added.status).toBe(200);
    expect(heard.map((message) => message.kind).sort()).toEqual(['change', 'tasks']);
  });

  it('[api-089] revoking a machine ends its event stream and refuses the token', async () => {
    const name = uniqueName('leaving');
    const token = await issue(board, name);
    const heard = await listen(board);
    const stream = machineStream(token);
    await settle();
    expect((await call(board, 'client.machines.revoke', { name })).status).toBe(200);
    const closed = await stream;
    expect(closed.statusCode).toBe(200);
    expect(heard).toContainEqual({ kind: 'revoked', machineId: name });
    expect((await call(board, 'machine.version', {}, { token })).status).toBe(401);
  });

  it('[api-089] a machine revoking its own token ends its stream', async () => {
    const token = await issue(board, uniqueName('uninstall'));
    const stream = machineStream(token);
    await settle();
    expect((await call(board, 'machine.revoke-token', {}, { token })).status).toBe(200);
    expect((await stream).statusCode).toBe(200);
  });

  it('[api-089] issuing a token again ends the stream held by the old one', async () => {
    const name = uniqueName('reissued');
    const old = await issue(board, name);
    const stream = machineStream(old);
    await settle();
    const fresh = await issue(board, name);
    expect((await stream).statusCode).toBe(200);
    expect((await call(board, 'machine.version', {}, { token: old })).status).toBe(401);
    expect((await call(board, 'machine.version', {}, { token: fresh })).status).toBe(200);
  });

  it('[api-093] several machines claiming at once get distinct tasks and one winner per task', async () => {
    const machines = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const name = uniqueName('worker');
        return { name, token: await issue(board, name) };
      }),
    );
    const ids = Array.from({ length: 3 }, () => uniqueName('claimable'));
    for (const id of ids) await seedTask(board, { id, status: 'todo' });

    const attempts = await Promise.all(
      ids.flatMap((id) =>
        machines.map(async (worker) => ({
          id,
          worker: worker.name,
          reply: await call(
            board,
            'machine.claim-task',
            { id, machine: worker.name },
            { token: worker.token },
          ),
        })),
      ),
    );
    for (const id of ids) {
      const mine = attempts.filter((attempt) => attempt.id === id);
      const winners = mine.filter((attempt) => attempt.reply.status === 200);
      expect(winners).toHaveLength(1);
      expect(mine.filter((attempt) => attempt.reply.status === 409)).toHaveLength(
        machines.length - 1,
      );
      expect(winners[0]!.reply.body).toMatchObject({
        status: 'running',
        machine: winners[0]!.worker,
      });
    }
  });

  it('[api-119] the real task services answer the user commands of a granted machine as the owner', async () => {
    const name = uniqueName('granted');
    const token = await issue(board, name);
    const done = uniqueName('finished');
    await seedTask(board, { id: done, status: 'done' });

    const refused = await call(board, 'machine.rerun', { id: done }, { token });
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('grant-required');

    await call(board, 'client.machines.set-grant', { name, grant: true });
    const heard = await listen(board);
    const rerun = await call(board, 'machine.rerun', { id: done }, { token });
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ id: done, status: 'todo' });
    expect(heard.map((message) => message.kind)).toContain('tasks');

    const closed = await call(board, 'machine.set-closed', { id: done, closed: true }, { token });
    expect(closed.body).toMatchObject({ id: done, closed: true });
    const sent = await call(board, 'machine.send', { id: done, message: NOTE }, { token });
    expect([200, 409]).toContain(sent.status);
  });

  it('[api-119] the machine running a task cannot command it through the real services', async () => {
    const name = uniqueName('runner');
    const token = await issue(board, name);
    await call(board, 'client.machines.set-grant', { name, grant: true });
    const id = uniqueName('held');
    await seedTask(board, { id, status: 'running', machine: name, runId: 'live-run-0123456789' });
    const reply = await call(board, 'machine.stop', { id }, { token });
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('run-holds-task');
  });

  it('[api-095] signing out publishes a change so open pages re-check their session', async () => {
    const login = await startBoard({ login: true });
    try {
      const heard = await listen(login);
      const reply = await login.app.inject({
        method: 'POST',
        url: routes.find((entry) => entry.name === 'auth.logout')!.path,
        headers: {
          cookie: `board-session=${SESSION_TOKEN}`,
          origin: 'http://localhost:4000',
          'content-type': 'application/json',
          'x-board-contract': '1',
        },
        payload: '{}',
      });
      expect(reply.statusCode).toBe(200);
      expect(heard).toContainEqual({ kind: 'change' });
    } finally {
      await login.close();
    }
  });
});
