import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

import type { Feature } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { call } from '../client/contract-client.js';
import { approveHandoff, UNLOCK_NAMES, unlockInPage } from '../fixtures/browser.js';
import { DEFAULT_PASSPHRASE, unlockedKey, type UnlockedKey } from '../fixtures/keys.js';
import {
  startLoginBoard,
  type LoginBoard,
  type LoginBoardOptions,
} from '../fixtures/login-board.js';
import { enrolledMachine, type EnrolledMachine } from '../fixtures/machines.js';
import { createTask, type CreatedTask, type TaskInput } from '../fixtures/tasks.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';
import { missingParts, partPath, type PartName } from '../harness/paths.js';
import type { PlaywrightBoardHandle } from '../harness/playwright.js';
import { runProcess, type RunResult } from '../harness/run.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';

export const NAMES = {
  board: /^board$/i,
  settings: /^settings$/i,
  schedules: /^schedules$/i,
  menu: /^(open )?(menu|navigation|sidebar|projects)$/i,
  allProjects: /^all projects$/i,
  newTask: /^new task$/i,
  prompt: /^prompt$/i,
  title: /^title$/i,
  create: /^create( task)?$/i,
  handoff: /^sign in with your browser$/i,
  machinesSection: /^machines$/i,
  pause: /^pause$/i,
  resume: /^resume$/i,
  actionPanel: 'Task actions',
  reply: 'Reply',
  send: 'Send',
  statusBadge: 'Task status',
  questionForm: 'Question',
  submitAnswer: 'Submit answer',
} as const;

export const STATUS_LABELS = {
  running: 'Running',
  needsMe: 'Needs me',
} as const;

export const NOT_ANSWERING = /not answering,? retrying/i;
export const UI_TIMEOUT_MS = 15_000;
export const RUN_TIMEOUT_MS = 60_000;
export const START_TIMEOUT_MS = 180_000;
export const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
export const KEYBOARD_HEIGHT_RATIO = 0.55;

