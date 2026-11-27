import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bindings } from '@rumo/sealing';

import type { RouteOutput } from '../client/contract-client.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import type { UnlockedKey } from '../fixtures/keys.js';
import { unlockedKey } from '../fixtures/keys.js';
import { createTask, type CreatedTask, type TaskInput } from '../fixtures/tasks.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';
import { killStubTree, type RunResult } from '../harness/run.js';
import type { RunningCli } from '../harness/cli.js';
import {
  createProject as createSealedProject,
  readStubLog,
  sleep,
  stdinTexts,
  type StubEntry,
} from './worker.js';

export type TaskDetail = RouteOutput<'client.tasks.get'>;
export type WireTaskView = TaskDetail['task'];
export type ListedTask = RouteOutput<'client.tasks.list'>['tasks'][number];
type ThreadNote = TaskDetail['thread'][number];

export const GRANT_HINT = 'Settings › Machines';
export const TAKE_BACK_QUIET_SECONDS = 20 * 60;

const POLL_MS = 250;
const SETTLE_MS = 40_000;

export interface Fixture {
  readonly board: Board;
  readonly user: BoardUser;
  readonly key: UnlockedKey;
  readonly runner: EnrolledMachine;
  readonly operator: EnrolledMachine;
  readonly plain: EnrolledMachine;
  readonly workdir: string;
  readonly stubLog: string;
  readonly listener: RunningCli | null;
  readonly taskIds: string[];
}

export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | null = null;
  return () => {
    started ??= make();
    return started;
  };
}

export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = SETTLE_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

export async function startFixture(
  board: Board,
  options: { readonly worker: boolean; readonly label?: string },
): Promise<Fixture> {
  const user = await noLoginUser(board);
  const key = await unlockedKey(board, user);
  const workdir = board.tmp.path('workdir');
  mkdirSync(workdir, { recursive: true });
  const stubLog = board.tmp.path('stub-claude.jsonl');
  const prefix = options.label ?? 'uc';
  const runner = await enrolledMachine(board, user, {
    key,
    name: `${prefix}-runner`,
    actsAsOwner: true,
    env: { STUB_CLAUDE_LOG: stubLog },
  });
  const operator = await enrolledMachine(board, user, {
    key,
    name: `${prefix}-operator`,
    actsAsOwner: true,
  });
  const plain = await enrolledMachine(board, user, { key, name: `${prefix}-plain` });
  await expectOk(runner.cli(['config', 'set', 'defaultCwd', workdir]), 'config set defaultCwd');
  const listener = options.worker ? runner.start(['internal', 'listen']) : null;
  return { board, user, key, runner, operator, plain, workdir, stubLog, listener, taskIds: [] };
}

