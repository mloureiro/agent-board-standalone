import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Feature, TaskStatus } from '@agent-board/contract';
import { routeByName } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';

import { UNLOCK_NAMES, unlockInPage } from '../fixtures/browser.js';
import { DEFAULT_PASSPHRASE, unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { postgresAllowedIn } from '../fixtures/boards.js';
import { startLoginBoard, type LoginBoard } from '../fixtures/login-board.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import { createTask, type TaskInput } from '../fixtures/tasks.js';
import { noLoginUser, signedInUser, type BoardUser } from '../fixtures/users.js';
import { missingParts } from '../harness/paths.js';
import type { RunningCli } from '../harness/cli.js';
import type { PartName } from '../harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';
import type { Tmp } from '../harness/tmp.js';

export const UI_TIMEOUT_MS = 15_000;
export const RUN_TIMEOUT_MS = 90_000;
export const POLL_TIMEOUT_MS = 90_000;

export const BOARD_NAMES = {
  boardLink: /^board$/i,
  settingsLink: /^settings$/i,
  newTask: /^new task$/i,
  lock: /^lock$/i,
  signOut: /^(sign|log) ?out$/i,
  send: 'Send & continue',
  create: /^(create|add)( task)?$/i,
  prompt: /^prompt$/i,
  title: /^title$/i,
  reply: 'Reply',
  other: 'Other',
  submitAnswer: 'Submit answer',
  start: /^(start|confirm|move to todo)/i,
  context: /context/i,
} as const;

export const COLUMN_NAMES: Record<TaskStatus, RegExp> = {
  backlog: /^backlog/i,
  todo: /^todo/i,
  running: /^running/i,
  waiting: /^waiting/i,
  'needs-me': /^needs me/i,
  done: /^done/i,
};

export interface Account {
  readonly user: BoardUser;
  readonly key: UnlockedKey;
  readonly url: string;
}

export function uniqueTitle(label: string): string {
  return `${label} ${randomBytes(4).toString('hex')}`;
}

export async function seedAccount(
  board: { readonly url: string },
  passphrase: string = DEFAULT_PASSPHRASE,
): Promise<Account> {
  const user = await noLoginUser({ url: board.url });
  const key = await unlockedKey({ url: board.url }, user, passphrase);
  return { user, key, url: board.url };
}

export function boardLink(page: Page): Locator {
  return page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: BOARD_NAMES.boardLink });
}

export function passphraseField(page: Page): Locator {
  return page.getByLabel(UNLOCK_NAMES.passphrase);
}

