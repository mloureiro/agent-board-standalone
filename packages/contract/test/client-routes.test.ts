import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  CLIENT_BODY_LIMIT,
  clientEvent,
  clientRoutes,
  routeByName,
  routes,
  type AnyRoute,
  answerInput,
  dismissQuestionInput,
  forkInput,
  replyInput,
  rerunInput,
  sendInput,
  setClosedInput,
  stopInput,
  takeBackInput,
} from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const blind = `abh1.${'A'.repeat(43)}`;
const task = 'Ab3dEf9xYz12';
const other = 'Zy9xWv8uTs76';
const schedule = 'Sc3dEf9x';
const uuid = '591d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const time = '2026-11-13T10:00:00.000Z';
const runId = 'run-12345678';
const note = { body: sealed };

const wireTask = {
  id: task,
  title: sealed,
  input: sealed,
  status: 'needs-me',
  createdBy: 'user',
  priority: 'normal',
  model: null,
  effort: null,
  requestedLane: null,
  autoDone: false,
  icon: null,
  labels: null,
  closed: false,
  machine: 'laptop',
  sessionId: uuid,
  projectId: uuid,
  directoryId: uuid,
  legacyDirectory: null,
  next: 'fresh',
  head: blind,
  openQuestion: true,
  lane: null,
  borrowed: false,
  lastActiveAt: null,
  runStartedAt: null,
  paused: false,
  notBefore: null,
  scheduleId: null,
  wakeAt: null,
  waitCheck: false,
  woken: false,
  prs: [],
  promptPrState: null,
  watches: null,
  watchStops: [],
};

const uiTask = {
  ...wireTask,
  proposed: false,
  started: true,
  parentId: null,
  createdAt: time,
  updatedAt: time,
};

const context = { at: time, runId, seq: 3, data: sealed };

const threadNote = {
  id: 'n1',
  createdAt: time,
  body: sealed,
  preview: null,
  author: 'agent',
  kind: 'comment',
  by: null,
};

const wireSchedule = {
  id: schedule,
  title: sealed,
  input: sealed,
  priority: 'normal',
  model: null,
  effort: null,
  requestedLane: null,
  autoDone: false,
  machine: 'laptop',
  projectId: uuid,
  directoryId: uuid,
  legacyDirectory: null,
  everyMs: 7_200_000,
  cron: null,
  timezone: null,
  after: null,
  maxConcurrent: null,
  anchorAt: time,
  nextRunAt: time,
  remaining: 3,
  until: null,
  paused: false,
  ended: false,
  occurrenceTaskId: task,
  createdAt: time,
};

const scheduleUpdate = {
  id: schedule,
  title: sealed,
  input: sealed,
  place: { machine: 'laptop', directoryId: uuid },
  priority: 'normal',
  model: null,
  autoDone: false,
  repeat: { everyMs: 3_600_000 },
  runsLeft: null,
  until: null,
  maxConcurrent: null,
};

interface Case {
  name: string;
  request: Record<string, unknown>;
  response: unknown;
}

const answers = {
  taskId: { id: task },
  withTask: { task: uiTask },
};

