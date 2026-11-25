import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTaskActionHandlers } from '../src/handlers/task-actions.js';
import { createTaskHandlers } from '../src/handlers/tasks.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { loadConfig } from '../src/modules/index.js';
import { TASK_VOCABULARY, type Vocabulary } from '../src/modules/tasks/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
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

const sealed = (size: number) => envelope(size);
const note = (size = 41) => ({ body: sealed(size) });

describe('task action routes on pglite', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

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

  let counter = 0;
  const startRun = async () => {
    counter += 1;
    const id = `run-${counter}`;
    await machine('add-task', { id, title: sealed(41), input: sealed(42) });
    const claimed = await machine('claim-task', { id, machine: 'machine-1' });
    return { id, run: claimed.json().run as string };
  };

  beforeAll(async () => {
    opened = await pglite.open();
    ({ projectId } = await seedUser(opened.database, 'owner'));
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
  });

  it('[api-066] a heartbeat answers empty for a stale run and updates the held one', async () => {
    const { id, run } = await startRun();
    const stale = await machine('heartbeat', {
      id,
      run: 'older-run-identifier',
      lane: 'lane-a',
      borrowed: true,
    });
    expect(stale.statusCode).toBe(200);
    expect((await machine('get-task', { id })).json()).toMatchObject({ lane: null });
    const beat = await machine('heartbeat', { id, run, lane: 'lane-a', borrowed: true });
    expect(beat.statusCode).toBe(200);
    expect((await machine('get-task', { id })).json()).toMatchObject({
      lane: 'lane-a',
      borrowed: true,
    });
    expect(
      (await machine('heartbeat', { id: 'nope', lane: 'a', borrowed: false })).statusCode,
    ).toBe(404);
  });

  it('[api-067] pause, wait and wake answer 409 for a stale run and move the held one', async () => {
    const { id, run } = await startRun();
    const stale = await machine('pause', { id, run: 'older-run-identifier', ...note() });
    expect(stale.statusCode).toBe(409);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const early = await machine('wait', {
      id,
      run: 'older-run-identifier',
      ...note(),
      wakeAt: soon,
      check: false,
    });
    expect(early.statusCode).toBe(409);
    const tooFar = new Date(Date.now() + 8 * 24 * 3_600_000).toISOString();
    const far = await machine('wait', { id, run, ...note(), wakeAt: tooFar, check: false });
    expect(far.statusCode).toBe(400);
    const waiting = await machine('wait', { id, run, ...note(), wakeAt: soon, check: true });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toMatchObject({ status: 'waiting', waitCheck: true });
    const woken = await machine('wake', { id, ...note() });
    expect(woken.json()).toMatchObject({ applied: true, task: { status: 'todo' } });
    const again = await machine('wake', { id, ...note() });
    expect(again.json()).toMatchObject({ applied: false, task: { status: 'todo' } });

    const second = await startRun();
    const paused = await machine('pause', { id: second.id, run: second.run, ...note() });
    expect(paused.json()).toMatchObject({ status: 'todo', paused: true });
  });

  it('[api-067] fail answers applied false for a stale run and applied true for the held one', async () => {
    const { id, run } = await startRun();
    const stale = await machine('fail', { id, run: 'older-run-identifier', ...note() });
    expect(stale.json()).toMatchObject({ applied: false, task: { status: 'running' } });
    const failed = await machine('fail', { id, run, ...note() });
    expect(failed.json()).toMatchObject({ applied: true, task: { status: 'needs-me' } });
  });

  it('[api-068] ask answers empty, moves the task to needs-me and shows an open question', async () => {
    const { id, run } = await startRun();
    const stale = await machine('ask', {
      id,
      run: 'older-run-identifier',
      body: sealed(43),
      questions: sealed(44),
    });
    expect(stale.statusCode).toBe(409);
    const asked = await machine('ask', { id, run, body: sealed(43), questions: sealed(44) });
    expect(asked.statusCode).toBe(200);
    expect((await machine('get-task', { id })).json()).toMatchObject({
      status: 'needs-me',
      openQuestion: true,
    });
    const detail = (
      await app.inject({ url: `/api/client/tasks/get?id=${id}`, headers: CONTRACT_HEADERS })
    ).json();
    const question = detail.thread.find((entry: { kind: string }) => entry.kind === 'question');
    expect(question).toMatchObject({ author: 'agent', by: 'machine-1', questions: sealed(44) });

    const answered = await client('tasks/answer', {
      id,
      questionNoteId: question.id,
      answers: sealed(45),
      message: note(),
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ status: 'todo', openQuestion: false });
    const twice = await client('tasks/answer', {
      id,
      questionNoteId: question.id,
      answers: sealed(45),
      message: note(),
    });
    expect(twice.statusCode).toBe(409);
  });

  it('[api-069] a client dismisses a question, replies, sends to a running agent and stops it', async () => {
    const asking = await startRun();
    await machine('ask', { ...asking, body: sealed(43), questions: sealed(44) });
    const thread = (
      await app.inject({ url: `/api/client/tasks/get?id=${asking.id}`, headers: CONTRACT_HEADERS })
    ).json().thread;
    const dismissed = await client('tasks/dismiss-question', {
      id: asking.id,
      questionNoteId: thread.at(-1).id,
    });
    expect(dismissed.json()).toMatchObject({ status: 'needs-me', openQuestion: false });
    const reply = await client('tasks/reply', { id: asking.id, message: note(), resume: true });
    expect(reply.json()).toMatchObject({ status: 'todo' });

    const live = await startRun();
    const sent = await client('tasks/send', { id: live.id, message: note() });
    expect(sent.json()).toMatchObject({ status: 'running' });
    const blocked = await client('tasks/reply', { id: live.id, message: note(), resume: true });
    expect(blocked.statusCode).toBe(409);
    const stopped = await client('tasks/stop', { id: live.id, message: note() });
    expect(stopped.json()).toMatchObject({ status: 'running', stopRequested: true });

    const wrongRun = await machine('run-inbox', { id: live.id, run: 'older-run-identifier' });
    expect(wrongRun.statusCode).toBe(409);
    const inbox = await machine('run-inbox', { id: live.id, run: live.run });
    expect(inbox.json()).toMatchObject({ stop: true });
    expect(inbox.json().messages).toHaveLength(2);
    const ack = await machine('ack-messages', {
      id: live.id,
      run: live.run,
      ids: inbox.json().messages.map((entry: { id: string }) => entry.id),
      stop: true,
    });
    expect(ack.statusCode).toBe(200);
    expect((await machine('run-inbox', { id: live.id, run: live.run })).json()).toEqual({
      stop: false,
      messages: [],
    });
    const stoppedRun = await machine('stopped', { id: live.id, run: live.run, ...note() });
    expect(stoppedRun.json()).toMatchObject({ status: 'needs-me' });
  });

  it('[api-064] a client take-back is refused while the agent is active', async () => {
    const { id } = await startRun();
    const refused = await client('tasks/take-back', { id });
    expect(refused.statusCode).toBe(409);
    expect((await machine('get-task', { id })).json()).toMatchObject({ status: 'running' });
  });

  it('[api-070] the client and the machine edit the prompt of a never-claimed task', async () => {
    await client('tasks/create', { id: 'edit-1', title: sealed(41), input: sealed(42) });
    const edit = { title: sealed(51), input: sealed(52), previous: note(53) };
    const edited = await client('tasks/edit', { id: 'edit-1', ...edit });
    expect(edited.json()).toMatchObject({ title: sealed(51), input: sealed(52) });
    const viaMachine = await machine('edit-prompt', { id: 'edit-1', ...edit, title: sealed(54) });
    expect(viaMachine.json()).toMatchObject({ title: sealed(54) });
    const { id } = await startRun();
    expect((await machine('edit-prompt', { id, ...edit })).statusCode).toBe(409);
  });

  it('[api-071] configure and set-project change settings, project and directory together', async () => {
    const created = await client('tasks/create', {
      id: 'cfg-1',
      title: sealed(41),
      input: sealed(42),
    });
    expect(created.statusCode).toBe(200);
    const configured = await client('tasks/configure', {
      id: 'cfg-1',
      priority: 'high',
      model: 'opus',
      labels: sealed(43),
    });
    expect(configured.json()).toMatchObject({
      priority: 'high',
      model: 'opus',
      labels: sealed(43),
    });
    const viaMachine = await machine('configure-task', {
      id: 'cfg-1',
      autoDone: true,
      effort: 'low',
    });
    expect(viaMachine.json()).toMatchObject({ autoDone: true, effort: 'low' });
    expect((await machine('configure-task', { id: 'cfg-1' })).statusCode).toBe(400);

    const { id } = await startRun();
    const lane = await client('tasks/configure', { id, lane: 'lane-z' });
    expect(lane.statusCode).toBe(409);
    const moved = await client('tasks/set-project', { id, projectId, directoryId: null });
    expect(moved.statusCode).toBe(409);
    const ok = await client('tasks/set-project', {
      id: 'cfg-1',
      projectId,
      directoryId: randomUUID(),
    });
    expect(ok.statusCode).toBe(404);
  });

  it('[api-073] pull requests are added, set to states and removed through the machine and the client', async () => {
    const { id } = await startRun();
    for (let index = 0; index < 20; index += 1)
      expect((await machine('add-pr', { id, pr: sealed(40 + index) })).statusCode).toBe(200);
    expect((await machine('add-pr', { id, pr: sealed(70) })).statusCode).toBe(400);
    const { prs } = (await machine('get-task', { id })).json();
    expect(prs).toHaveLength(20);
    const states = await machine('set-pr-states', {
      id,
      prompt: 'open',
      prs: [{ id: prs[0].id, state: 'merged' }],
    });
    expect(states.statusCode).toBe(200);
    const removed = await client('tasks/remove-pr', { id, prId: prs[1].id });
    expect(removed.json().prs).toHaveLength(19);
    expect(removed.json()).toMatchObject({ promptPrState: 'open' });
    expect(removed.json().prs[0]).toMatchObject({ state: 'merged' });
  });

  it('[api-074] watches are written by the task machine and the client stops one', async () => {
    const { id } = await startRun();
    expect((await machine('set-watches', { id, watches: sealed(60) })).statusCode).toBe(200);
    const stopped = await client('tasks/stop-watch', { id, watchId: 'a1b2c3d4e5f60718' });
    expect(stopped.json()).toMatchObject({ watches: sealed(60), watchStops: ['a1b2c3d4e5f60718'] });
    const ack = await machine('ack-watch-stops', { id, ids: ['a1b2c3d4e5f60718'] });
    expect(ack.statusCode).toBe(200);
    expect((await machine('get-task', { id })).json().watchStops).toEqual([]);
    await client('tasks/create', { id: 'unplaced-1', title: sealed(41), input: sealed(42) });
    const refused = await client('tasks/stop-watch', {
      id: 'unplaced-1',
      watchId: 'a1b2c3d4e5f60718',
    });
    expect(refused.statusCode).toBe(409);
    expect(
      (await machine('set-watches', { id: 'unplaced-1', watches: sealed(60) })).statusCode,
    ).toBe(409);
  });

  it('[api-072] a client forks a task that has a session on a machine', async () => {
    const { id, run } = await startRun();
    await machine('update-task', { id, run, sessionId: randomUUID() });
    const fork = {
      id: 'fork-route-1',
      parentId: id,
      title: sealed(41),
      input: sealed(42),
      directoryId: null,
    };
    const forked = await client('tasks/fork', fork);
    expect(forked.statusCode).toBe(200);
    expect(forked.json()).toMatchObject({
      status: 'todo',
      forkOf: id,
      parentId: id,
      machine: 'machine-1',
    });
    const detail = (
      await app.inject({ url: `/api/client/tasks/get?id=${id}`, headers: CONTRACT_HEADERS })
    ).json();
    expect(detail.followUps.map((entry: { id: string }) => entry.id)).toContain('fork-route-1');
    const missing = await client('tasks/fork', { ...fork, id: 'fork-route-2', parentId: 'nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('[api-064] a note a machine adds shows in its notes and in the client thread', async () => {
    const { id } = await startRun();
    await machine('add-note', { id, ...note(), kind: 'comment' });
    const notes = (await machine('read-notes', { id })).json().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ author: 'agent', kind: 'comment' });
    expect((await machine('add-note', { id: 'nope', ...note() })).statusCode).toBe(404);
  });
});

