import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';

import { bindings } from '@agent-board/sealing';
import type { TaskStatus } from '@agent-board/contract';

import type { RouteOutput } from '../client/contract-client.js';
import type { Board } from '../harness/board.js';
import { noLoginUser } from '../fixtures/users.js';
import { unlockedKey } from '../fixtures/keys.js';
import type { RunningCli } from '../harness/cli.js';
import type { RunResult } from '../harness/run.js';
import type { Tmp } from '../harness/tmp.js';
import { newTaskId } from '../fixtures/tasks.js';
import type { UnlockedKey } from '../fixtures/keys.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import type { BoardUser } from '../fixtures/users.js';
import type { VersionProxy } from '../fixtures/version-proxy.js';

export const TICK_PATH = '/api/machine/version';
export const EVENTS_PATH = '/api/machine/events';
export const STOP_KILL_DELAY_MS = 30_000;
export const TRANSCRIPT_EVENT_LIMIT = 20_000;

export interface StubEntry {
  readonly kind: string;
  readonly at: number;
  readonly [key: string]: unknown;
}

export function readStubLog(file: string): StubEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StubEntry);
}

export function stdinTexts(entries: readonly StubEntry[]): string[] {
  return entries.filter((entry) => entry.kind === 'stdin').map((entry) => String(entry.text));
}

export function startEntries(entries: readonly StubEntry[]): StubEntry[] {
  return entries.filter((entry) => entry.kind === 'start');
}

export function argvOf(entry: StubEntry): string[] {
  return Array.isArray(entry.argv) ? entry.argv.map(String) : [];
}