export async function unlockIfAsked(page: Page, passphrase: string): Promise<void> {
  await expect(
    passphraseField(page).or(page.getByRole('button', { name: BOARD_NAMES.lock })),
  ).toBeVisible({
    timeout: UI_TIMEOUT_MS,
  });
  if (await passphraseField(page).isVisible()) await unlockInPage(page, passphrase);
  await expect(boardLink(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(passphraseField(page)).toHaveCount(0);
}

export async function openBoard(page: Page, account: Account): Promise<void> {
  await page.goto(account.url);
  await unlockIfAsked(page, account.key.passphrase);
  await expect(column(page, 'backlog')).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

export async function reopenBoard(page: Page, account: Account): Promise<void> {
  await page.reload();
  await unlockIfAsked(page, account.key.passphrase);
  if (!(await column(page, 'backlog').isVisible())) await boardLink(page).click();
  await expect(column(page, 'backlog')).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

export function column(page: Page, status: TaskStatus): Locator {
  return page.getByRole('region', { name: COLUMN_NAMES[status] });
}

export function card(page: Page, title: string): Locator {
  return page.getByRole('article').filter({ hasText: title }).first();
}

export function cardIn(page: Page, status: TaskStatus, title: string): Locator {
  return column(page, status).getByRole('article').filter({ hasText: title }).first();
}

export async function orderIn(
  page: Page,
  status: TaskStatus,
  titles: readonly string[],
): Promise<string[]> {
  const texts = await column(page, status).getByRole('article').allTextContents();
  return titles
    .map((title) => ({ title, at: texts.findIndex((text) => text.includes(title)) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.title);
}

export async function goToTask(page: Page, title: string): Promise<void> {
  if (!(await card(page, title).isVisible())) await boardLink(page).click();
  await card(page, title).getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

export async function createTitled(
  account: Account,
  title: string,
  input: Omit<TaskInput, 'title'> = { prompt: title },
): Promise<string> {
  const created = await createTask({ url: account.url }, account.user, account.key, {
    ...input,
    title,
  });
  return created.id;
}

export async function statusOf(account: Account, id: string): Promise<TaskStatus> {
  return (await account.user.ok('client.tasks.get', { id })).task.status;
}

export async function waitForStatus(
  account: Account,
  id: string,
  status: TaskStatus,
  timeout: number = RUN_TIMEOUT_MS,
): Promise<void> {
  await expect.poll(() => statusOf(account, id), { timeout, intervals: [500, 1000] }).toBe(status);
}

export async function openText(
  account: Account,
  id: string,
  field: 'title' | 'input',
  envelope: string,
  creator: 'user' | 'agent' = 'user',
): Promise<string> {
  if (field === 'title') return account.key.open(bindings.title({ task: id }), envelope);
  const task = (await account.user.ok('client.tasks.get', { id })).task;
  const candidates = [
    bindings.input({ origin: { task: id }, creator }),
    ...(task.directoryId === null
      ? []
      : [
          bindings.input({
            origin: { task: id },
            creator,
            directoryId: task.directoryId,
          }),
        ]),
  ];
  let failure: unknown = null;
  for (const binding of candidates) {
    try {
      return await account.key.open(binding, envelope);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export interface Worker {
  readonly machine: EnrolledMachine;
  readonly directory: string;
  readonly logFile: string;
  readonly listener: RunningCli | null;
  stubLog(): Record<string, unknown>[];
  stop(): Promise<void>;
}

export interface WorkerOptions {
  readonly name?: string;
  readonly listen?: boolean;
  readonly grant?: boolean;
}

export async function startWorker(
  board: { readonly url: string; readonly tmp: Tmp },
  account: Account,
  options: WorkerOptions = {},
): Promise<Worker> {
  const name = options.name ?? `worker-${randomBytes(3).toString('hex')}`;
  const logFile = board.tmp.path('machines', name, 'stub-claude.log');
  const machine = await enrolledMachine(board, account.user, {
    key: account.key,
    name,
    actsAsOwner: options.grant !== false,
    env: { STUB_CLAUDE_LOG: logFile },
  });
  const directory = machine.tmp.path('work');
  mkdirSync(directory, { recursive: true });
  const added = await machine.cli(['dirs', 'add', directory]);
  if (added.code !== 0) {
    throw new Error(`board dirs add exited ${added.code}\n${added.stdout}${added.stderr}`);
  }
  const configured = await machine.cli(['config', 'set', 'defaultCwd', directory]);
  if (configured.code !== 0) {
    throw new Error(
      `board config set exited ${configured.code}\n${configured.stdout}${configured.stderr}`,
    );
  }
  const listener = options.listen === false ? null : machine.start(['internal', 'listen']);
  return {
    machine,
    directory,
    logFile,
    listener,
    stubLog: () => readLog(logFile),
    stop: async () => {
      await listener?.stop().catch(() => undefined);
    },
  };
}

export function readLog(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function stdinMessages(log: readonly Record<string, unknown>[]): string[] {
  return log
    .filter((entry) => entry.kind === 'stdin')
    .map((entry) => `${String(entry.text ?? '')}${String(entry.raw ?? '')}`);
}

export function valuesOf(json: unknown, key: string): unknown[] {
  if (Array.isArray(json)) return json.flatMap((item) => valuesOf(item, key));
  if (json === null || typeof json !== 'object') return [];
  return Object.entries(json).flatMap(([name, value]) =>
    name === key ? [value, ...valuesOf(value, key)] : valuesOf(value, key),
  );
}

export interface DraftEntry {
  readonly store: 'localStorage' | 'sessionStorage';
  readonly key: string;
}

export async function draftEntries(page: Page, text: string): Promise<DraftEntry[]> {
  return page.evaluate((needle) => {
    const found: { store: 'localStorage' | 'sessionStorage'; key: string }[] = [];
    for (const store of ['localStorage', 'sessionStorage'] as const) {
      const area = window[store];
      for (let index = 0; index < area.length; index += 1) {
        const key = area.key(index);
        if (key !== null && (area.getItem(key) ?? '').includes(needle)) found.push({ store, key });
      }
    }
    return found;
  }, text);
}

export async function hideAndShowTab(page: Page): Promise<void> {
  for (const hidden of [true, false]) {
    await page.evaluate((state) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (state ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  }
}

export const CLIENT_PATHS = {
  events: routeByName('client.events').path,
  list: routeByName('client.tasks.list').path,
} as const;

interface Point {
  readonly x: number;
  readonly y: number;
}

async function pointIn(target: Locator, where: 'center' | 'top' | 'bottom'): Promise<Point> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('the drop target has no box');
  const y =
    where === 'top'
      ? box.y + 4
      : where === 'bottom'
        ? box.y + box.height - 4
        : box.y + box.height / 2;
  return { x: box.x + box.width / 2, y };
}

export async function mouseDrag(
  page: Page,
  source: Locator,
  target: Locator,
  where: 'center' | 'top' | 'bottom' = 'center',
): Promise<void> {
  const from = await pointIn(source, 'center');
  const to = await pointIn(target, where);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 24 });
  await page.mouse.up();
}

const HOLD_MS = 600;
const TOUCH_STEPS = 16;

export async function touchDrag(
  page: Page,
  source: Locator,
  target: Locator,
  where: 'center' | 'top' | 'bottom' = 'center',
): Promise<void> {
  const from = await pointIn(source, 'center');
  const to = await pointIn(target, where);
  const path = Array.from({ length: TOUCH_STEPS + 1 }, (_, step) => ({
    x: from.x + ((to.x - from.x) * step) / TOUCH_STEPS,
    y: from.y + ((to.y - from.y) * step) / TOUCH_STEPS,
  }));
  if (page.context().browser()?.browserType().name() === 'chromium') {
    const session = await page.context().newCDPSession(page);
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: Point): Promise<unknown> =>
      session.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: point === undefined ? [] : [{ x: point.x, y: point.y, id: 1 }],
      });
    await send('touchStart', path[0]);
    await page.waitForTimeout(HOLD_MS);
    for (const point of path.slice(1)) {
      await send('touchMove', point);
      await page.waitForTimeout(16);
    }
    await send('touchEnd');
    await session.detach();
    return;
  }
  await page.evaluate(
    async ({ points, hold }) => {
      const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
      const pointer = (type: string, point: { x: number; y: number }): void => {
        const element = document.elementFromPoint(point.x, point.y) ?? document.body;
        element.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 41,
            pointerType: 'touch',
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: point.x,
            clientY: point.y,
            buttons: type === 'pointerup' ? 0 : 1,
          }),
        );
      };
      const first = points[0];
      const last = points[points.length - 1];
      if (first === undefined || last === undefined) return;
      pointer('pointerdown', first);
      await pause(hold);
      for (const point of points.slice(1)) {
        pointer('pointermove', point);
        await pause(16);
      }
      pointer('pointerup', last);
    },
    { points: path, hold: HOLD_MS },
  );
}

export interface StartedLoginBoard {
  readonly board: () => LoginBoard;
}

export function useLoginBoard(
  parts: readonly PartName[],
  features: readonly Feature[],
): StartedLoginBoard {
  let started: LoginBoard | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    const missing = missingParts(parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    started = await startLoginBoard({
      features,
      web: true,
      postgresAllowed: postgresAllowedIn(testInfo.project.name),
    });
    if (started.missingFeatures.length > 0) reason = featureSkipReason(started.missingFeatures);
  });

  test.afterAll(async () => {
    await started?.stop();
    started = null;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeEach(async ({}, testInfo) => {
    if (reason === null) return;
    recordSkip({
      file: testInfo.file,
      titlePath: testInfo.titlePath.slice(1),
      project: testInfo.project.name,
      reason,
    });
    test.skip(true, reason);
  });

  return {
    board: () => {
      if (started === null) throw new Error('the board is not started');
      return started;
    },
  };
}

export async function signedInAccount(board: LoginBoard): Promise<Account> {
  const user = await signedInUser(board);
  const key = await unlockedKey(board, user);
  return { user, key, url: board.url };
}