const cases: Case[] = [
  { name: 'client.me', request: {}, response: { username: 'owner', keyId: '0123456789abcdef' } },
  { name: 'client.revision', request: {}, response: { revision: null } },
  {
    name: 'client.tasks.list',
    request: {},
    response: { tasks: [{ ...uiTask, lastNote: null, context: null }] },
  },
  {
    name: 'client.tasks.get',
    request: answers.taskId,
    response: { task: uiTask, thread: [threadNote], followUps: [uiTask], parent: null },
  },
  {
    name: 'client.tasks.create',
    request: { id: task, title: sealed, input: sealed },
    response: { task: null },
  },
  {
    name: 'client.tasks.fork',
    request: {
      id: task,
      parentId: other,
      title: sealed,
      input: sealed,
      directoryId: null,
    },
    response: uiTask,
  },
  {
    name: 'client.tasks.answer',
    request: { id: task, questionNoteId: 'q1', answers: sealed, message: note },
    response: uiTask,
  },
  {
    name: 'client.tasks.dismiss-question',
    request: { id: task, questionNoteId: 'q1' },
    response: uiTask,
  },
  {
    name: 'client.tasks.reply',
    request: { id: task, message: note, resume: true },
    response: uiTask,
  },
  { name: 'client.tasks.send', request: { id: task, message: note }, response: uiTask },
  { name: 'client.tasks.stop', request: { id: task }, response: uiTask },
  {
    name: 'client.tasks.apply-polish',
    request: { id: task, polishId: 'p1', title: sealed, input: sealed, previous: note },
    response: uiTask,
  },
  {
    name: 'client.tasks.edit',
    request: { id: task, title: sealed, input: sealed, previous: note },
    response: uiTask,
  },
  { name: 'client.tasks.done', request: answers.taskId, response: uiTask },
  { name: 'client.tasks.rerun', request: answers.taskId, response: uiTask },
  {
    name: 'client.tasks.set-priority',
    request: { id: task, priority: 'high' },
    response: uiTask,
  },
  {
    name: 'client.tasks.configure',
    request: { id: task, model: 'opus' },
    response: uiTask,
  },
  {
    name: 'client.tasks.set-not-before',
    request: { id: task, notBefore: null },
    response: uiTask,
  },
  { name: 'client.tasks.wake-now', request: answers.taskId, response: uiTask },
  { name: 'client.tasks.take-back', request: answers.taskId, response: uiTask },
  { name: 'client.tasks.remove-pr', request: { id: task, prId: 'pr1' }, response: uiTask },
  {
    name: 'client.tasks.stop-watch',
    request: { id: task, watchId: '0123456789abcdef' },
    response: uiTask,
  },
  { name: 'client.tasks.set-closed', request: { id: task, closed: true }, response: uiTask },
  { name: 'client.tasks.move', request: { id: task, status: 'todo' }, response: uiTask },
  {
    name: 'client.tasks.set-project',
    request: { id: task, projectId: uuid, directoryId: null },
    response: uiTask,
  },
  { name: 'client.schedules.list', request: {}, response: { schedules: [wireSchedule] } },
  {
    name: 'client.schedules.set-paused',
    request: { id: schedule, paused: true },
    response: wireSchedule,
  },
  {
    name: 'client.schedules.update',
    request: scheduleUpdate,
    response: { schedule: wireSchedule, pending: 'updated' },
  },
  { name: 'client.schedules.remove', request: { id: schedule }, response: {} },
  {
    name: 'client.transcript.runs',
    request: answers.taskId,
    response: {
      runs: [
        {
          id: runId,
          machine: 'laptop',
          sessionId: null,
          resumed: false,
          startedAt: time,
          lastEventAt: time,
          eventCount: 4,
        },
      ],
    },
  },
  {
    name: 'client.transcript.events',
    request: { runId },
    response: {
      events: [{ seq: 0, at: time, kind: 'text', parent: null, data: sealed, outputSize: null }],
    },
  },
  { name: 'client.transcript.context', request: answers.taskId, response: { context } },
  {
    name: 'client.transcript.output',
    request: { runId, seq: '2' },
    response: { output: sealed },
  },
];

const route = (name: string): AnyRoute => routeByName(name as 'client.me') as unknown as AnyRoute;
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);
const READS = [
  'me',
  'revision',
  'tasks.list',
  'tasks.get',
  'schedules.list',
  'transcript.runs',
  'transcript.events',
  'transcript.context',
  'transcript.output',
  'events',
];