export function pidOf(entry: StubEntry): number {
  return Number(entry.pid);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killStubs(entries: readonly StubEntry[]): void {
  for (const entry of startEntries(entries)) {
    try {
      process.kill(pidOf(entry), 'SIGKILL');
    } catch {
      continue;
    }
  }
}

export async function ownerOf(board: Board): Promise<{ user: BoardUser; key: UnlockedKey }> {
  const user = await noLoginUser(board);
  return { user, key: await unlockedKey(board, user) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly what: string;
}

export async function pollUntil<T>(
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: PollOptions,
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const interval = options.intervalMs ?? 250;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${options.what}`);
    await sleep(interval);
  }
}

export async function settle(
  read: () => number,
  quietMs: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() >= deadline) throw new Error('the count never settled');
    await sleep(100);
    const current = read();
    if (current !== last) {
      last = current;
      since = Date.now();
    }
  }
  return last;
}

export function requireOk(result: RunResult, label: string): RunResult {
  if (result.code !== 0) {
    throw new Error(`${label} exited ${result.code}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

export function requestsTo(proxy: Pick<VersionProxy, 'seen'>, path: string): number {
  return proxy.seen.filter((request) => request.path === path).length;
}

export async function directoryIdOf(
  user: BoardUser,
  key: UnlockedKey,
  machine: string,
  directory: string,
): Promise<string> {
  const wanted = new Set([directory, realpathSync(directory)]);
  return pollUntil(
    async () => {
      const { directories } = await user.ok('client.directories.list', { machine });
      for (const entry of directories) {
        const opened = await key.open(bindings.directoryPath(entry.id), entry.path);
        if (wanted.has(opened)) return entry.id;
      }
      return null;
    },
    { timeoutMs: 10_000, what: `the directory ${directory} on the board` },
  );
}

export interface Worker {
  readonly name: string;
  readonly machine: EnrolledMachine;
  readonly directory: string;
  readonly directoryId: string;
  readonly stubLog: string;
  entries(): StubEntry[];
  listen(): RunningCli;
  track(cli: RunningCli): RunningCli;
  addDirectory(label: string): Promise<{ path: string; id: string }>;
  dispose(): Promise<void>;
}

export interface WorkerBoard {
  readonly url: string;
  readonly tmp: Tmp;
}

export interface WorkerOptions {
  readonly name?: string;
  readonly url?: string;
  readonly actsAsOwner?: boolean;
  readonly defaultDirectory?: boolean;
}

let workerCounter = 0;

export async function enrolWorker(
  board: WorkerBoard,
  user: BoardUser,
  key: UnlockedKey,
  options: WorkerOptions = {},
): Promise<Worker> {
  workerCounter += 1;
  const name = options.name ?? `worker-${workerCounter}`;
  const stubLog = board.tmp.path('machines', name, 'stub.log');
  const machine = await enrolledMachine({ url: options.url ?? board.url, tmp: board.tmp }, user, {
    key,
    name,
    ...(options.actsAsOwner === undefined ? {} : { actsAsOwner: options.actsAsOwner }),
    env: { STUB_CLAUDE_LOG: stubLog },
  });
  const tracked: RunningCli[] = [];

  const makeDirectory = async (label: string, asDefault: boolean) => {
    const path = machine.tmp.path('work', label);
    mkdirSync(path, { recursive: true });
    requireOk(await machine.cli(['dirs', 'add', path]), `board dirs add ${label}`);
    if (asDefault) {
      requireOk(await machine.cli(['dirs', 'set', 'default', 'true', path]), 'board dirs set');
    }
    return { path, id: await directoryIdOf(user, key, name, path) };
  };

  const first = await makeDirectory('main', options.defaultDirectory !== false);
  const entries = (): StubEntry[] => readStubLog(stubLog);

  return {
    name,
    machine,
    directory: first.path,
    directoryId: first.id,
    stubLog,
    entries,
    track: (cli) => {
      tracked.push(cli);
      return cli;
    },
    listen: () => {
      const cli = machine.start(['internal', 'listen']);
      tracked.push(cli);
      return cli;
    },
    addDirectory: (label) => makeDirectory(label, false),
    dispose: async () => {
      killStubs(entries());
      await Promise.all(tracked.splice(0).map((cli) => cli.stop().catch(() => undefined)));
      killStubs(entries());
    },
  };
}

export interface WorkerTaskInput {
  readonly prompt: string;
  readonly id?: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly place?: { readonly machine: string; readonly directoryId: string };
  readonly autoDone?: boolean;
  readonly when?: 'now' | 'backlog' | 'hold' | { readonly at: string };
}

export interface WorkerTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
}

export async function createWorkerTask(
  user: BoardUser,
  key: UnlockedKey,
  input: WorkerTaskInput,
): Promise<WorkerTask> {
  const id = input.id ?? newTaskId();
  const title = input.title ?? id;
  await user.ok('client.tasks.create', {
    id,
    title: await key.seal(bindings.title({ task: id }), title),
    input: await key.seal(
      bindings.input({
        origin: { task: id },
        creator: 'user',
        ...(input.place === undefined ? {} : { directoryId: input.place.directoryId }),
      }),
      input.prompt,
    ),
    when: input.when ?? 'now',
    autoDone: input.autoDone ?? true,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.place === undefined ? {} : { place: input.place }),
  });
  return { id, title, prompt: input.prompt };
}

export async function getTask(
  user: BoardUser,
  id: string,
): Promise<RouteOutput<'client.tasks.get'>> {
  return user.ok('client.tasks.get', { id });
}

export async function waitForStatus(
  user: BoardUser,
  id: string,
  wanted: TaskStatus | readonly TaskStatus[],
  timeoutMs = 45_000,
): Promise<TaskStatus> {
  const accepted = Array.isArray(wanted)
    ? (wanted as readonly TaskStatus[])
    : [wanted as TaskStatus];
  let last = 'unknown';
  try {
    return await pollUntil(
      async () => {
        last = (await getTask(user, id)).task.status;
        return accepted.includes(last as TaskStatus) ? (last as TaskStatus) : null;
      },
      { timeoutMs, what: `task ${id} to reach ${accepted.join(' or ')}` },
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}; last status ${last}`, { cause: error });
  }
}

export interface OpenNote {
  readonly id: string;
  readonly author: string;
  readonly kind: string;
  readonly body: string;
  readonly questions: string | null;
}

export async function openThread(
  user: BoardUser,
  key: UnlockedKey,
  taskId: string,
): Promise<OpenNote[]> {
  const { thread } = await getTask(user, taskId);
  const notes: OpenNote[] = [];
  for (const note of thread) {
    if (note.author === 'server') {
      notes.push({
        id: note.id,
        author: note.author,
        kind: note.kind,
        body: note.body,
        questions: null,
      });
      continue;
    }
    const body = await key.open(
      bindings.note({ field: 'note.body', taskId, author: note.author, kind: note.kind }),
      note.body,
    );
    const questions =
      note.questions === undefined
        ? null
        : await key.open(
            bindings.note({
              field: 'note.questions',
              taskId,
              author: note.author,
              kind: note.kind,
            }),
            note.questions,
          );
    notes.push({ id: note.id, author: note.author, kind: note.kind, body, questions });
  }
  return notes;
}

export function questionNotes(notes: readonly OpenNote[]): OpenNote[] {
  return notes.filter((note) => note.kind === 'question');
}

export function questionCount(questions: string): number {
  const parsed = JSON.parse(questions) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  const inner = (parsed as { questions?: unknown }).questions;
  return Array.isArray(inner) ? inner.length : -1;
}

export async function sealedUserNote(
  key: UnlockedKey,
  taskId: string,
  text: string,
): Promise<{ body: string }> {
  return {
    body: await key.seal(
      bindings.note({ field: 'note.body', taskId, author: 'user', kind: 'comment' }),
      text,
    ),
  };
}

export async function addAgentNote(
  machine: EnrolledMachine,
  key: UnlockedKey,
  taskId: string,
  text: string,
  author: 'agent' | 'system' = 'agent',
): Promise<void> {
  await machine.ok('machine.add-note', {
    id: taskId,
    author,
    kind: 'comment',
    body: await key.seal(
      bindings.note({ field: 'note.body', taskId, author, kind: 'comment' }),
      text,
    ),
  });
}

export interface OpenRunEvent {
  readonly seq: number;
  readonly kind: string;
  readonly data: string;
  readonly sealed: string;
  readonly outputSize: number | null;
}

export async function transcriptRuns(
  user: BoardUser,
  taskId: string,
): Promise<RouteOutput<'client.transcript.runs'>['runs']> {
  return (await user.ok('client.transcript.runs', { id: taskId })).runs;
}

export async function openRunEvents(
  user: BoardUser,
  key: UnlockedKey,
  taskId: string,
  runId: string,
): Promise<OpenRunEvent[]> {
  const { events } = await user.ok('client.transcript.events', { runId });
  const opened: OpenRunEvent[] = [];
  for (const event of events) {
    const data = await key.open(
      bindings.transcript({ field: 'tr.data', taskId, runId, seq: event.seq }),
      event.data,
    );
    opened.push({
      seq: event.seq,
      kind: event.kind,
      data,
      sealed: event.data,
      outputSize: event.outputSize,
    });
  }
  return opened;
}

export async function openToolOutputs(
  user: BoardUser,
  key: UnlockedKey,
  taskId: string,
): Promise<string[]> {
  const outputs: string[] = [];
  for (const run of await transcriptRuns(user, taskId)) {
    const { events } = await user.ok('client.transcript.events', { runId: run.id });
    for (const event of events.filter((entry) => entry.kind === 'tool_result')) {
      const { output } = await user.ok('client.transcript.output', {
        runId: run.id,
        seq: String(event.seq),
      });
      if (output === null) continue;
      outputs.push(
        await key.open(
          bindings.transcript({ field: 'tr.output', taskId, runId: run.id, seq: event.seq }),
          output,
        ),
      );
    }
  }
  return outputs;
}

export async function openContext(
  user: BoardUser,
  key: UnlockedKey,
  taskId: string,
): Promise<string | null> {
  const { context } = await user.ok('client.transcript.context', { id: taskId });
  if (context === null) return null;
  return key.open(
    bindings.transcript({
      field: 'tr.data',
      taskId,
      runId: context.runId,
      seq: context.seq,
    }),
    context.data,
  );
}

export function idsOf(output: string): string[] {
  const parsed = JSON.parse(output) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { tasks?: unknown }).tasks as unknown[] | undefined);
  if (!Array.isArray(list)) throw new Error(`no task list in: ${output}`);
  return list.map((entry) => String((entry as { id: unknown }).id));
}

export function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((entry) => valuesOf(entry, key));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, entry]) =>
    name === key ? [entry, ...valuesOf(entry, key)] : valuesOf(entry, key),
  );
}

export async function startProxyOn(
  start: (port: number) => Promise<VersionProxy>,
  port: number,
): Promise<VersionProxy> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await start(port);
    } catch (error) {
      last = error;
      await sleep(100);
    }
  }
  throw last;
}

export async function createProject(
  user: BoardUser,
  key: UnlockedKey,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await user.ok('client.projects.create', {
    id,
    name: await key.seal(bindings.projectName(id), name),
    icon: null,
  });
  return id;
}

export async function moveDirectory(
  user: BoardUser,
  directoryId: string,
  projectId: string,
): Promise<void> {
  await user.ok('client.directories.move', { id: directoryId, projectId });
}
