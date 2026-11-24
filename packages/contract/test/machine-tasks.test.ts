import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { emptyResult, routeByName, routes, scheduleId } from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const blind = `abh1.${'A'.repeat(43)}`;
const task = 'Ab3dEf9xYz12';
const uuid = '591d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const time = '2026-11-13T10:00:00.000Z';
const run = 'R'.repeat(22);

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
  prs: [{ id: 'pr1', pr: sealed, state: null }],
  promptPrState: null,
  watches: null,
  watchStops: [],
};

const wireNote = {
  id: 'n1',
  body: sealed,
  preview: null,
  createdAt: time,
  author: 'agent',
  kind: 'comment',
};

const note = { body: sealed };

interface Case {
  command: string;
  request: Record<string, unknown>;
  response: unknown;
}

const cases: Case[] = [
  { command: 'list-tasks', request: {}, response: { tasks: [wireTask] } },
  { command: 'get-task', request: { id: task }, response: wireTask },
  { command: 'attach-session', request: { id: task }, response: wireTask },
  {
    command: 'add-task',
    request: { id: task, title: sealed, input: sealed },
    response: { task: wireTask, created: true },
  },
  { command: 'update-task', request: { id: task, status: 'todo' }, response: wireTask },
  { command: 'configure-task', request: { id: task, priority: 'high' }, response: wireTask },
  {
    command: 'edit-prompt',
    request: { id: task, title: sealed, input: sealed, previous: note },
    response: wireTask,
  },
  { command: 'claim-task', request: { id: task, machine: 'laptop' }, response: wireTask },
  { command: 'add-note', request: { id: task, ...note }, response: {} },
  {
    command: 'read-notes',
    request: { id: task },
    response: { notes: [wireNote, { ...wireNote, author: 'server', body: 'Marked done.' }] },
  },
  { command: 'ask', request: { id: task, body: sealed, questions: sealed }, response: {} },
  { command: 'add-pr', request: { id: task, pr: sealed }, response: {} },
  { command: 'remove-pr', request: { id: task, pr: 'pr1' }, response: {} },
  { command: 'set-pr-states', request: { id: task, prompt: 'open' }, response: {} },
  { command: 'set-watches', request: { id: task, watches: null }, response: {} },
  { command: 'ack-watch-stops', request: { id: task, ids: ['0123456789abcdef'] }, response: {} },
  { command: 'heartbeat', request: { id: task, lane: 'main', borrowed: false }, response: {} },
  { command: 'pause', request: { id: task, ...note }, response: wireTask },
  { command: 'fail', request: { id: task, ...note }, response: { applied: true, task: wireTask } },
  { command: 'stopped', request: { id: task, ...note }, response: wireTask },
  {
    command: 'run-inbox',
    request: { id: task },
    response: { stop: true, stopMessage: 'n1', messages: [wireNote] },
  },
  { command: 'ack-messages', request: { id: task, ids: ['n1'] }, response: {} },
  {
    command: 'wait',
    request: { id: task, ...note, wakeAt: time, check: false },
    response: wireTask,
  },
  { command: 'wake', request: { id: task, ...note }, response: { applied: false, task: wireTask } },
];

const route = (command: string) => routeByName(`machine.${command}` as 'machine.add-task');
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);

