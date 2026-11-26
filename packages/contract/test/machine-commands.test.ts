import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  EVENT_PING_MS,
  FEATURES,
  MACHINE_BODY_LIMIT,
  MACHINE_EVENT_DEBOUNCE_MS,
  TRANSCRIPT_BODY_LIMIT,
  machineEvent,
  machineRoutes,
  routeByName,
} from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const blind = `abh1.${'A'.repeat(43)}`;
const task = 'Ab3dEf9xYz12';
const schedule = 'Sc3dEf9x';
const uuid = '591d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const time = '2026-11-13T10:00:00.000Z';
const run = 'R'.repeat(22);
const feed = '0123456789abcdef';
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

const directory = { id: uuid, path: sealed, repo: null };
const wireDirectory = { ...directory, projectId: uuid };
const transcriptRun = {
  id: 'run-12345678',
  machine: 'laptop',
  sessionId: null,
  resumed: false,
  startedAt: time,
  lastEventAt: time,
  eventCount: 4,
};
const versionAnswer = {
  contract: 1,
  minClient: { cli: 1, web: 1 },
  minServer: 1,
  features: ['schedules', 'a-feature-from-a-newer-server'],
  server: { version: '1.0.0', commit: null },
  owner: 'owner',
  keyId: feed,
  machine: 'laptop',
  cli: '1.0.0',
  catalogIndex: blind,
  usageIndex: null,
  feedsIndex: null,
  feedRequests: [`pause:${feed}`],
  agentsVersion: 4,
  legacyDirs: false,
  grant: false,
  requestSignature: true,
};

interface Case {
  command: string;
  request: Record<string, unknown>;
  response: unknown;
}

const cases: Case[] = [
  { command: 'version', request: {}, response: versionAnswer },
  {
    command: 'register-key',
    request: { publicKey: 'MCowBQYDK2VwAyEA', label: 'laptop' },
    response: { keyId: feed },
  },
  { command: 'revoke-token', request: {}, response: {} },
  { command: 'set-catalog', request: { catalog: sealed, index: blind }, response: {} },
  { command: 'set-usage', request: { usage: sealed, index: blind }, response: {} },
  { command: 'set-feeds', request: { feeds: sealed, index: blind }, response: {} },
  { command: 'ack-feed-requests', request: { requests: [`run:${feed}`] }, response: {} },
  {
    command: 'list-machines',
    request: {},
    response: { machines: [{ name: 'laptop', lastSeenAt: null, current: true }] },
  },
  { command: 'get-agents', request: {}, response: { agents: { version: 4, document: sealed } } },
  {
    command: 'set-agents',
    request: { document: sealed, version: 5, expectedVersion: 4 },
    response: {},
  },
  { command: 'get-title-rules', request: {}, response: { titleRules: null } },
  {
    command: 'apply-title-rule',
    request: { id: task, run, icon: sealed },
    response: { icon: true, labels: false, title: false },
  },
  {
    command: 'set-dirs',
    request: { directories: [directory] },
    response: { directories: [wireDirectory] },
  },
  {
    command: 'get-legacy-dirs',
    request: {},
    response: { document: null, tasks: [{ kind: 'task', id: task, legacyDirectory: sealed }] },
  },
  {
    command: 'convert-legacy-dirs',
    request: {
      directories: [directory],
      assign: [{ kind: 'schedule', id: schedule, directoryId: uuid }],
    },
    response: { inserted: 1, assigned: 1 },
  },
  { command: 'list-projects', request: {}, response: { projects: [] } },
  {
    command: 'add-schedule',
    request: { id: schedule, title: sealed, input: sealed, everyMs: 60_000 },
    response: { schedule: wireSchedule, task: wireTask },
  },
  { command: 'list-schedules', request: {}, response: { schedules: [wireSchedule] } },
  {
    command: 'update-schedule',
    request: { id: schedule, paused: true },
    response: wireSchedule,
  },
  {
    command: 'edit-schedule',
    request: { id: schedule, title: sealed, input: sealed },
    response: { schedule: wireSchedule, pending: 'updated' },
  },
  { command: 'remove-schedule', request: { id: schedule }, response: {} },
  {
    command: 'answer',
    request: { id: task, questionNoteId: 'n1', answers: sealed, message: note },
    response: wireTask,
  },
  {
    command: 'dismiss-question',
    request: { id: task, questionNoteId: 'n1' },
    response: wireTask,
  },
  { command: 'reply', request: { id: task, message: note, resume: true }, response: wireTask },
  { command: 'send', request: { id: task, message: note }, response: wireTask },
  { command: 'stop', request: { id: task }, response: wireTask },
  { command: 'take-back', request: { id: task }, response: wireTask },
  { command: 'rerun', request: { id: task }, response: wireTask },
  { command: 'set-closed', request: { id: task, closed: true }, response: wireTask },
  {
    command: 'fork',
    request: { id: 'Fk3dEf9x', parentId: task, title: sealed, input: sealed, directoryId: null },
    response: wireTask,
  },
  { command: 'list-runs', request: { id: task }, response: { runs: [transcriptRun] } },
  {
    command: 'transcript-events',
    request: { runId: 'run-12345678' },
    response: {
      events: [{ seq: 0, at: time, kind: 'text', parent: null, data: sealed, outputSize: null }],
    },
  },
  {
    command: 'transcript-output',
    request: { runId: 'run-12345678', seq: 3 },
    response: { output: null },
  },
  {
    command: 'transcript',
    request: {
      id: task,
      runId: 'run-12345678',
      startedAt: time,
      sessionId: null,
      resumed: false,
      events: [],
    },
    response: {},
  },
];

