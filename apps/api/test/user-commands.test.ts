import { randomUUID } from 'node:crypto';

import type { RouteName } from '@agent-board/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  USER_WRITE_COMMANDS,
  unavailableUserActions,
  type UserActions,
  type UserActor,
} from '../src/modules/machine/index.js';
import { SESSION_TOKEN } from './helpers.js';
import {
  OWNER,
  call,
  errorCode,
  envelope,
  issue,
  seedTask,
  startBoard,
  uniqueName,
  type MachineBoard,
} from './machine-support.js';

const seen: { command: string; actor: UserActor; input: unknown }[] = [];

const recording = (command: string) => async (_tx: unknown, actor: UserActor, input: unknown) => {
  seen.push({ command, actor, input });
  return { id: (input as { id?: string }).id ?? 'forked' } as never;
};

const actions = Object.fromEntries(
  USER_WRITE_COMMANDS.map((command) => [command, recording(command)]),
) as unknown as UserActions;

let board: MachineBoard;

beforeAll(async () => {
  board = await startBoard({ actions });
});

afterAll(async () => {
  await board.close();
});

const NOTE = { body: envelope() };
const request = (taskId: string, runId: string): Record<string, [RouteName, unknown]> => ({
  answer: [
    'machine.answer',
    { id: taskId, questionNoteId: 'q1', answers: envelope(), message: NOTE },
  ],
  'dismiss-question': ['machine.dismiss-question', { id: taskId, questionNoteId: 'q1' }],
  reply: ['machine.reply', { id: taskId, message: NOTE, resume: true }],
  send: ['machine.send', { id: taskId, message: NOTE }],
  stop: ['machine.stop', { id: taskId }],
  'take-back': ['machine.take-back', { id: taskId }],
  rerun: ['machine.rerun', { id: taskId }],
  'set-closed': ['machine.set-closed', { id: taskId, closed: true }],
  fork: [
    'machine.fork',
    {
      id: uniqueName('fork'),
      parentId: taskId,
      title: envelope(),
      input: envelope(),
      directoryId: null,
    },
  ],
  'list-runs': ['machine.list-runs', { id: taskId }],
  'transcript-events': ['machine.transcript-events', { runId }],
  'transcript-output': ['machine.transcript-output', { runId, seq: 0 }],
});

const COMMANDS = [...USER_WRITE_COMMANDS, 'list-runs', 'transcript-events', 'transcript-output'];

const subject = async (options: { machine?: string; status?: 'running' | 'done' } = {}) => {
  const id = uniqueName('task');
  const runId = uniqueName('run');
  await seedTask(board, {
    id,
    ...(options.status === 'running'
      ? { status: 'running', machine: options.machine ?? null, runId: 'live-run-0123456789' }
      : {}),
  });
  await board.database.withOwner(OWNER, async (tx) => {
    const { transcriptRun } = await import('../src/db/schema/index.js');
    await tx.insert(transcriptRun).values({
      id: runId,
      taskId: id,
      machine: options.machine ?? 'elsewhere',
      startedAt: new Date(),
      lastEventAt: new Date(),
    });
  });
  return { id, runId };
};

const enrol = async (grant: boolean) => {
  const name = uniqueName('user-box');
  const token = await issue(board, name);
  if (grant) await call(board, 'client.machines.set-grant', { name, grant: true });
  return { name, token };
};

