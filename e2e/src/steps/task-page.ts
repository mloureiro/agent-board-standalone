import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { TaskStatus } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { UNLOCK_NAMES } from '../fixtures/browser.js';
import { DEFAULT_PASSPHRASE, unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import { createTask, type CreatedTask, type TaskInput } from '../fixtures/tasks.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';
import type { RunningCli } from '../harness/cli.js';
import type { PlaywrightBoardHandle } from '../harness/playwright.js';

export const NAMES = {
  actionPanel: 'Task actions',
  reply: 'Reply',
  thread: 'Thread',
  statusBadge: 'Task status',
  send: 'Send',
  stopAndSend: 'Stop & send',
  stop: 'Stop',
  comment: 'Comment',
  takeBack: 'Take back',
  sendAndContinue: 'Send & continue',
  markDone: 'Mark done',
  rerunFresh: 'Re-run fresh',
  moveToBacklog: 'Move to Backlog',
  close: 'Close',
  fork: 'Fork',
  forkDialog: 'Fork',
  forkInstructions: 'Instructions',
  forkTitle: 'Title',
  skillList: 'Skills',
  questionForm: 'Question',
  questionNote: 'Note',
  questionOther: 'Other',
  submitAnswer: 'Submit answer',
  dismissQuestion: 'Dismiss',
  transcript: 'Transcript',
  transcriptDrawer: 'Transcript',
  transcriptRuns: 'Runs',
  contextBar: 'Context',
  autoCompact: 'Auto-compact',
  board: 'Board',
} as const;

export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  running: 'Running',
  waiting: 'Waiting',
  'needs-me': 'Needs me',
  done: 'Done',
};

export const LISTENER_ARGS = ['internal', 'listen'] as const;

const UNLOCK_WAIT_MS = 3_000;
const STATUS_TIMEOUT_MS = 60_000;
const LOG_TIMEOUT_MS = 30_000;

export interface TaskWorld {
  readonly board: Board;
  readonly user: BoardUser;
  readonly key: UnlockedKey;
  readonly machine: EnrolledMachine;
  readonly stubLog: string;
  startListener(): void;
  stopListener(): Promise<void>;
}

export interface WorldOptions {
  readonly listener: boolean;
  readonly skills?: readonly string[];
}