describe('machine commands: tasks, notes, pull requests, watches and run control', () => {
  it('[contract-003] every command of this file is registered', () => {
    const registered = routes.map((entry) => entry.name);
    expect(cases).toHaveLength(24);
    for (const entry of cases) expect(registered).toContain(`machine.${entry.command}`);
  });

  for (const entry of cases) {
    it(`[contract-003] ${entry.command} accepts a minimal valid request and refuses an unknown key`, () => {
      const { request, response } = route(entry.command);
      expect(parse(request, entry.request).success).toBe(true);
      expect(parse(request, { ...entry.request, extra: 1 }).success).toBe(false);
      expect(parse(response, entry.response).success).toBe(true);
      expect(parse(response, { ...(entry.response as object), extra: 1 }).success).toBe(false);
    });
  }

  it('[contract-003] every command that takes an id refuses a request without one', () => {
    for (const entry of cases) {
      if (!('id' in entry.request)) continue;
      const rest = Object.fromEntries(
        Object.entries(entry.request).filter(([key]) => key !== 'id'),
      );
      expect(parse(route(entry.command).request, rest).success).toBe(false);
    }
  });

  it('[contract-003] add-task takes directoryId, not workdir', () => {
    const { request } = route('add-task');
    const draft = { id: task, title: sealed, input: sealed };
    expect(parse(request, { ...draft, directoryId: uuid, projectId: uuid }).success).toBe(true);
    expect(parse(request, { ...draft, directoryId: null }).success).toBe(true);
    expect(parse(request, { ...draft, directoryId: 'not-a-uuid' }).success).toBe(false);
    expect(parse(request, { ...draft, workdir: sealed }).success).toBe(false);
  });

  it('[contract-003] update-task takes directoryId, not workdir, and needs a key besides expect', () => {
    const { request } = route('update-task');
    expect(parse(request, { id: task, directoryId: null }).success).toBe(true);
    expect(parse(request, { id: task, workdir: sealed }).success).toBe(false);
    expect(parse(request, { id: task, expect: 'todo' }).success).toBe(false);
    expect(parse(request, { id: task, run, expect: 'todo' }).success).toBe(false);
    expect(parse(request, { id: task, run, expect: 'todo', status: 'done' }).success).toBe(true);
  });

  it('[contract-003] a task answers directory ids and a sealed legacy directory, never workdir', () => {
    const { response } = route('get-task');
    expect(parse(response, { ...wireTask, legacyDirectory: sealed }).success).toBe(true);
    expect(parse(response, { ...wireTask, workdir: sealed }).success).toBe(false);
  });

  it('[contract-003] the request is flat: no body wrapper and no run outside the fenced commands', () => {
    expect(
      parse(route('update-task').request, { id: task, body: { status: 'todo' } }).success,
    ).toBe(false);
    expect(
      parse(route('heartbeat').request, { id: task, run, lane: 'main', borrowed: true }).success,
    ).toBe(true);
    expect(parse(route('wake').request, { id: task, run, ...note }).success).toBe(false);
    expect(parse(route('get-task').request, { id: task, run }).success).toBe(false);
  });

  it('[contract-003] ids refuse unsafe, reserved and malformed values', () => {
    const { request } = route('get-task');
    for (const id of [
      '',
      'a/b',
      '-lead',
      'dispatch',
      'intake',
      'listen',
      'watch',
      'x'.repeat(65),
      'a b',
    ]) {
      expect(parse(request, { id }).success).toBe(false);
    }
    expect(parse(route('claim-task').request, { id: task, machine: 'bad name' }).success).toBe(
      false,
    );
    expect(
      parse(route('heartbeat').request, { id: task, run: 'short', lane: 'l', borrowed: false })
        .success,
    ).toBe(false);
  });

  it('[contract-003] note ids may start with an underscore or a dash; schedule and pr ids share the task rule', () => {
    const acks = route('ack-messages').request;
    for (const id of ['_abc', '-abc', 'n1']) {
      expect(parse(acks, { id: task, ids: [id] }).success).toBe(true);
    }
    for (const id of ['', 'x'.repeat(65), 'a b']) {
      expect(parse(acks, { id: task, ids: [id] }).success).toBe(false);
    }
    const removal = route('remove-pr').request;
    for (const pr of ['listen', 'watch', 'dispatch', 'intake', '-pr']) {
      expect(parse(removal, { id: task, pr }).success).toBe(false);
    }
    expect(scheduleId.safeParse('watch').success).toBe(false);
    expect(scheduleId.safeParse('Sc3dEf9x').success).toBe(true);
  });

  it('[contract-003] sealed fields refuse plain text', () => {
    expect(
      parse(route('add-task').request, { id: task, title: 'plain', input: sealed }).success,
    ).toBe(false);
    expect(parse(route('ask').request, { id: task, body: sealed, questions: 'q' }).success).toBe(
      false,
    );
  });

  it('[contract-003] an empty success body is an object', () => {
    expect(emptyResult.safeParse({}).success).toBe(true);
    expect(emptyResult.safeParse(null).success).toBe(false);
    expect(route('add-note').response).toBe(emptyResult);
  });

  it('[contract-003] list-tasks answers an object with the tasks, not a bare array', () => {
    expect(parse(route('list-tasks').response, [wireTask]).success).toBe(false);
  });

  it('[contract-003] configure-task needs a setting and takes place by directory id', () => {
    const { request } = route('configure-task');
    expect(parse(request, { id: task }).success).toBe(false);
    expect(parse(request, { id: task, place: { directoryId: uuid } }).success).toBe(true);
    expect(parse(request, { id: task, place: null }).success).toBe(true);
    expect(parse(request, { id: task, place: { workdir: sealed } }).success).toBe(false);
    expect(parse(request, { id: task, machine: 'laptop', lane: null }).success).toBe(false);
  });

  it('[contract-003] add-note keeps the polish note and the suggestion with the agent', () => {
    const { request } = route('add-note');
    expect(parse(request, { id: task, ...note, kind: 'polish' }).success).toBe(true);
    expect(parse(request, { id: task, ...note, author: 'system', kind: 'polish' }).success).toBe(
      false,
    );
    expect(parse(request, { id: task, ...note, author: 'user' }).success).toBe(false);
    expect(
      parse(request, { id: task, ...note, author: 'system', suggestion: sealed }).success,
    ).toBe(false);
    expect(parse(request, { id: task, ...note, suggestion: sealed }).success).toBe(true);
  });

  it('[contract-003] edit-prompt refuses a suggestion in the previous note', () => {
    const { request } = route('edit-prompt');
    const edit = { id: task, title: sealed, input: sealed };
    expect(parse(request, { ...edit, previous: { ...note, suggestion: sealed } }).success).toBe(
      false,
    );
  });

  it('[contract-003] set-pr-states needs a state and at most 20 entries; set-pr is gone', () => {
    const { request } = route('set-pr-states');
    expect(parse(request, { id: task }).success).toBe(false);
    const entries = Array.from({ length: 21 }, (_, index) => ({ id: `p${index}`, state: 'open' }));
    expect(parse(request, { id: task, prs: entries }).success).toBe(false);
    expect(parse(request, { id: task, prs: entries.slice(1) }).success).toBe(true);
    expect(routes.map((entry) => entry.name)).not.toContain('machine.set-pr');
    expect(routes.map((entry) => entry.name)).not.toContain('machine.set-pr-state');
  });

  it('[contract-003] watch stops and acknowledged messages are bounded', () => {
    const hex = (n: number) => n.toString(16).padStart(16, '0');
    const stops = route('ack-watch-stops').request;
    expect(
      parse(stops, { id: task, ids: Array.from({ length: 32 }, (_, i) => hex(i)) }).success,
    ).toBe(true);
    expect(
      parse(stops, { id: task, ids: Array.from({ length: 33 }, (_, i) => hex(i)) }).success,
    ).toBe(false);
    expect(parse(stops, { id: task, ids: ['XYZ'] }).success).toBe(false);
    const acks = route('ack-messages').request;
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `n${i}`);
    expect(parse(acks, { id: task, ids: ids(100), stop: true }).success).toBe(true);
    expect(parse(acks, { id: task, ids: ids(101) }).success).toBe(false);
  });

  it('[contract-003] wait needs an ISO time and a check flag', () => {
    const { request } = route('wait');
    expect(parse(request, { id: task, ...note, wakeAt: 'tomorrow', check: false }).success).toBe(
      false,
    );
    expect(parse(request, { id: task, ...note, wakeAt: time }).success).toBe(false);
  });

  it('[contract-003] a server note carries plain text and any other author a sealed body', () => {
    const { response } = route('read-notes');
    expect(parse(response, { notes: [{ ...wireNote, body: 'plain' }] }).success).toBe(false);
    expect(
      parse(response, { notes: [{ ...wireNote, author: 'server', body: 'plain' }] }).success,
    ).toBe(true);
    expect(parse(response, { notes: [{ ...wireNote, author: 'bot' }] }).success).toBe(false);
  });
});