describe('an enum value the client did not declare', () => {
  let opened: OpenedTarget;
  let app: Awaited<ReturnType<typeof createServer>>;

  const FUTURE: Vocabulary = {
    ...TASK_VOCABULARY,
    priority: { ...TASK_VOCABULARY.priority, urgent: 2 },
  };

  const call = (url: string, contract: string, payload?: unknown) =>
    app.inject({
      method: payload === undefined ? 'GET' : 'POST',
      url,
      headers: {
        ...(payload === undefined ? {} : JSON_HEADERS),
        'x-board-contract': contract,
        ...(url.startsWith('/api/machine/') ? { authorization: `Bearer ${MACHINE_TOKEN}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
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
      { handlerSets: [createTaskHandlers(FUTURE), createTaskActionHandlers(FUTURE)] },
    );
    await app.ready();
    for (const [id, priority] of [
      ['plain', 'normal'],
      ['urgent', 'urgent'],
    ] as const)
      await call('/api/machine/add-task', '1', {
        id,
        title: sealed(41),
        input: sealed(42),
        priority,
      });
  });

  afterAll(async () => {
    await app.close();
    await opened.cleanup();
  });

  it('[api-097] is dropped from lists and answers 422 on a single object', async () => {
    const old = await call('/api/machine/list-tasks', '1', {});
    expect(old.json().tasks.map((entry: { id: string }) => entry.id)).toEqual(['plain']);
    const current = await call('/api/machine/list-tasks', '2', {});
    expect(
      current
        .json()
        .tasks.map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(['plain', 'urgent']);
    const single = await call('/api/machine/get-task', '1', { id: 'urgent' });
    expect(single.statusCode).toBe(422);
    expect((await call('/api/machine/get-task', '2', { id: 'urgent' })).statusCode).toBe(200);
    const client = await call('/api/client/tasks/list', '1');
    expect(client.json().tasks.map((entry: { id: string }) => entry.id)).toEqual(['plain']);
    const detail = await call('/api/client/tasks/get?id=urgent', '1');
    expect(detail.statusCode).toBe(422);
  });

  it('[api-097] rolls the write back when its answer would carry an unknown value', async () => {
    const refused = await call('/api/client/tasks/set-priority', '1', {
      id: 'plain',
      priority: 'urgent',
    });
    expect(refused.statusCode).toBe(422);
    const after = await call('/api/machine/get-task', '1', { id: 'plain' });
    expect(after.json()).toMatchObject({ priority: 'normal' });
    const allowed = await call('/api/client/tasks/set-priority', '2', {
      id: 'plain',
      priority: 'urgent',
    });
    expect(allowed.statusCode).toBe(200);
    expect((await call('/api/machine/get-task', '2', { id: 'plain' })).json().priority).toBe(
      'urgent',
    );
  });
});