const route = (command: string) => routeByName(`machine.${command}` as 'machine.add-task');
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);
const accepts = (command: string, request: unknown) =>
  parse(route(command).request, request).success;

const KEPT_AND_NEW = [
  'ack-feed-requests',
  'ack-messages',
  'ack-watch-stops',
  'add-note',
  'add-pr',
  'add-task',
  'answer',
  'ask',
  'attach-session',
  'claim-task',
  'configure-task',
  'convert-legacy-dirs',
  'dismiss-question',
  'edit-prompt',
  'edit-schedule',
  'fail',
  'fork',
  'get-agents',
  'get-legacy-dirs',
  'get-task',
  'get-title-rules',
  'heartbeat',
  'list-machines',
  'list-projects',
  'list-runs',
  'list-schedules',
  'list-tasks',
  'pause',
  'read-notes',
  'register-key',
  'remove-pr',
  'remove-schedule',
  'reply',
  'rerun',
  'revoke-token',
  'run-inbox',
  'send',
  'set-agents',
  'set-catalog',
  'set-closed',
  'set-dirs',
  'set-feeds',
  'set-pr-states',
  'set-usage',
  'set-watches',
  'stop',
  'stopped',
  'take-back',
  'transcript-events',
  'transcript-output',
  'update-schedule',
  'update-task',
  'version',
  'wait',
  'wake',
  'add-schedule',
  'apply-title-rule',
];