describe('user-authored machine commands', () => {
  it('[api-119] 403 grant-required for every command while the grant is off, the default', async () => {
    const { token } = await enrol(false);
    const { id, runId } = await subject();
    const before = seen.length;
    for (const command of COMMANDS) {
      const [name, input] = request(id, runId)[command]!;
      const reply = await call(board, name as never, input as never, { token });
      expect(reply.status, command).toBe(403);
      expect(errorCode(reply), command).toBe('grant-required');
    }
    expect(seen).toHaveLength(before);
  });

  it('[api-119] the grant is checked before the task is looked up', async () => {
    const { token } = await enrol(false);
    const reply = await call(board, 'machine.take-back', { id: 'no-such-task' }, { token });
    expect(reply.status).toBe(403);
  });

  it('[api-119] with the grant on, the write commands reach the task layer as the owner, recording the machine', async () => {
    const { name, token } = await enrol(true);
    const { id, runId } = await subject();
    for (const command of USER_WRITE_COMMANDS) {
      const [route, input] = request(id, runId)[command]!;
      const before = seen.length;
      const reply = await call(board, route as never, input as never, { token });
      expect(reply.status, command).toBe(200);
      expect(seen).toHaveLength(before + 1);
      expect(seen.at(-1)).toMatchObject({
        command,
        actor: { owner: OWNER, viaMachineId: name },
      });
    }
  });

  it('[api-119] with the grant on, the reads return the task’s runs, events and outputs', async () => {
    const { token } = await enrol(true);
    const { id, runId } = await subject();
    expect((await call(board, 'machine.list-runs', { id }, { token })).body.runs).toMatchObject([
      { id: runId },
    ]);
    expect(
      (await call(board, 'machine.transcript-events', { runId }, { token })).body.events,
    ).toEqual([]);
    const output = await call(board, 'machine.transcript-output', { runId, seq: 0 }, { token });
    expect(output.status).toBe(404);
    const unknown = await call(
      board,
      'machine.transcript-events',
      { runId: 'run-unknown-1' },
      { token },
    );
    expect(unknown.status).toBe(404);
  });

  it('[api-119] 409 run-holds-task for every command while the calling machine holds the task’s active run', async () => {
    const { name, token } = await enrol(true);
    const { id, runId } = await subject({ machine: name, status: 'running' });
    const before = seen.length;
    for (const command of COMMANDS) {
      const [route, input] = request(id, runId)[command]!;
      const reply = await call(board, route as never, input as never, { token });
      expect(reply.status, command).toBe(409);
      expect(errorCode(reply), command).toBe('run-holds-task');
    }
    expect(seen).toHaveLength(before);
  });

  it('[api-119] another machine’s run, or a task that is no longer running, does not hold the task', async () => {
    const { name, token } = await enrol(true);
    const elsewhere = await subject({ machine: 'someone-else', status: 'running' });
    expect((await call(board, 'machine.stop', { id: elsewhere.id }, { token })).status).toBe(200);
    const finished = await subject({ machine: name, status: 'done' });
    expect((await call(board, 'machine.rerun', { id: finished.id }, { token })).status).toBe(200);
    const unknown = await call(
      board,
      'machine.rerun',
      { id: randomUUID().slice(0, 12) },
      { token },
    );
    expect(unknown.status).toBe(404);
  });

  it('[api-119] a granted machine on a build without the task layer gets unavailable, not a crash', async () => {
    const bare = await startBoard({ actions: unavailableUserActions });
    try {
      const name = uniqueName('bare');
      const token = await issue(bare, name);
      await call(bare, 'client.machines.set-grant', { name, grant: true });
      await seedTask(bare, { id: 'bare-task' });
      const reply = await call(bare, 'machine.stop', { id: 'bare-task' }, { token });
      expect(reply.status).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('[api-119] only a user session sets the grant, and a fresh or re-issued machine has none', async () => {
    const login = await startBoard({ login: true });
    try {
      const name = uniqueName('grantee');
      const asUser = {
        headers: { cookie: `board-session=${SESSION_TOKEN}`, origin: 'http://localhost:4000' },
      };
      const issued = await call(login, 'client.machines.issue', { name }, asUser);
      expect(issued.status).toBe(200);
      const token = issued.body.token;

      const refused = await call(
        login,
        'client.machines.set-grant',
        { name, grant: true },
        { token },
      );
      expect(refused.status).toBe(401);
      expect((await call(login, 'machine.version', {}, { token })).body.grant).toBe(false);

      expect(
        (await call(login, 'client.machines.set-grant', { name, grant: true }, asUser)).status,
      ).toBe(200);
      expect((await call(login, 'machine.version', {}, { token })).body.grant).toBe(true);
      const listed = await call(login, 'client.machines.list', {}, asUser);
      expect(listed.body.machines.find((entry) => entry.name === name)?.grant).toBe(true);

      expect(
        (await call(login, 'client.machines.set-grant', { name: 'nobody', grant: true }, asUser))
          .status,
      ).toBe(404);
      expect(
        (await call(login, 'client.machines.set-grant', { name, grant: false }, asUser)).status,
      ).toBe(200);
      expect((await call(login, 'machine.version', {}, { token })).body.grant).toBe(false);
    } finally {
      await login.close();
    }
  });
});