export async function expectOk(run: Promise<RunResult>, what: string): Promise<RunResult> {
  const result = await run;
  if (result.code !== 0) {
    throw new Error(`${what} exited ${result.code}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

export async function finishFixture(fixture: Fixture | null): Promise<void> {
  if (fixture === null) return;
  try {
    for (const id of fixture.taskIds) {
      await fixture.user.call('client.tasks.stop', { id }).catch(() => undefined);
    }
    await fixture.listener?.stop().catch(() => undefined);
  } finally {
    killStubTree(fixture.stubLog);
  }
}

export async function newTask(
  fixture: Fixture,
  prompt: string,
  options: Partial<Omit<TaskInput, 'prompt'>> = {},
): Promise<CreatedTask> {
  const task = await createTask(fixture.board, fixture.user, fixture.key, {
    prompt,
    autoDone: true,
    ...options,
  });
  fixture.taskIds.push(task.id);
  return task;
}

export async function getTask(fixture: Fixture, id: string): Promise<TaskDetail> {
  return fixture.user.ok('client.tasks.get', { id });
}

export async function waitForTask(
  fixture: Fixture,
  id: string,
  what: string,
  accept: (detail: TaskDetail) => boolean,
  timeoutMs = SETTLE_MS,
): Promise<TaskDetail> {
  return waitUntil(
    `task ${id} ${what}`,
    async () => {
      const detail = await getTask(fixture, id);
      return accept(detail) ? detail : null;
    },
    timeoutMs,
  );
}

export function waitForStatus(
  fixture: Fixture,
  id: string,
  status: WireTaskView['status'],
  timeoutMs = SETTLE_MS,
): Promise<TaskDetail> {
  return waitForTask(fixture, id, `status ${status}`, (d) => d.task.status === status, timeoutMs);
}

export async function runningTask(
  fixture: Fixture,
  prompt = '#stub: sleep 120',
): Promise<CreatedTask> {
  const task = await newTask(fixture, prompt);
  await waitForStatus(fixture, task.id, 'running');
  return task;
}

export interface FinishedTask {
  readonly task: CreatedTask;
  readonly runId: string;
  readonly toolSeq: number;
}

export async function finishedTask(fixture: Fixture): Promise<FinishedTask> {
  const task = await newTask(fixture, '#stub: tool Grep');
  await waitForStatus(fixture, task.id, 'done');
  return uploadedRun(fixture, task);
}

export async function uploadedRun(fixture: Fixture, task: CreatedTask): Promise<FinishedTask> {
  return waitUntil(
    `the uploaded transcript of ${task.id}`,
    async () => {
      const { runs } = await fixture.operator.ok('machine.list-runs', { id: task.id });
      const run = runs[0];
      if (run === undefined) return null;
      const { events } = await fixture.operator.ok('machine.transcript-events', {
        runId: run.id,
      });
      const tool = events.find((event) => event.kind === 'tool_result');
      return tool === undefined ? null : { task, runId: run.id, toolSeq: tool.seq };
    },
    60_000,
  );
}

export interface AskedTask {
  readonly task: CreatedTask;
  readonly questionNoteId: string;
}

export function questionsFile(header: string, labels: readonly string[]): string {
  return JSON.stringify({
    questions: [
      {
        header,
        question: `${header}: which ones?`,
        multiSelect: true,
        options: labels.map((label) => ({ label, description: `${label} option` })),
      },
    ],
  });
}

export async function askingTask(fixture: Fixture, labels: readonly string[]): Promise<AskedTask> {
  const task = await newTask(fixture, `#stub: ask ${questionsFile('Pick', labels)}`);
  const asked = await waitForTask(
    fixture,
    task.id,
    'an open question',
    (detail) => detail.task.openQuestion,
  );
  const note = [...asked.thread].reverse().find((entry) => entry.kind === 'question');
  if (note === undefined)
    throw new Error(`task ${task.id} has an open question but no question note`);
  return { task, questionNoteId: note.id };
}

export interface ThreadEntry {
  readonly id: string;
  readonly author: ThreadNote['author'];
  readonly kind: ThreadNote['kind'];
  readonly by: string | null;
  readonly text: string;
  readonly answers: string | null;
  readonly raw: ThreadNote;
}

export async function threadOf(
  fixture: Pick<Fixture, 'user' | 'key'>,
  taskId: string,
): Promise<ThreadEntry[]> {
  const { thread } = await fixture.user.ok('client.tasks.get', { id: taskId });
  const entries: ThreadEntry[] = [];
  for (const note of thread) {
    if (note.author === 'server') {
      entries.push({
        id: note.id,
        author: note.author,
        kind: note.kind,
        by: note.by,
        text: note.body,
        answers: null,
        raw: note,
      });
      continue;
    }
    const noteBinding = (field: 'note.body' | 'note.answers') =>
      bindings.note({ field, taskId, author: note.author, kind: note.kind });
    entries.push({
      id: note.id,
      author: note.author,
      kind: note.kind,
      by: note.by,
      text: await fixture.key.open(noteBinding('note.body'), note.body),
      answers:
        note.answers === undefined
          ? null
          : await fixture.key.open(noteBinding('note.answers'), note.answers),
      raw: note,
    });
  }
  return entries;
}

export async function sealedMessage(
  key: UnlockedKey,
  taskId: string,
  kind: 'comment' | 'answer',
  text: string,
): Promise<{ body: string }> {
  return {
    body: await key.seal(bindings.note({ field: 'note.body', taskId, author: 'user', kind }), text),
  };
}

export function sealedAnswers(
  key: UnlockedKey,
  taskId: string,
  picks: readonly string[],
): Promise<string> {
  return key.seal(
    bindings.note({ field: 'note.answers', taskId, author: 'user', kind: 'answer' }),
    JSON.stringify([{ picks, other: null }]),
  );
}

export function stubEntries(fixture: Pick<Fixture, 'stubLog'>): StubEntry[] {
  return readStubLog(fixture.stubLog);
}

export function stubStdin(fixture: Pick<Fixture, 'stubLog'>): string[] {
  return stdinTexts(stubEntries(fixture));
}

export function stubInterrupts(fixture: Pick<Fixture, 'stubLog'>, pid?: number): number {
  return stubEntries(fixture).filter(
    (entry) =>
      (entry.kind === 'signal' || entry.kind === 'stdin-closed') &&
      (pid === undefined || entry.pid === pid),
  ).length;
}

export function stubPidOf(fixture: Pick<Fixture, 'stubLog'>, marker: string): Promise<number> {
  return waitUntil(`the stub that received ${marker}`, () => {
    const entry = stubEntries(fixture).find(
      (line) => line.kind === 'stdin' && String(line.text).includes(marker),
    );
    return entry === undefined ? null : Number(entry.pid);
  });
}

export async function refusedInsideRun(fixture: Fixture, args: readonly string[]): Promise<number> {
  const task = await newTask(fixture, `#stub: rumo ${args.join(' ')}`);
  await waitForStatus(fixture, task.id, 'done');
  const entry = [...stubEntries(fixture)]
    .reverse()
    .find((line) => line.kind === 'rumo' && JSON.stringify(line.args) === JSON.stringify(args));
  if (entry === undefined) throw new Error(`the stub did not run rumo ${args.join(' ')}`);
  return Number(entry.code);
}

export function combined(result: RunResult): string {
  return `${result.stdout}${result.stderr}`;
}

export function writeWorkFile(
  fixture: Pick<Fixture, 'workdir'>,
  name: string,
  text: string,
): string {
  const file = path.join(fixture.workdir, name);
  writeFileSync(file, text);
  return file;
}

export function uniqueLabel(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

export interface EventLine {
  readonly type: string;
  readonly task: string;
  readonly status?: string;
  readonly actor?: string;
  readonly machine?: string | null;
  readonly project?: string;
}

export function parseEventLines(stdout: string): EventLine[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as EventLine);
}

async function quiet(read: () => number, quietMs: number): Promise<void> {
  let last = read();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await sleep(POLL_MS / 5);
    const current = read();
    if (current !== last) {
      last = current;
      since = Date.now();
    }
  }
}

export async function collectEvents(
  machine: EnrolledMachine,
  filters: readonly string[],
  act: () => Promise<void>,
  done: (lines: EventLine[]) => boolean,
): Promise<EventLine[]> {
  const stream = machine.start(['events', '--json', ...filters]);
  try {
    await waitUntil(
      'the event stream to answer',
      () => stream.output.stdout !== '' || stream.output.stderr !== '',
      3_000,
    ).catch(() => undefined);
    await act();
    await waitUntil(
      'the expected events',
      () => done(parseEventLines(stream.output.stdout)),
      20_000,
    );
    await quiet(() => stream.output.stdout.length, 750);
    return parseEventLines(stream.output.stdout);
  } finally {
    await stream.stop();
  }
}

export async function createProject(
  fixture: Pick<Fixture, 'user' | 'key'>,
  name: string,
): Promise<string> {
  return createSealedProject(fixture.user, fixture.key, name);
}

export async function findTaskByTitle(
  fixture: Pick<Fixture, 'user' | 'key'>,
  title: string,
): Promise<ListedTask | null> {
  const { tasks } = await fixture.user.ok('client.tasks.list', {});
  for (const task of tasks) {
    const opened = await fixture.key.open(bindings.title({ task: task.id }), task.title);
    if (opened === title) return task;
  }
  return null;
}