function writeSkills(home: string, skills: readonly string[]): void {
  for (const name of skills) {
    const dir = path.join(home, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name} for the task page tests\n---\n\nUse ${name}.\n`,
    );
  }
}

export async function createWorld(board: Board, options: WorldOptions): Promise<TaskWorld> {
  const user = await noLoginUser(board);
  const key = await unlockedKey(board, user, DEFAULT_PASSPHRASE);
  const stubLog = board.tmp.path('stub-claude.jsonl');
  const machine = await enrolledMachine(board, user, {
    key,
    name: 'task-page',
    env: { STUB_CLAUDE_LOG: stubLog },
  });
  writeSkills(machine.tmp.home, options.skills ?? []);
  let listener: RunningCli | null = null;
  const world: TaskWorld = {
    board,
    user,
    key,
    machine,
    stubLog,
    startListener: () => {
      listener ??= machine.start(LISTENER_ARGS);
    },
    stopListener: async () => {
      const running = listener;
      listener = null;
      await running?.stop();
    },
  };
  if (options.listener) world.startListener();
  return world;
}

export interface WorldHolder {
  get(): Promise<TaskWorld>;
}

export function useWorld(harness: PlaywrightBoardHandle, options: WorldOptions): WorldHolder {
  let created: Promise<TaskWorld> | null = null;
  test.afterAll(async () => {
    const pending = created;
    created = null;
    await (await pending)?.stopListener();
  });
  return {
    get: () => {
      created ??= createWorld(harness.board, options);
      return created;
    },
  };
}

export async function newTask(world: TaskWorld, input: TaskInput): Promise<CreatedTask> {
  return createTask(world.board, world.user, world.key, input);
}

export async function waitForStatus(
  world: TaskWorld,
  id: string,
  status: TaskStatus,
  timeout = STATUS_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(async () => (await world.user.ok('client.tasks.get', { id })).task.status, { timeout })
    .toBe(status);
}

export async function taskOf(world: TaskWorld, id: string) {
  return (await world.user.ok('client.tasks.get', { id })).task;
}

export interface StubLogEntry {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export function readStubLog(file: string): StubLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StubLogEntry);
}

export function stubStdin(file: string): string[] {
  return readStubLog(file)
    .filter((entry) => entry.kind === 'stdin')
    .map((entry) => String(entry.text));
}

export function stubInterrupts(file: string): number {
  return readStubLog(file).filter(
    (entry) => entry.kind === 'signal' || entry.kind === 'stdin-closed',
  ).length;
}

export function stubResumedSessions(file: string): string[] {
  const sessions: string[] = [];
  for (const entry of readStubLog(file)) {
    if (entry.kind !== 'start' || !Array.isArray(entry.argv)) continue;
    const argv = entry.argv as string[];
    const at = argv.indexOf('--resume');
    const session = at === -1 ? undefined : argv[at + 1];
    if (session !== undefined) sessions.push(session);
  }
  return sessions;
}

export async function expectStdinContaining(
  world: TaskWorld,
  text: string,
  since = 0,
): Promise<void> {
  await expect
    .poll(
      () =>
        stubStdin(world.stubLog)
          .slice(since)
          .some((entry) => entry.includes(text)),
      {
        timeout: LOG_TIMEOUT_MS,
      },
    )
    .toBe(true);
}

export async function waitForRunStart(world: TaskWorld, marker: string): Promise<void> {
  await expect
    .poll(() => stubStdin(world.stubLog).some((entry) => entry.includes(marker)), {
      timeout: STATUS_TIMEOUT_MS,
    })
    .toBe(true);
}

export async function unlockIfAsked(page: Page, passphrase: string): Promise<void> {
  const field = page.getByLabel(UNLOCK_NAMES.passphrase);
  const asked = await field.waitFor({ state: 'visible', timeout: UNLOCK_WAIT_MS }).then(
    () => true,
    () => false,
  );
  if (!asked) return;
  await field.fill(passphrase);
  await page.getByRole('button', { name: UNLOCK_NAMES.unlock }).click();
}

export async function openBoard(page: Page, world: TaskWorld): Promise<void> {
  await page.goto(world.board.url);
  await unlockIfAsked(page, world.key.passphrase);
}

export interface OpenTaskOptions {
  readonly clock?: boolean;
}

export async function openTask(
  page: Page,
  world: TaskWorld,
  task: Pick<CreatedTask, 'title'>,
  options: OpenTaskOptions = {},
): Promise<void> {
  if (options.clock === true) await page.clock.install();
  await openBoard(page, world);
  await page.getByRole('link', { name: task.title }).first().click();
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
}

export function actionPanel(page: Page): Locator {
  return page.getByRole('region', { name: NAMES.actionPanel });
}

export function replyBox(page: Page): Locator {
  return actionPanel(page).getByRole('textbox', { name: NAMES.reply });
}

export function panelButton(page: Page, name: string): Locator {
  return actionPanel(page).getByRole('button', { name, exact: true });
}

export function thread(page: Page): Locator {
  return page.getByRole('region', { name: NAMES.thread });
}

export function statusBadge(page: Page): Locator {
  return page.getByRole('status', { name: NAMES.statusBadge });
}

export async function expectBadge(page: Page, status: TaskStatus): Promise<void> {
  await expect(statusBadge(page)).toHaveText(STATUS_LABELS[status], {
    timeout: STATUS_TIMEOUT_MS,
  });
}

export function questionForm(page: Page): Locator {
  return page.getByRole('form', { name: NAMES.questionForm });
}

export function transcriptDrawer(page: Page): Locator {
  return page.getByRole('dialog', { name: NAMES.transcriptDrawer });
}

export async function caretOffset(field: Locator): Promise<number | null> {
  return field.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.selectionStart;
    }
    return window.getSelection()?.anchorOffset ?? null;
  });
}

export async function typeInto(field: Locator, text: string): Promise<void> {
  await field.click();
  await field.pressSequentially(text);
}

export async function addAgentNotes(
  world: TaskWorld,
  task: Pick<CreatedTask, 'id'>,
  count: number,
): Promise<void> {
  const binding = bindings.note({
    field: 'note.body',
    taskId: task.id,
    author: 'agent',
    kind: 'comment',
  });
  for (let index = 0; index < count; index += 1) {
    await world.machine.ok('machine.add-note', {
      id: task.id,
      author: 'agent',
      kind: 'comment',
      body: await world.key.seal(binding, `Thread note ${index} with enough text to take a line`),
    });
  }
}

export interface SeededEvent {
  readonly kind: 'text' | 'thinking' | 'tool_use' | 'result' | 'note' | 'context';
  readonly data: Readonly<Record<string, unknown>>;
}

export async function seedTranscriptRun(
  world: TaskWorld,
  task: Pick<CreatedTask, 'id'>,
  runId: string,
  events: readonly SeededEvent[],
): Promise<void> {
  const startedAt = new Date().toISOString();
  const batch = await Promise.all(
    events.map(async (event, seq) => ({
      seq,
      at: startedAt,
      parent: null,
      kind: event.kind,
      data: await world.key.seal(
        bindings.transcript({ field: 'tr.data', taskId: task.id, runId, seq }),
        JSON.stringify(event.data),
      ),
    })),
  );
  await world.machine.ok('machine.transcript', {
    id: task.id,
    runId,
    startedAt,
    sessionId: null,
    resumed: false,
    events: batch,
  });
}

export function askPrompt(questions: readonly unknown[]): string {
  return `#stub: ask ${JSON.stringify({ questions })}`;
}

export const COLOUR_QUESTION = {
  header: 'Colour',
  question: 'Which colour should the badge use?',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'A warm colour' },
    { label: 'Blue', description: 'A cool colour', recommended: true },
    { label: 'Green', description: 'A natural colour' },
  ],
} as const;

export const SCOPE_QUESTION = {
  header: 'Scope',
  question: 'How far should the change reach?',
  multiSelect: false,
  options: [
    { label: 'Narrow', description: 'Only the badge' },
    { label: 'Wide', description: 'Every badge' },
  ],
} as const;

export async function findFork(world: TaskWorld, parentId: string): Promise<string> {
  let found: string | null = null;
  await expect
    .poll(
      async () => {
        const { tasks } = await world.user.ok('client.tasks.list', {});
        found = tasks.find((task) => task.forkOf === parentId)?.id ?? null;
        return found !== null;
      },
      { timeout: STATUS_TIMEOUT_MS },
    )
    .toBe(true);
  return found as unknown as string;
}

export async function releaseTask(world: TaskWorld, id: string): Promise<void> {
  await world.user.call('client.tasks.stop', { id });
}

export async function fieldText(field: Locator): Promise<string> {
  return field.evaluate((element) =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : (element.textContent ?? ''),
  );
}

export async function isTopmost(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && element.contains(hit);
  });
}