export function uniqueMarker(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

export function escapePattern(text: string): RegExp {
  return new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

interface Started<T> {
  readonly value: T;
  readonly missing: readonly { name: string; label: string }[];
  stop(): Promise<void>;
}

export function useStarted<T>(
  parts: readonly PartName[],
  start: (projectName: string) => Promise<Started<T>>,
): { readonly value: T } {
  let started: Started<T> | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    started = await start(testInfo.project.name);
    if (started.missing.length > 0) reason = featureSkipReason(started.missing);
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
    get value() {
      if (started === null) throw new Error('the board is not started');
      return started.value;
    },
  };
}

export interface LoginBoardDeclaration {
  readonly parts: readonly PartName[];
  readonly features: readonly Feature[];
  readonly options?: LoginBoardOptions;
}

export function useLoginBoard(declaration: LoginBoardDeclaration): { readonly value: LoginBoard } {
  return useStarted(declaration.parts, async () => {
    const board = await startLoginBoard({
      ...declaration.options,
      features: declaration.features,
      web: declaration.parts.includes('web'),
    });
    return { value: board, missing: board.missingFeatures, stop: () => board.stop() };
  });
}

export interface JourneyWorld {
  readonly board: Board;
  readonly user: BoardUser;
  readonly key: UnlockedKey;
  readonly machine: EnrolledMachine;
  readonly stubLog: string;
  readonly directory: string;
  startListener(): void;
  stopListener(): Promise<void>;
}

export interface WorldOptions {
  readonly listener: boolean;
}

export async function createWorld(board: Board, options: WorldOptions): Promise<JourneyWorld> {
  const user = await noLoginUser(board);
  const key = await unlockedKey(board, user, DEFAULT_PASSPHRASE);
  const stubLog = board.tmp.path('stub-claude.jsonl');
  const machine = await enrolledMachine(board, user, {
    key,
    name: 'journeys',
    env: { STUB_CLAUDE_LOG: stubLog },
  });
  const directory = board.tmp.path('work', 'journeys');
  mkdirSync(directory, { recursive: true });
  let listener: ReturnType<EnrolledMachine['start']> | null = null;
  const world: JourneyWorld = {
    board,
    user,
    key,
    machine,
    stubLog,
    directory,
    startListener: () => {
      listener ??= machine.start(['internal', 'listen']);
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

export function useWorld(
  harness: PlaywrightBoardHandle,
  options: WorldOptions,
): { get(): Promise<JourneyWorld> } {
  let created: Promise<JourneyWorld> | null = null;
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

export function newTask(world: JourneyWorld, input: TaskInput): Promise<CreatedTask> {
  return createTask(world.board, world.user, world.key, input);
}

export async function createProject(world: JourneyWorld, name: string): Promise<string> {
  const id = randomUUID();
  await world.user.ok('client.projects.create', {
    id,
    name: await world.key.seal(bindings.projectName(id), name),
    icon: null,
  });
  return id;
}

export async function findTaskByTitle(world: JourneyWorld, title: string): Promise<string | null> {
  const { tasks } = await world.user.ok('client.tasks.list', {});
  for (const task of tasks) {
    const opened = await world.key
      .open(bindings.title({ task: task.id }), task.title)
      .catch(() => null);
    if (opened === title) return task.id;
  }
  return null;
}

export async function waitForStatus(
  world: JourneyWorld,
  id: string,
  status: 'running' | 'needs-me',
): Promise<void> {
  await expect
    .poll(async () => (await world.user.ok('client.tasks.get', { id })).task.status, {
      timeout: RUN_TIMEOUT_MS,
    })
    .toBe(status);
}

export function stubStdin(file: string): string[] {
  if (!existsSync(file)) return [];
  const entries: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const entry = JSON.parse(line) as { kind?: string; text?: unknown };
    if (entry.kind === 'stdin') entries.push(String(entry.text));
  }
  return entries;
}

export async function expectStdinContaining(world: JourneyWorld, text: string): Promise<void> {
  await expect
    .poll(() => stubStdin(world.stubLog).some((entry) => entry.includes(text)), {
      timeout: RUN_TIMEOUT_MS,
    })
    .toBe(true);
}

export async function startRunningTask(world: JourneyWorld, marker: string): Promise<CreatedTask> {
  const task = await newTask(world, { prompt: `#stub: sleep 90\n${marker}`, title: marker });
  await waitForStatus(world, task.id, 'running');
  await expectStdinContaining(world, marker);
  return task;
}

export async function releaseTask(world: JourneyWorld, id: string): Promise<void> {
  await world.user.call('client.tasks.stop', { id });
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

export async function startAskingTask(world: JourneyWorld, marker: string): Promise<CreatedTask> {
  const asked = `#stub: ask ${JSON.stringify({ questions: [COLOUR_QUESTION] })}`;
  const task = await newTask(world, { prompt: `${asked}\n${marker}`, title: marker });
  await expect
    .poll(
      async () => (await world.user.ok('client.tasks.get', { id: task.id })).task.openQuestion,
      {
        timeout: RUN_TIMEOUT_MS,
      },
    )
    .toBe(true);
  return task;
}

export async function grantOwner(world: JourneyWorld): Promise<void> {
  await world.machine.setGrant(world.user, true);
}

export async function createSchedule(
  world: JourneyWorld,
  title: string,
  prompt: string,
): Promise<RunResult> {
  const options = { env: world.machine.env, cwd: world.directory };
  const added = await runProcess(partPath('cli'), ['dirs', 'add', '--no-repo'], options);
  if (added.code !== 0) throw new Error(`board dirs add exited ${added.code}\n${added.stderr}`);
  const scheduled = await runProcess(
    partPath('cli'),
    ['schedule', '--every', '1h', '--title', title, prompt],
    options,
  );
  if (scheduled.code !== 0) {
    throw new Error(`board schedule exited ${scheduled.code}\n${scheduled.stderr}`);
  }
  return scheduled;
}

export function passphraseField(page: Page): Locator {
  return page.getByLabel(UNLOCK_NAMES.passphrase);
}

export async function waitForBoard(page: Page): Promise<void> {
  await expect(passphraseField(page)).toHaveCount(0, { timeout: UI_TIMEOUT_MS });
  await expect(page.getByRole('main')).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

export async function unlockIfAsked(page: Page, passphrase: string): Promise<void> {
  await expect(page.getByRole('main').or(passphraseField(page)).first()).toBeVisible({
    timeout: UI_TIMEOUT_MS,
  });
  if (await passphraseField(page).isVisible()) await unlockInPage(page, passphrase);
  await waitForBoard(page);
}

export async function openBoard(page: Page, world: JourneyWorld): Promise<void> {
  await page.goto(world.board.url);
  await unlockIfAsked(page, world.key.passphrase);
}

export async function navigate(page: Page, name: RegExp): Promise<void> {
  const link = page.getByRole('link', { name }).first();
  const menu = page.getByRole('button', { name: NAMES.menu }).first();
  await expect(link.or(menu).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  if (!(await link.isVisible())) await menu.click();
  await link.click();
}

export async function openTask(page: Page, world: JourneyWorld, title: string): Promise<void> {
  await openBoard(page, world);
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: UI_TIMEOUT_MS });
}

export function actionPanel(page: Page): Locator {
  return page.getByRole('region', { name: NAMES.actionPanel });
}

export function replyBox(page: Page): Locator {
  return actionPanel(page).getByRole('textbox', { name: NAMES.reply });
}

export function sendButton(page: Page): Locator {
  return actionPanel(page).getByRole('button', { name: NAMES.send, exact: true });
}

export function statusBadge(page: Page): Locator {
  return page.getByRole('status', { name: NAMES.statusBadge });
}

export function questionForm(page: Page): Locator {
  return page.getByRole('form', { name: NAMES.questionForm });
}

export async function expectFitsViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(1);
}

export async function sessionOf(page: Page): Promise<string> {
  return page
    .evaluate(async () => {
      const response = await fetch('/api/version');
      const body = (await response.json()) as { session?: string };
      return body.session ?? 'missing';
    })
    .catch(() => 'unknown');
}

export async function expectSessionValid(page: Page): Promise<void> {
  await expect.poll(() => sessionOf(page), { timeout: 30_000 }).toBe('valid');
}

export async function contextSignedInAs(
  browser: Browser,
  user: BoardUser,
): Promise<BrowserContext> {
  const cookie = user.sessionCookie();
  if (cookie === null) throw new Error('the user holds no session cookie');
  const context = await browser.newContext();
  await context.addCookies([cookie]);
  return context;
}

export async function shownHandoffCode(page: Page): Promise<string> {
  await expect(page.getByText(CODE_PATTERN).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  const match = (await page.locator('body').innerText()).match(CODE_PATTERN);
  if (match === null) throw new Error('the page shows no hand-off code');
  return match[0];
}

export async function signInByHandoff(
  page: Page,
  browser: Browser,
  board: LoginBoard,
  approver: BoardUser,
): Promise<void> {
  await page.goto(board.url);
  await page.getByRole('button', { name: NAMES.handoff }).click();
  const code = await shownHandoffCode(page);
  const context = await contextSignedInAs(browser, approver);
  try {
    await approveHandoff(context, board.url, code);
  } finally {
    await context.close();
  }
  await expectSessionValid(page);
}

export async function signInLabels(
  board: LoginBoard,
): Promise<{ oidc: string | null; saml: string | null }> {
  const answer = await call(board, 'auth.config', {});
  const config = answer.body;
  if (config === null || !config.login) return { oidc: null, saml: null };
  return { oidc: config.oidc?.label ?? null, saml: config.saml?.label ?? null };
}

export async function signInWithProvider(
  page: Page,
  board: LoginBoard,
  method: 'oidc' | 'saml',
): Promise<void> {
  const labels = await signInLabels(board);
  const label = labels[method];
  if (label === null) throw new Error(`the server offers no ${method} sign-in`);
  await page.goto(board.url);
  await page.getByRole('button', { name: escapePattern(label) }).click();
}

export async function triggerRefetch(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export async function signInJourney(
  page: Page,
  browser: Browser,
  board: LoginBoard,
  approver: BoardUser,
): Promise<void> {
  await signInByHandoff(page, browser, board, approver);
  await expect(page.getByRole('button', { name: NAMES.handoff })).toHaveCount(0);
  await expectFitsViewport(page);
}

export async function unlockJourney(page: Page, world: JourneyWorld): Promise<void> {
  await page.goto(world.board.url);
  await expect(passphraseField(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expectFitsViewport(page);
  await unlockInPage(page, world.key.passphrase);
  await waitForBoard(page);
}

export async function boardJourney(page: Page, world: JourneyWorld): Promise<void> {
  const title = uniqueMarker('board-journey');
  await newTask(world, { prompt: title, title, status: 'backlog' });
  await openBoard(page, world);
  const card = page.getByText(title).first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expectFitsViewport(page);
}

export async function projectFilterJourney(page: Page, world: JourneyWorld): Promise<void> {
  const marker = uniqueMarker('filter-journey');
  const [firstName, secondName] = [`Alpha ${marker}`, `Beta ${marker}`];
  const [first, second] = [
    await createProject(world, firstName),
    await createProject(world, secondName),
  ];
  const [firstTitle, secondTitle] = [`First ${marker}`, `Second ${marker}`];
  await newTask(world, {
    prompt: firstTitle,
    title: firstTitle,
    status: 'backlog',
    project: first,
  });
  await newTask(world, {
    prompt: secondTitle,
    title: secondTitle,
    status: 'backlog',
    project: second,
  });
  await openBoard(page, world);
  const project = (name: string): Locator =>
    page
      .getByRole('link', { name, exact: true })
      .or(page.getByRole('button', { name, exact: true }))
      .first();
  const menu = page.getByRole('button', { name: NAMES.menu }).first();
  if (!(await project(firstName).isVisible())) await menu.click();
  await project(firstName).click();
  await expect(page.getByText(firstTitle).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(page.getByText(secondTitle)).toHaveCount(0);
  await expectFitsViewport(page);
  if (!(await project(secondName).isVisible())) await menu.click();
  await project(secondName).click();
  await expect(page.getByText(secondTitle).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(page.getByText(firstTitle)).toHaveCount(0);
}

export async function taskPageJourney(page: Page, world: JourneyWorld): Promise<void> {
  const title = uniqueMarker('task-journey');
  await newTask(world, { prompt: title, title, status: 'backlog' });
  await openTask(page, world, title);
  await expect(actionPanel(page)).toBeInViewport();
  await expectFitsViewport(page);
}

export async function replyJourney(page: Page, world: JourneyWorld): Promise<void> {
  const marker = uniqueMarker('reply-journey');
  const task = await startRunningTask(world, marker);
  try {
    await openTask(page, world, marker);
    const text = `reply text ${marker}`;
    await replyBox(page).fill(text);
    await sendButton(page).click();
    await expectStdinContaining(world, text);
    await expect(replyBox(page)).toHaveValue('');
  } finally {
    await releaseTask(world, task.id);
  }
}

export async function answerJourney(page: Page, world: JourneyWorld): Promise<void> {
  const marker = uniqueMarker('answer-journey');
  const task = await startAskingTask(world, marker);
  await openTask(page, world, marker);
  const form = questionForm(page);
  await form
    .getByRole('group', { name: COLOUR_QUESTION.question })
    .getByRole('radio', { name: /Red/ })
    .check();
  await form.getByRole('button', { name: NAMES.submitAnswer }).click();
  await expect
    .poll(
      async () => (await world.user.ok('client.tasks.get', { id: task.id })).task.openQuestion,
      {
        timeout: RUN_TIMEOUT_MS,
      },
    )
    .toBe(false);
  await expectStdinContaining(world, 'Red');
}

export async function newTaskJourney(page: Page, world: JourneyWorld): Promise<void> {
  const title = uniqueMarker('new-task-journey');
  await openBoard(page, world);
  await page.getByRole('button', { name: NAMES.newTask }).click();
  await page.getByLabel(NAMES.prompt).fill(`prompt of ${title}`);
  await page.getByLabel(NAMES.title).fill(title);
  await expectFitsViewport(page);
  await page.getByRole('button', { name: NAMES.create }).click();
  await expect.poll(() => findTaskByTitle(world, title), { timeout: UI_TIMEOUT_MS }).not.toBeNull();
}

export async function schedulesJourney(page: Page, world: JourneyWorld): Promise<void> {
  const title = uniqueMarker('schedule-journey');
  await grantOwner(world);
  await createSchedule(world, title, `prompt of ${title}`);
  await openBoard(page, world);
  await navigate(page, NAMES.schedules);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expectFitsViewport(page);
  const paused = async (): Promise<boolean | null> => {
    const { schedules } = await world.user.ok('client.schedules.list', {});
    const [only] = schedules;
    return schedules.length === 1 && only !== undefined ? only.paused : null;
  };
  await page.getByRole('button', { name: NAMES.pause }).first().click();
  await expect.poll(paused, { timeout: UI_TIMEOUT_MS }).toBe(true);
  await page.getByRole('button', { name: NAMES.resume }).first().click();
  await expect.poll(paused, { timeout: UI_TIMEOUT_MS }).toBe(false);
}

export async function settingsJourney(page: Page, world: JourneyWorld): Promise<void> {
  await openBoard(page, world);
  await navigate(page, NAMES.settings);
  await page
    .getByRole('tab', { name: NAMES.machinesSection })
    .or(page.getByRole('link', { name: NAMES.machinesSection }))
    .first()
    .click();
  await expect(page.getByText(world.machine.name).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expectFitsViewport(page);
}
