import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Feature } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import { test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import type { RouteOutput } from '../client/contract-client.js';
import { unlockInPage } from '../fixtures/browser.js';
import { unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import { postgresAllowedIn } from '../fixtures/boards.js';
import { startServerAppLayout, type ServerAppLayout } from '../fixtures/server-app-layout.js';
import { startLoginBoard, type LoginBoard } from '../fixtures/login-board.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import type { BoardUser } from '../fixtures/users.js';
import { missingFeatures, type Board } from '../harness/board.js';
import { missingParts, type PartName } from '../harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';
import type { RunningCli } from '../harness/cli.js';
import { eventually, runIn } from './polling.js';
import { NAMES as TASK_PAGE, panelButton, questionForm, replyBox } from './task-page.js';

export const NAMES = {
  newTask: /^new task$/i,
  prompt: /prompt/i,
  title: /title/i,
  directory: /directory/i,
  createTask: /^create( task)?$/i,
  settings: /^settings$/i,
  notifications: /notifications/i,
  projectFilter: /^project( filter)?$/i,
  allProjects: /^all projects$/i,
} as const;

export const SETTINGS_PAGES = {
  machines: /^machines$/i,
  feeds: /^feeds$/i,
  notifications: /^notifications$/i,
  account: /^account$/i,
} as const;

export function escapeRegExp(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export async function choose(page: Page, control: Locator, name: RegExp): Promise<void> {
  const tag = await control.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    const label = await control.locator('option').filter({ hasText: name }).first().textContent();
    await control.selectOption({ label: label ?? '' });
    return;
  }
  await control.click();
  await page.getByRole('option', { name }).click();
}

export async function openSettings(page: Page, section: RegExp): Promise<void> {
  await page.getByRole('link', { name: NAMES.settings }).click();
  await page
    .getByRole('link', { name: section })
    .or(page.getByRole('tab', { name: section }))
    .first()
    .click();
}

export interface SettingsDocument {
  readonly [key: string]: unknown;
}

export async function readSettings(
  user: BoardUser,
  key: UnlockedKey,
): Promise<SettingsDocument | null> {
  const stored = await user.ok('client.settings.get', {});
  if (stored.document === null) return null;
  const text = await key.open(bindings.settings(stored.document.version), stored.document.document);
  return JSON.parse(text) as SettingsDocument;
}

export function settingValue(settings: SettingsDocument | null, dotted: string): unknown {
  if (settings === null) return undefined;
  if (dotted in settings) return settings[dotted];
  let current: unknown = settings;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const NOTIFICATION_SPY = `
(() => {
  const calls = [];
  window.__notifications = calls;
  const Native = window.Notification;
  if (Native) {
    window.Notification = new Proxy(Native, {
      construct(target, args) {
        calls.push({ title: String(args[0]), options: args[1] ?? null });
        return Reflect.construct(target, args);
      },
      get(target, property) {
        return Reflect.get(target, property, target);
      },
    });
  }
  if (window.ServiceWorkerRegistration) {
    const original = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      calls.push({ title: String(title), options: options ?? null });
      return original.call(this, title, options);
    };
  }
  window.__blurred = false;
  document.hasFocus = () => !window.__blurred;
  Object.defineProperty(document, 'hidden', { get: () => window.__blurred });
  Object.defineProperty(document, 'visibilityState', {
    get: () => (window.__blurred ? 'hidden' : 'visible'),
  });
})();
`;

export async function installNotificationSpy(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: NOTIFICATION_SPY });
}

export async function loseFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const flags = window as unknown as { __blurred: boolean };
    flags.__blurred = true;
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function notificationCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __notifications: unknown[] }).__notifications.length,
  );
}

export interface SignedInPage {
  readonly context: BrowserContext;
  readonly page: Page;
}

export interface SignedInOptions {
  readonly notifications?: 'granted' | 'default';
  readonly spy?: boolean;
  readonly unlock?: boolean;
}

export async function signedInPage(
  browser: Browser,
  board: Pick<Board, 'url'>,
  user: BoardUser,
  key: UnlockedKey,
  options: SignedInOptions = {},
): Promise<SignedInPage> {
  const context = await browser.newContext(
    options.notifications === 'granted' ? { permissions: ['notifications'] } : {},
  );
  if (options.spy === true) await installNotificationSpy(context);
  const cookie = user.sessionCookie();
  if (cookie !== null) await context.addCookies([cookie]);
  const page = await context.newPage();
  await page.goto(board.url);
  if (options.unlock !== false) await unlockInPage(page, key.passphrase);
  return { context, page };
}

export interface LoginBoardDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
  readonly passkeys?: boolean;
}

export interface LoginBoardHandle {
  readonly board: LoginBoard;
}

const LOGIN_START_TIMEOUT_MS = 120_000;