describe('machine commands: handshake, documents, directories, schedules, user-authored, transcript, events', () => {
  it('[contract-003] the machine command list is exactly:', () => {
    const names = machineRoutes.map((entry) => entry.name.slice('machine.'.length));
    const rest = names.filter((name) => name !== 'transcript' && name !== 'events');
    expect(rest).toHaveLength(57);
    expect([...rest].sort()).toEqual([...KEPT_AND_NEW].sort());
    expect(names).toContain('transcript');
    expect(names).toContain('events');
    expect(machineRoutes).toHaveLength(59);
  });

  it('[contract-003] every machine command has request, response and errors', () => {
    for (const entry of machineRoutes) {
      expect(entry.request).toBeDefined();
      expect(entry.response).toBeDefined();
      expect(Array.isArray(entry.errors)).toBe(true);
    }
  });

  it('[contract-003] every command not covered by the task suite has a case here', () => {
    const covered = new Set(cases.map((entry) => entry.command));
    const missing = machineRoutes
      .map((entry) => entry.name.slice('machine.'.length))
      .filter((name) => name !== 'events' && !covered.has(name));
    expect(missing).toHaveLength(24);
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

  it('[contract-003] set-pr and set-pr-state are not in the contract', () => {
    const names = machineRoutes.map((entry) => entry.name);
    expect(names).not.toContain('machine.set-pr');
    expect(names).not.toContain('machine.set-pr-state');
  });

  it('[contract-003] version answers legacyDirs and no dirsIndex', () => {
    const { response } = route('version');
    expect(parse(response, versionAnswer).success).toBe(true);
    expect(parse(response, { ...versionAnswer, legacyDirs: undefined }).success).toBe(false);
    expect(parse(response, { ...versionAnswer, dirsIndex: blind }).success).toBe(false);
  });

  it('[contract-003] version lists features as plain strings so a newer server still parses', () => {
    const { response } = route('version');
    const answer = parse(response, versionAnswer);
    expect(answer.success && (answer.data as { features: string[] }).features).toContain(
      'a-feature-from-a-newer-server',
    );
    expect(FEATURES).not.toContain('a-feature-from-a-newer-server');
  });

  it('[contract-003] feed requests are action and 16 hex characters', () => {
    const { request } = route('ack-feed-requests');
    expect(parse(request, { requests: [`pause:${feed}`, `resume:${feed}`] }).success).toBe(true);
    for (const bad of [`stop:${feed}`, 'run:XYZ', `run:${feed}:x`, feed]) {
      expect(parse(request, { requests: [bad] }).success).toBe(false);
    }
    const many = (count: number) => Array.from({ length: count }, () => `run:${feed}`);
    expect(parse(request, { requests: many(150) }).success).toBe(true);
    expect(parse(request, { requests: many(151) }).success).toBe(false);
  });

  it('[contract-003] documents take a sealed value and a blind index, not plain text', () => {
    expect(accepts('set-catalog', { catalog: 'plain', index: blind })).toBe(false);
    expect(accepts('set-catalog', { catalog: sealed, index: 'plain' })).toBe(false);
    expect(accepts('set-catalog', { catalog: sealed })).toBe(false);
    expect(accepts('set-usage', { catalog: sealed, index: blind })).toBe(false);
  });

  it('[contract-003] set-agents is a compare-and-set whose version is expectedVersion plus one', () => {
    expect(accepts('set-agents', { document: sealed, version: 1, expectedVersion: 0 })).toBe(true);
    expect(accepts('set-agents', { document: sealed, version: 6, expectedVersion: 4 })).toBe(false);
    expect(accepts('set-agents', { document: sealed, version: 0, expectedVersion: -1 })).toBe(
      false,
    );
    expect(route('set-agents').errors).toContain('version-conflict');
  });

  it('[contract-003] apply-title-rule needs a run, a part, and expectTitle with title', () => {
    expect(accepts('apply-title-rule', { id: task, icon: sealed })).toBe(false);
    expect(accepts('apply-title-rule', { id: task, run })).toBe(false);
    expect(accepts('apply-title-rule', { id: task, run, title: sealed })).toBe(false);
    expect(accepts('apply-title-rule', { id: task, run, expectTitle: sealed, icon: sealed })).toBe(
      false,
    );
    expect(accepts('apply-title-rule', { id: task, run, title: sealed, expectTitle: sealed })).toBe(
      true,
    );
  });

  it('[contract-003] get-agents and get-title-rules answer an object, null inside when none is saved', () => {
    expect(parse(route('get-agents').response, { agents: null }).success).toBe(true);
    expect(parse(route('get-agents').response, null).success).toBe(false);
    expect(
      parse(route('get-title-rules').response, { titleRules: { version: 3, document: sealed } })
        .success,
    ).toBe(true);
  });

  it('[contract-003] register-key is marked issuesCredential', () => {
    expect(route('register-key').issuesCredential).toBe(true);
    expect(route('register-key').feature).toBe('request-signature');
    expect(route('register-key').errors).toContain('conflict');
    expect(
      machineRoutes.filter((entry) => entry.issuesCredential).map((entry) => entry.name),
    ).toEqual(['machine.register-key']);
    expect(accepts('register-key', { publicKey: '', label: 'x' })).toBe(false);
    expect(accepts('register-key', { publicKey: 'a'.repeat(201), label: 'x' })).toBe(false);
    expect(accepts('register-key', { publicKey: 'abc', label: 'x'.repeat(65) })).toBe(false);
    expect(accepts('register-key', { publicKey: 'a+b/c=', label: 'x' })).toBe(false);
  });

  it('[contract-003] set-dirs takes directory ids and sealed paths, at most 200, and carries its errors', () => {
    const { request, errors } = route('set-dirs');
    expect(errors).toEqual(expect.arrayContaining(['directory-in-use', 'not-found']));
    expect(
      parse(request, { directories: [{ ...directory, projectId: uuid, repo: sealed }] }).success,
    ).toBe(true);
    expect(parse(request, { directories: [{ ...directory, path: '/plain' }] }).success).toBe(false);
    expect(parse(request, { directories: [{ ...directory, id: 'not-a-uuid' }] }).success).toBe(
      false,
    );
    const many = (count: number) => Array.from({ length: count }, () => directory);
    expect(parse(request, { directories: many(200) }).success).toBe(true);
    expect(parse(request, { directories: many(201) }).success).toBe(false);
  });

  it('[contract-003] legacy directory conversion names kinds, ids and directories', () => {
    const { request, response } = route('convert-legacy-dirs');
    const body = { directories: [], assign: [{ kind: 'task', id: task, directoryId: uuid }] };
    expect(parse(request, body).success).toBe(true);
    expect(
      parse(request, { ...body, assign: [{ kind: 'note', id: task, directoryId: uuid }] }).success,
    ).toBe(false);
    expect(parse(response, { inserted: 0, assigned: 0 }).success).toBe(true);
    expect(route('get-legacy-dirs').feature).toBe('legacy-dirs');
    expect(route('convert-legacy-dirs').feature).toBe('legacy-dirs');
  });

  it('[contract-003] the project list is a feature-marked machine route returning wire projects', () => {
    const { request, response } = route('list-projects');
    expect(parse(request, {}).success).toBe(true);
    expect(parse(request, { all: true }).success).toBe(false);
    expect(parse(response, { projects: [] }).success).toBe(true);
    expect(route('list-projects').feature).toBe('machine-projects');
  });

  it('[contract-003] a schedule carries directoryId and projectId, never workdir', () => {
    const draft = { id: schedule, title: sealed, input: sealed, everyMs: 60_000 };
    expect(
      accepts('add-schedule', { ...draft, machine: 'laptop', directoryId: uuid, projectId: uuid }),
    ).toBe(true);
    expect(accepts('add-schedule', { ...draft, machine: 'laptop', workdir: sealed })).toBe(false);
    expect(accepts('add-schedule', { ...draft, machine: 'laptop' })).toBe(false);
    expect(accepts('add-schedule', { ...draft, directoryId: uuid })).toBe(false);
    expect(
      parse(route('list-schedules').response, { schedules: [{ ...wireSchedule, workdir: sealed }] })
        .success,
    ).toBe(false);
    expect(parse(route('list-schedules').response, [wireSchedule]).success).toBe(false);
  });

  it('[contract-003] add-schedule takes exactly one rule and the keys that go with it', () => {
    const base = { id: schedule, title: sealed, input: sealed };
    const after = { scheduleId: 'Other123' };
    expect(accepts('add-schedule', base)).toBe(false);
    expect(
      accepts('add-schedule', { ...base, everyMs: 60_000, cron: '* * * * *', timezone: 'UTC' }),
    ).toBe(false);
    expect(accepts('add-schedule', { ...base, everyMs: 59_999 })).toBe(false);
    expect(accepts('add-schedule', { ...base, everyMs: 10 * 365 * 24 * 60 * 60_000 + 1 })).toBe(
      false,
    );
    expect(accepts('add-schedule', { ...base, cron: '0 9 * * *' })).toBe(false);
    expect(accepts('add-schedule', { ...base, cron: '0 9 * * *', timezone: 'Europe/Lisbon' })).toBe(
      true,
    );
    expect(accepts('add-schedule', { ...base, everyMs: 60_000, timezone: 'UTC' })).toBe(false);
    expect(accepts('add-schedule', { ...base, everyMs: 60_000, moreCrons: ['* * * * *'] })).toBe(
      false,
    );
    const nine = Array.from({ length: 9 }, () => '* * * * *');
    expect(
      accepts('add-schedule', { ...base, cron: '0 9 * * *', timezone: 'UTC', moreCrons: nine }),
    ).toBe(true);
    expect(
      accepts('add-schedule', {
        ...base,
        cron: '0 9 * * *',
        timezone: 'UTC',
        moreCrons: [...nine, '* * * * *'],
      }),
    ).toBe(false);
    expect(accepts('add-schedule', { ...base, after })).toBe(true);
    expect(accepts('add-schedule', { ...base, after: { ...after, delayMs: 0 } })).toBe(true);
    expect(accepts('add-schedule', { ...base, after: { scheduleId: schedule } })).toBe(false);
    expect(accepts('add-schedule', { ...base, after, startAt: time })).toBe(false);
  });

  it('[contract-003] add-schedule limits times, until, concurrency and the answer task', () => {
    const base = { id: schedule, title: sealed, input: sealed, everyMs: 60_000 };
    expect(accepts('add-schedule', { ...base, times: 1 })).toBe(true);
    expect(accepts('add-schedule', { ...base, times: 0 })).toBe(false);
    expect(accepts('add-schedule', { ...base, times: 2_147_483_648 })).toBe(false);
    expect(accepts('add-schedule', { ...base, until: time })).toBe(true);
    expect(accepts('add-schedule', { ...base, times: 2, until: time })).toBe(false);
    expect(accepts('add-schedule', { ...base, maxConcurrent: 100 })).toBe(true);
    expect(accepts('add-schedule', { ...base, maxConcurrent: 101 })).toBe(false);
    expect(
      parse(route('add-schedule').response, { schedule: wireSchedule, task: null }).success,
    ).toBe(true);
  });

  it('[contract-003] edit-schedule settings replace the rule and refuse runsLeft with until', () => {
    const settings = {
      place: null,
      priority: 'normal',
      model: null,
      autoDone: false,
      repeat: { everyMs: 60_000 },
      runsLeft: null,
      until: null,
      maxConcurrent: null,
    };
    const edit = (value: Record<string, unknown>) =>
      accepts('edit-schedule', { id: schedule, title: sealed, input: sealed, settings: value });
    expect(edit(settings)).toBe(true);
    expect(edit({ ...settings, place: { machine: 'laptop', directoryId: uuid } })).toBe(true);
    expect(edit({ ...settings, place: { machine: 'laptop', workdir: sealed } })).toBe(false);
    expect(edit({ ...settings, runsLeft: 2, until: time })).toBe(false);
    expect(edit({ ...settings, runsLeft: 2 })).toBe(true);
    expect(edit({ ...settings, repeat: { everyMs: 60_000, cron: '* * * * *' } })).toBe(false);
    expect(edit({ ...settings, repeat: { cron: '* * * * *' } })).toBe(false);
    expect(edit({ ...settings, repeat: { cron: '* * * * *', timezone: 'UTC' } })).toBe(true);
    expect(edit({ ...settings, repeat: { after: { scheduleId: 'Other123', delayMs: 0 } } })).toBe(
      true,
    );
    expect(edit({ ...settings, repeat: { after: { scheduleId: 'Other123' } } })).toBe(false);
    expect(
      edit({ ...settings, repeat: { after: { scheduleId: 'Other123', delayMs: 0 } }, at: time }),
    ).toBe(false);
    expect(edit({ ...settings, extra: 1 })).toBe(false);
    const incomplete = Object.fromEntries(
      Object.entries(settings).filter(([key]) => key !== 'maxConcurrent'),
    );
    expect(edit(incomplete)).toBe(false);
    expect(
      parse(route('edit-schedule').response, { schedule: wireSchedule, pending: 'later' }).success,
    ).toBe(false);
  });

  it('[contract-003] schedule commands carry the scheduling module and the schedules feature', () => {
    for (const command of [
      'add-schedule',
      'list-schedules',
      'update-schedule',
      'edit-schedule',
      'remove-schedule',
    ]) {
      expect(route(command).module).toBe('scheduling');
      expect(route(command).feature).toBe('schedules');
    }
    expect(route('remove-schedule').errors).toContain('conflict');
  });

  it('[contract-003] the twelve user-authored commands declare grant-required and run-holds-task', () => {
    const commands = [
      'answer',
      'dismiss-question',
      'reply',
      'send',
      'stop',
      'take-back',
      'rerun',
      'set-closed',
      'fork',
      'list-runs',
      'transcript-events',
      'transcript-output',
    ];
    for (const command of commands) {
      expect(route(command).errors).toEqual(
        expect.arrayContaining(['grant-required', 'run-holds-task', 'not-found']),
      );
      expect(route(command).feature).toBe('machine-grant');
    }
    expect(machineRoutes.filter((entry) => entry.errors.includes('grant-required'))).toHaveLength(
      12,
    );
  });

  it('[contract-003] user-authored commands take the browser action inputs, flat', () => {
    expect(
      accepts('answer', { id: task, questionNoteId: 'n1', answers: 'plain', message: note }),
    ).toBe(false);
    expect(
      accepts('answer', { id: task, questionNoteId: '_n1', answers: sealed, message: note }),
    ).toBe(true);
    expect(accepts('reply', { id: task, message: note })).toBe(false);
    expect(accepts('stop', { id: task, message: note })).toBe(true);
    expect(accepts('stop', { id: task, message: 'plain' })).toBe(false);
    expect(accepts('set-closed', { id: task })).toBe(false);
    expect(
      accepts('fork', {
        id: 'Fk3dEf9x',
        parentId: task,
        title: sealed,
        input: sealed,
        workdir: sealed,
      }),
    ).toBe(false);
    expect(
      accepts('fork', {
        id: 'Fk3dEf9x',
        parentId: task,
        title: sealed,
        input: sealed,
        directoryId: uuid,
        agent: sealed,
      }),
    ).toBe(true);
    expect(accepts('rerun', { id: 'dispatch' })).toBe(false);
  });

  it('[contract-003] transcript reads take a run id, an optional position and answer objects', () => {
    expect(accepts('transcript-events', { runId: 'run-12345678', afterSeq: 10 })).toBe(true);
    expect(accepts('transcript-events', { runId: 'short' })).toBe(false);
    expect(accepts('transcript-events', { runId: 'run-12345678', afterSeq: -1 })).toBe(false);
    expect(accepts('transcript-output', { runId: 'run-12345678' })).toBe(false);
    expect(parse(route('transcript-output').response, { output: sealed }).success).toBe(true);
    expect(parse(route('list-runs').response, [transcriptRun]).success).toBe(false);
  });

  it('[contract-003] the transcript upload takes 16 MiB and other machine commands 2 MiB', () => {
    expect(route('transcript').bodyLimit).toBe(TRANSCRIPT_BODY_LIMIT);
    expect(TRANSCRIPT_BODY_LIMIT).toBe(16 * 1024 * 1024);
    expect(MACHINE_BODY_LIMIT).toBe(2 * 1024 * 1024);
    for (const entry of machineRoutes) {
      if (entry.name !== 'machine.transcript') expect(entry.bodyLimit).toBeUndefined();
    }
    expect(route('transcript').feature).toBe('transcripts');
    expect(route('transcript').path).toBe('/api/machine/transcript');
  });

  it('[contract-003] a transcript batch holds at most 5000 events and only tool results carry output', () => {
    const batch = {
      id: task,
      runId: 'run-12345678',
      startedAt: time,
      sessionId: uuid,
      resumed: true,
    };
    const event = { seq: 0, at: time, kind: 'text', parent: 'toolu_01-A', data: sealed };
    const result = { ...event, kind: 'tool_result', output: sealed, outputSize: 12 };
    expect(accepts('transcript', { ...batch, events: [event, result] })).toBe(true);
    expect(accepts('transcript', { ...batch, events: [{ ...event, output: sealed }] })).toBe(false);
    expect(accepts('transcript', { ...batch, events: [{ ...event, outputSize: 1 }] })).toBe(false);
    expect(
      accepts('transcript', { ...batch, events: [{ ...result, outputSize: undefined }] }),
    ).toBe(false);
    expect(
      accepts('transcript', { ...batch, events: [{ ...result, outputSize: 256 * 1024 + 1025 }] }),
    ).toBe(false);
    expect(accepts('transcript', { ...batch, events: [{ ...event, kind: 'unknown' }] })).toBe(
      false,
    );
    expect(accepts('transcript', { ...batch, events: [{ ...event, kind: 'context' }] })).toBe(true);
    expect(accepts('transcript', { ...batch, events: [{ ...event, seq: 2_147_483_648 }] })).toBe(
      false,
    );
    expect(accepts('transcript', { ...batch, events: [{ ...event, seq: -1 }] })).toBe(false);
    expect(accepts('transcript', { ...batch, events: [{ ...event, parent: 'a b' }] })).toBe(false);
    expect(accepts('transcript', { ...batch, events: [{ ...event, parent: null }] })).toBe(true);
    expect(accepts('transcript', { ...batch, events: [{ ...event, data: 'plain' }] })).toBe(false);
    const many = (count: number) => Array.from({ length: count }, (_, seq) => ({ ...event, seq }));
    expect(accepts('transcript', { ...batch, events: many(5000) })).toBe(true);
    expect(accepts('transcript', { ...batch, events: many(5001) })).toBe(false);
  });

  it('[contract-003] the machine event stream declares the tasks event', () => {
    const events = routeByName('machine.events');
    expect(events.method).toBe('GET');
    expect(events.path).toBe('/api/machine/events');
    expect(events.auth).toBe('machine');
    expect(events.stream).toBe(true);
    expect(parse(events.request, {}).success).toBe(true);
    expect(parse(events.request, { project: uuid }).success).toBe(false);
    expect(machineEvent.safeParse({ event: 'tasks', data: {} }).success).toBe(true);
    expect(machineEvent.safeParse({ event: 'changed', data: {} }).success).toBe(false);
    expect(machineEvent.safeParse({ event: 'tasks', data: { id: task } }).success).toBe(false);
    expect(EVENT_PING_MS).toBe(25_000);
    expect(MACHINE_EVENT_DEBOUNCE_MS).toBe(500);
  });

  it('[contract-003] commands that name a directory refuse a path that is not a uuid', () => {
    expect(
      accepts('convert-legacy-dirs', {
        directories: [],
        assign: [{ kind: 'task', id: task, directoryId: 'x' }],
      }),
    ).toBe(false);
  });
});