describe('client routes: tasks, schedules, transcript, me, revision, events', () => {
  it('[contract-003] client task, schedule and transcript routes:', () => {
    expect(clientRoutes.map((entry) => `${entry.method} ${entry.path}`).sort())
      .toMatchInlineSnapshot(`
      [
        "GET /api/client/events",
        "GET /api/client/me",
        "GET /api/client/revision",
        "GET /api/client/schedules/list",
        "GET /api/client/tasks/get",
        "GET /api/client/tasks/list",
        "GET /api/client/transcript/context",
        "GET /api/client/transcript/events",
        "GET /api/client/transcript/output",
        "GET /api/client/transcript/runs",
        "POST /api/client/schedules/remove",
        "POST /api/client/schedules/set-paused",
        "POST /api/client/schedules/update",
        "POST /api/client/tasks/answer",
        "POST /api/client/tasks/apply-polish",
        "POST /api/client/tasks/configure",
        "POST /api/client/tasks/create",
        "POST /api/client/tasks/dismiss-question",
        "POST /api/client/tasks/done",
        "POST /api/client/tasks/edit",
        "POST /api/client/tasks/fork",
        "POST /api/client/tasks/move",
        "POST /api/client/tasks/remove-pr",
        "POST /api/client/tasks/reply",
        "POST /api/client/tasks/rerun",
        "POST /api/client/tasks/send",
        "POST /api/client/tasks/set-closed",
        "POST /api/client/tasks/set-not-before",
        "POST /api/client/tasks/set-priority",
        "POST /api/client/tasks/set-project",
        "POST /api/client/tasks/stop",
        "POST /api/client/tasks/stop-watch",
        "POST /api/client/tasks/take-back",
        "POST /api/client/tasks/wake-now",
      ]
    `);
  });

  it('[contract-003] client reads are GET and writes are POST', () => {
    for (const entry of clientRoutes) {
      const expected = READS.includes(entry.name.slice('client.'.length)) ? 'GET' : 'POST';
      expect(entry.method, entry.name).toBe(expected);
    }
  });

  it('[contract-003] every client route path starts with /api/client/ and auth is client', () => {
    for (const entry of clientRoutes) {
      expect(entry.auth).toBe('client');
      expect(entry.path.startsWith('/api/client/')).toBe(true);
      expect(entry.path).toMatch(/^\/api\/client\/[a-z]+(-[a-z]+)*(\/[a-z]+(-[a-z]+)*)?$/);
      expect(entry.name).toBe(
        `client.${entry.path.slice('/api/client/'.length).replace('/', '.')}`,
      );
    }
    expect(CLIENT_BODY_LIMIT).toBe(2 * 1024 * 1024);
  });

  it('[contract-003] the client list covers exactly the cases here and the event stream', () => {
    const covered = new Set([...cases.map((entry) => entry.name), 'client.events']);
    expect(new Set(clientRoutes.map((entry) => entry.name))).toEqual(covered);
    expect(clientRoutes).toHaveLength(34);
    expect(routes.filter((entry) => entry.auth === 'client')).toHaveLength(34);
  });

  for (const entry of cases) {
    it(`[contract-003] ${entry.name} accepts a minimal request, refuses an unknown key and parses its answer`, () => {
      const spec = route(entry.name);
      expect(parse(spec.request, entry.request).success).toBe(true);
      expect(parse(spec.request, { ...entry.request, extra: 1 }).success).toBe(false);
      expect(parse(spec.response, entry.response).success).toBe(true);
      expect(parse(spec.response, { ...(entry.response as object), extra: 1 }).success).toBe(false);
    });
  }

  it('[contract-003] client task and schedule shapes carry projectId and directoryId, not workdir', () => {
    const detail = route('client.tasks.get').response;
    expect(parse(detail, { task: uiTask, thread: [], followUps: [], parent: null }).success).toBe(
      true,
    );
    expect(
      parse(detail, {
        task: { ...uiTask, workdir: sealed },
        thread: [],
        followUps: [],
        parent: null,
      }).success,
    ).toBe(false);
    const withoutProject: Record<string, unknown> = { ...uiTask };
    delete withoutProject.projectId;
    expect(
      parse(detail, { task: withoutProject, thread: [], followUps: [], parent: null }).success,
    ).toBe(false);
    const withoutDirectory: Record<string, unknown> = { ...uiTask };
    delete withoutDirectory.directoryId;
    expect(
      parse(detail, { task: withoutDirectory, thread: [], followUps: [], parent: null }).success,
    ).toBe(false);
    const list = route('client.schedules.list').response;
    expect(parse(list, { schedules: [{ ...wireSchedule, workdir: sealed }] }).success).toBe(false);
    const create = route('client.tasks.create').request;
    expect(
      parse(create, {
        id: task,
        title: sealed,
        input: sealed,
        projectId: uuid,
        place: { machine: 'laptop', directoryId: uuid },
      }).success,
    ).toBe(true);
    expect(
      parse(create, {
        id: task,
        title: sealed,
        input: sealed,
        place: { machine: 'laptop', workdir: sealed },
      }).success,
    ).toBe(false);
  });

  it('[contract-003] tasks/list and schedules/list accept a project filter', () => {
    for (const name of ['client.tasks.list', 'client.schedules.list']) {
      const { request } = route(name);
      expect(parse(request, { project: uuid }).success).toBe(true);
      expect(parse(request, { project: 'default' }).success).toBe(false);
      expect(parse(request, {}).success).toBe(true);
    }
  });

  it('[contract-003] tasks/list reads closed as a string and turns it into a boolean', () => {
    const { request } = route('client.tasks.list');
    expect(request.parse({ closed: 'true' })).toEqual({ closed: true });
    expect(request.parse({ closed: 'false' })).toEqual({ closed: false });
    expect(parse(request, { closed: 'yes' }).success).toBe(false);
    expect(parse(request, { closed: true }).success).toBe(false);
  });

  it('[contract-003] transcript queries take positions as decimal strings', () => {
    const events = route('client.transcript.events').request;
    expect(events.parse({ runId, afterSeq: '12' })).toEqual({ runId, afterSeq: 12 });
    for (const bad of ['-1', '1.5', '01', '', 'abc', '99999999999']) {
      expect(parse(events, { runId, afterSeq: bad }).success, bad).toBe(false);
    }
    const output = route('client.transcript.output').request;
    expect(parse(output, { runId }).success).toBe(false);
    expect(parse(output, { runId, seq: 4 }).success).toBe(false);
  });

  it('[contract-003] the client event stream declares the changed event and a project filter', () => {
    const events = route('client.events');
    expect(events.stream).toBe(true);
    expect(events.method).toBe('GET');
    expect(events.path).toBe('/api/client/events');
    expect(events.request).toBeDefined();
    expect(parse(events.request, { project: uuid }).success).toBe(true);
    expect(parse(events.request, { project: 'x' }).success).toBe(false);
    expect(parse(events.request, {}).success).toBe(true);
    expect(parse(clientEvent, { event: 'changed', data: {} }).success).toBe(true);
    expect(parse(clientEvent, { event: 'changed', data: { a: 1 } }).success).toBe(false);
    expect(parse(clientEvent, { event: 'tasks', data: {} }).success).toBe(false);
  });

  it('[contract-003] user-authored machine commands and client task actions share request schemas', () => {
    const shared = {
      answer: answerInput,
      'dismiss-question': dismissQuestionInput,
      reply: replyInput,
      send: sendInput,
      stop: stopInput,
      'take-back': takeBackInput,
      rerun: rerunInput,
      'set-closed': setClosedInput,
      fork: forkInput,
    };
    for (const [command, schema] of Object.entries(shared)) {
      expect(route(`client.tasks.${command}`).request).toBe(schema);
      expect(route(`machine.${command}`).request).toBe(schema);
    }
  });

  it('[contract-003] set-project moves a task with its directory and may clear it', () => {
    const { request, errors } = route('client.tasks.set-project');
    expect(parse(request, { id: task, projectId: uuid, directoryId: uuid }).success).toBe(true);
    expect(parse(request, { id: task, projectId: uuid }).success).toBe(false);
    expect(parse(request, { id: task, directoryId: null }).success).toBe(false);
    for (const code of ['not-found', 'conflict', 'forbidden'] as const) {
      expect(errors).toContain(code);
    }
  });

  it('[contract-003] tasks/configure needs at least one setting and takes a directory place', () => {
    const { request } = route('client.tasks.configure');
    expect(parse(request, { id: task }).success).toBe(false);
    expect(parse(request, { id: task, place: null }).success).toBe(true);
    expect(
      parse(request, { id: task, place: { machine: 'laptop', directoryId: uuid } }).success,
    ).toBe(true);
    expect(parse(request, { id: task, title: sealed, effort: null }).success).toBe(true);
  });

  it('[contract-003] tasks/create takes a repeat with its end, and refuses times with until', () => {
    const { request } = route('client.tasks.create');
    const base = { id: task, title: sealed, input: sealed };
    for (const when of [
      'now',
      'backlog',
      'hold',
      { at: time },
      { every: 3_600_000, at: time, times: 3 },
      { cron: '0 9 * * 1', timezone: 'Europe/Lisbon', until: time, maxConcurrent: 2 },
      { after: { scheduleId: schedule, delayMs: 1000 } },
    ]) {
      expect(parse(request, { ...base, when }).success, JSON.stringify(when)).toBe(true);
    }
    for (const when of [
      'later',
      { every: 1000 },
      { every: 3_600_000, cron: '* * * * *', timezone: 'UTC' },
      { after: { scheduleId: schedule }, at: time },
      { every: 3_600_000, times: 3, until: time },
    ]) {
      expect(parse(request, { ...base, when }).success, JSON.stringify(when)).toBe(false);
    }
  });

  it('[contract-003] schedules/update takes the flat settings and refuses runsLeft with until', () => {
    const { request } = route('client.schedules.update');
    expect(parse(request, { ...scheduleUpdate, place: null }).success).toBe(true);
    expect(parse(request, { ...scheduleUpdate, runsLeft: 2, until: time }).success).toBe(false);
    expect(
      parse(request, {
        ...scheduleUpdate,
        repeat: { after: { scheduleId: other, delayMs: 5 } },
        at: time,
      }).success,
    ).toBe(false);
    expect(parse(request, { id: schedule, title: sealed, input: sealed }).success).toBe(false);
  });

  it('[contract-003] schedule routes carry the scheduling module and the schedules feature', () => {
    for (const entry of clientRoutes.filter((candidate) =>
      candidate.path.includes('/schedules/'),
    )) {
      expect(entry.module).toBe('scheduling');
      expect(entry.feature).toBe('schedules');
    }
  });

  it('[contract-003] transcript routes carry the transcripts feature', () => {
    for (const entry of clientRoutes.filter((candidate) =>
      candidate.path.includes('/transcript/'),
    )) {
      expect(entry.feature).toBe('transcripts');
    }
  });

  it('[contract-003] every client route that takes an id answers not-found', () => {
    for (const entry of clientRoutes) {
      const shape = (entry.request as z.ZodObject).shape as Record<string, unknown> | undefined;
      if (shape && ('id' in shape || 'runId' in shape)) {
        expect(entry.errors, entry.name).toContain('not-found');
      }
    }
  });

  it('[contract-003] a thread note carries who wrote it, and a server note body is plain text', () => {
    const detail = route('client.tasks.get').response;
    const withThread = (item: unknown) =>
      parse(detail, { task: uiTask, thread: [item], followUps: [], parent: null }).success;
    expect(withThread({ ...threadNote, by: 'laptop' })).toBe(true);
    expect(withThread({ ...threadNote, author: 'server', body: 'Run started.' })).toBe(true);
    expect(withThread({ ...threadNote, body: 'plain text' })).toBe(false);
    const withoutBy: Record<string, unknown> = { ...threadNote };
    delete withoutBy.by;
    expect(withThread(withoutBy)).toBe(false);
  });

  it('[contract-003] me and revision answer objects, never a bare value', () => {
    expect(parse(route('client.revision').response, null).success).toBe(false);
    expect(parse(route('client.revision').response, { revision: 'abc123' }).success).toBe(true);
    expect(parse(route('client.me').response, { username: 'owner', keyId: null }).success).toBe(
      true,
    );
    expect(parse(route('client.transcript.output').response, { output: null }).success).toBe(true);
  });
});