export function useLoginBoard(declaration: LoginBoardDeclaration): LoginBoardHandle {
  let board: LoginBoard | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(LOGIN_START_TIMEOUT_MS);
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await startLoginBoard({
      web: declaration.parts.includes('web'),
      features: declaration.features,
      passkeys: declaration.passkeys === true,
      postgresAllowed: postgresAllowedIn(testInfo.project.name),
    });
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  });

  test.afterAll(async () => {
    await board?.stop();
    board = null;
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
    get board() {
      if (board === null) throw new Error('the board is not started');
      return board;
    },
  };
}

export interface ServerAppDeclaration {
  readonly parts: readonly PartName[];
  readonly features?: readonly Feature[];
}

export interface ServerAppHandle {
  readonly layout: ServerAppLayout;
}

export function useServerAppLayout(declaration: ServerAppDeclaration): ServerAppHandle {
  let layout: ServerAppLayout | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(LOGIN_START_TIMEOUT_MS);
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    layout = await startServerAppLayout({ web: declaration.parts.includes('web') });
    const served = await fetch(`${layout.url}/api/version`).then(
      (response) => response.json() as Promise<{ features?: string[] }>,
    );
    const lacking = missingFeatures(declaration.features ?? [], served.features ?? []);
    if (lacking.length > 0) reason = featureSkipReason(lacking);
  });

  test.afterAll(async () => {
    await layout?.stop();
    layout = null;
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
    get layout() {
      if (layout === null) throw new Error('the server-app layout is not started');
      return layout;
    },
  };
}

export interface ScenarioInput {
  readonly board: Pick<Board, 'url' | 'tmp'>;
  readonly page: Page;
  readonly user: BoardUser;
}

export interface ScenarioResult {
  readonly marker: string;
  readonly key: UnlockedKey;
  readonly machine: EnrolledMachine;
  readonly directory: string;
  readonly taskId: string;
  readonly forkId: string;
  readonly plaintexts: readonly string[];
  readonly secrets: readonly string[];
  readonly listener: RunningCli;
  readonly stubLogDir: string;
  envelopes(): Promise<string[]>;
  stop(): Promise<void>;
}

type TaskListItem = RouteOutput<'client.tasks.list'>['tasks'][number];

async function findTask(
  user: BoardUser,
  key: UnlockedKey,
  title: string,
): Promise<TaskListItem | null> {
  const listed = await user.ok('client.tasks.list', {});
  for (const task of listed.tasks) {
    const opened = await key.open(bindings.title({ task: task.id }), task.title).catch(() => null);
    if (opened === title) return task;
  }
  return null;
}

async function settle(
  user: BoardUser,
  taskId: string,
  accept: (detail: RouteOutput<'client.tasks.get'>) => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  await eventually(() => user.ok('client.tasks.get', { id: taskId }), accept, {
    label,
    timeoutMs: 90_000,
  });
}

async function hasUserNote(
  key: UnlockedKey,
  taskId: string,
  detail: RouteOutput<'client.tasks.get'>,
  text: string,
): Promise<boolean> {
  const kinds = ['comment', 'answer'] as const;
  for (const entry of detail.thread) {
    if (entry.author !== 'user') continue;
    for (const kind of kinds) {
      const binding = bindings.note({ field: 'note.body', taskId, author: 'user', kind });
      if ((await key.open(binding, entry.body).catch(() => null)) === text) return true;
    }
  }
  return false;
}

export async function runScenario(input: ScenarioInput): Promise<ScenarioResult> {
  const { board, page, user } = input;
  const marker = `SEALMARK${randomBytes(6).toString('hex')}`;
  const key = await unlockedKey(board, user);
  const directory = board.tmp.path('work', `dir-${marker}`);
  mkdirSync(directory, { recursive: true });
  const stubLogDir = board.tmp.path('stub');
  mkdirSync(stubLogDir, { recursive: true });
  const machine = await enrolledMachine(board, user, {
    key,
    name: 'scenario',
    actsAsOwner: true,
    env: { STUB_CLAUDE_LOG: path.join(stubLogDir, 'claude.jsonl') },
  });
  const added = await runIn(machine, directory, ['dirs', 'add', '--no-repo']);
  if (added.code !== 0) throw new Error(`board dirs add exited ${added.code}\n${added.stderr}`);
  const listener = machine.start(['internal', 'listen']);

  const title = `${marker} title`;
  const question = `${marker} question`;
  const questions = JSON.stringify({
    questions: [
      {
        header: 'Pick',
        question,
        multiSelect: false,
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      },
    ],
  });
  const prompt = [`${marker} prompt`, `#stub: ask ${questions}`, '#stub: done'].join('\n');
  const answer = `${marker} answer`;
  const reply = `${marker} reply`;
  const note = `${marker} note`;

  await page.goto(board.url);
  await unlockInPage(page, key.passphrase);
  await page.getByRole('button', { name: NAMES.newTask }).click();
  const form = page.getByRole('dialog', { name: NAMES.newTask });
  await form.getByLabel(NAMES.prompt).fill(prompt);
  await form.getByLabel(NAMES.title).fill(title);
  await choose(page, form.getByLabel(NAMES.directory), escapeRegExp(`dir-${marker}`));
  await form.getByRole('button', { name: NAMES.createTask }).click();

  const created = await eventually(
    () => findTask(user, key, title),
    (task) => task !== null,
    {
      label: 'the new task appears',
    },
  );
  const taskId = (created as TaskListItem).id;

  await settle(user, taskId, (detail) => detail.task.openQuestion, 'the run asks its question');
  await page.getByText(title).first().click();
  const questionPanel = questionForm(page);
  await questionPanel
    .getByRole('textbox', { name: TASK_PAGE.questionOther, exact: true })
    .fill(answer);
  await questionPanel.getByRole('button', { name: TASK_PAGE.submitAnswer, exact: true }).click();
  await settle(
    user,
    taskId,
    (detail) => detail.task.status === 'needs-me' && !detail.task.openQuestion,
    'the run ends after the answer',
  );
  await replyBox(page).fill(reply);
  await panelButton(page, TASK_PAGE.sendAndContinue).click();
  await settle(
    user,
    taskId,
    async (detail) =>
      (await hasUserNote(key, taskId, detail, reply)) &&
      detail.task.status === 'needs-me' &&
      !detail.task.openQuestion,
    'the run ends after the reply',
  );
  const commented = await machine.cli(['comment', taskId, note]);
  if (commented.code !== 0) throw new Error(`board comment exited ${commented.code}`);
  await user.ok('client.tasks.done', { id: taskId });

  const forkId = `fork-${randomBytes(6).toString('hex')}`;
  const forkTitle = `${marker} fork title`;
  const forkPrompt = `${marker} fork prompt`;
  const parent = await user.ok('client.tasks.get', { id: taskId });
  await user.ok('client.tasks.fork', {
    id: forkId,
    parentId: taskId,
    title: await key.seal(bindings.title({ task: forkId }), forkTitle),
    input: await key.seal(
      bindings.input({ origin: { task: forkId }, creator: 'user', forkOf: taskId }),
      forkPrompt,
    ),
    directoryId: parent.task.directoryId,
  });

  const scheduleTitle = `${marker} schedule title`;
  const schedulePrompt = `${marker} schedule prompt`;
  const dedupeKey = `${marker}-dedupe-key`;
  const repeating = await runIn(machine, directory, [
    'schedule',
    '--every',
    '1h',
    '--title',
    scheduleTitle,
    schedulePrompt,
  ]);
  if (repeating.code !== 0)
    throw new Error(`board schedule exited ${repeating.code}\n${repeating.stderr}`);
  const keyed = await runIn(machine, directory, [
    'schedule',
    '--key',
    dedupeKey,
    '--in',
    '2h',
    `${marker} keyed prompt`,
  ]);
  if (keyed.code !== 0)
    throw new Error(`board schedule --key exited ${keyed.code}\n${keyed.stderr}`);

  await openSettings(page, SETTINGS_PAGES.notifications);
  await page.getByRole('checkbox', { name: NAMES.notifications }).check();
  await eventually(
    () => user.ok('client.settings.get', {}),
    (stored) => stored.document !== null,
    { label: 'the settings document is saved' },
  );

  const envelopes = async (): Promise<string[]> => {
    const detail = await user.ok('client.tasks.get', { id: taskId });
    const listed = await user.ok('client.tasks.list', {});
    const schedules = await user.ok('client.schedules.list', {});
    const directories = await user.ok('client.directories.list', {});
    return [
      ...detail.thread.flatMap((entry) => (entry.author === 'server' ? [] : [entry.body])),
      ...listed.tasks.flatMap((task) => [task.title, task.input]),
      ...schedules.schedules.flatMap((schedule) => [schedule.title, schedule.input]),
      ...directories.directories.map((entry) => entry.path),
    ];
  };

  return {
    marker,
    key,
    machine,
    directory,
    taskId,
    forkId,
    plaintexts: [
      marker,
      title,
      prompt,
      `${marker} prompt`,
      question,
      answer,
      reply,
      note,
      forkTitle,
      forkPrompt,
      scheduleTitle,
      schedulePrompt,
      `${marker} keyed prompt`,
      dedupeKey,
      directory,
      path.basename(directory),
    ],
    secrets: [machine.token, key.dataKey, key.dataKey.slice('abk1_'.length)],
    listener,
    stubLogDir,
    envelopes,
    stop: async () => {
      await listener.stop().catch(() => undefined);
    },
  };
}

export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['an issued token', /\bab[mcs]_[A-Za-z0-9_-]{20,}/],
  ['a data key', /\babk1_[A-Za-z0-9_-]{20,}/],
  ['a 64-hex secret', /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/],
  [
    'an authorization header value',
    /authorization["']?\s*[:=]\s*["']?\s*(?!\[?(?:redacted|\*+|-+)\]?)\S{8,}/i,
  ],
  ['a bearer credential', /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
];

export interface LogText {
  readonly source: string;
  readonly text: string;
}

export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export function logTexts(dirs: readonly string[], files: readonly string[]): LogText[] {
  const found: LogText[] = [];
  for (const file of [...files, ...dirs.flatMap(filesUnder)]) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    found.push({ source: file, text: readFileSync(file, 'utf8') });
  }
  return found;
}
