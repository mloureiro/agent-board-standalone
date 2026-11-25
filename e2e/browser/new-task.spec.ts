import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { bindings } from '@agent-board/sealing';

import { useBoard } from '../src/harness/playwright.js';
import {
  BOARD_NAMES,
  RUN_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  boardLink,
  card,
  createTitled,
  draftEntries,
  goToTask,
  hideAndShowTab,
  openBoard,
  passphraseField,
  reopenBoard,
  seedAccount,
  signedInAccount,
  startWorker,
  uniqueTitle,
  useLoginBoard,
  valuesOf,
  waitForStatus,
  type Account,
  type Worker,
} from '../src/steps/board.js';
import { NAMES as TASK_PAGE, panelButton, questionForm, replyBox } from '../src/steps/task-page.js';

const FORM = {
  project: /^project$/i,
  icon: /icon/i,
  directory: /^(directory|folder)$/i,
  labels: /^labels?$/i,
  priority: /^priority$/i,
  model: /^model$/i,
  effort: /^effort$/i,
  lane: /^lane$/i,
  agent: /^agent$/i,
  autoDone: /auto-?done/i,
} as const;

async function setField(page: Page, label: RegExp, value: string): Promise<void> {
  const field = page.getByLabel(label).first();
  const role = await field.getAttribute('role');
  const tag = await field.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    await field.selectOption({ label: value });
    return;
  }
  if (role === 'combobox' || (await field.getAttribute('aria-haspopup')) !== null) {
    await field.click();
    const option = page.getByRole('option', { name: value }).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return;
    }
    await field.fill(value);
    await page.keyboard.press('Enter');
    return;
  }
  await field.fill(value);
  if (label === FORM.labels) await page.keyboard.press('Enter');
}

async function openNewTask(page: Page): Promise<Locator> {
  const prompt = page.getByLabel(BOARD_NAMES.prompt);
  if (!(await prompt.isVisible())) {
    await page.getByRole('button', { name: BOARD_NAMES.newTask }).click();
  }
  await expect(prompt).toBeVisible({ timeout: UI_TIMEOUT_MS });
  return prompt;
}

async function createProject(account: Account, name: string): Promise<string> {
  const id = randomUUID();
  await account.user.ok('client.projects.create', {
    id,
    name: await account.key.seal(bindings.projectName(id), name),
    icon: null,
  });
  return id;
}

test.describe('new task form', () => {
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['projects', 'directories'],
    auth: 'no-login',
  });

  test('[web-061] the form takes prompt, project, icon, directory, title, labels, priority, model, effort, lane, agent and auto-done', async ({
    page,
  }) => {
    const account = await seedAccount(harness.board);
    const worker = await startWorker(harness.board, account, { listen: false, grant: false });
    const projectName = uniqueTitle('project');
    const projectId = await createProject(account, projectName);
    const title = uniqueTitle('full form');
    const values = {
      prompt: `${title} prompt body`,
      label: 'e2e-label',
      lane: 'e2e-lane',
      agent: 'e2e-agent',
      icon: '🚀',
    };

    try {
      await openBoard(page, account);
      await page.getByRole('button', { name: BOARD_NAMES.newTask }).click();
      await page.getByLabel(BOARD_NAMES.prompt).fill(values.prompt);
      await page.getByLabel(BOARD_NAMES.title).fill(title);
      await setField(page, FORM.project, projectName);
      await page.getByRole('button', { name: FORM.icon }).first().click();
      await page.getByRole('button', { name: values.icon }).first().click();
      await setField(page, FORM.directory, worker.directory);
      await setField(page, FORM.labels, values.label);
      await setField(page, FORM.priority, 'High');
      await setField(page, FORM.model, 'Opus');
      await setField(page, FORM.effort, 'High');
      await setField(page, FORM.lane, values.lane);
      await setField(page, FORM.agent, values.agent);
      await page.getByRole('checkbox', { name: FORM.autoDone }).check();
      await page.getByRole('button', { name: BOARD_NAMES.create }).click();

      await expect(card(page, title)).toBeVisible({ timeout: UI_TIMEOUT_MS });
      const listed = await account.user.ok('client.tasks.list', { project: projectId });
      const created = listed.tasks[0];
      expect(created).toBeDefined();
      const task = created as (typeof listed.tasks)[number];
      expect(task).toMatchObject({
        priority: 'high',
        model: 'opus',
        effort: 'high',
        requestedLane: values.lane,
        autoDone: true,
        projectId,
      });
      expect(task.directoryId).not.toBeNull();
      expect(await account.key.open(bindings.title({ task: task.id }), task.title)).toBe(title);
      expect(
        await account.key.open(bindings.labels({ task: task.id }), task.labels as string),
      ).toContain(values.label);
      expect(await account.key.open(bindings.icon({ task: task.id }), task.icon as string)).toBe(
        values.icon,
      );
      expect(await account.key.open(bindings.agent({ task: task.id }), task.agent as string)).toBe(
        values.agent,
      );

      await card(page, title).getByRole('link', { name: title }).click();
      for (const shown of [
        title,
        projectName,
        values.prompt,
        values.label,
        values.lane,
        values.agent,
        values.icon,
      ]) {
        await expect(page.getByText(shown).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
      }

      const shown = await worker.machine.cli(['show', task.id, '--json']);
      expect(shown.code).toBe(0);
      const json: unknown = JSON.parse(shown.stdout);
      expect(valuesOf(json, 'priority')).toContain('high');
      expect(valuesOf(json, 'model')).toContain('opus');
      expect(valuesOf(json, 'effort')).toContain('high');
      expect(valuesOf(json, 'autoDone')).toContain(true);
      expect([projectId, projectName].some((project) => shown.stdout.includes(project))).toBe(true);
      expect(
        [task.directoryId as string, worker.directory].some((directory) =>
          shown.stdout.includes(directory),
        ),
      ).toBe(true);
      for (const text of [
        title,
        values.prompt,
        values.label,
        values.lane,
        values.agent,
        values.icon,
      ]) {
        expect(shown.stdout).toContain(text);
      }
    } finally {
      await worker.stop();
    }
  });
});

interface Editor {
  readonly name: string;
  open(page: Page): Promise<Locator>;
  submit(page: Page): Promise<void>;
}

const QUESTIONS = JSON.stringify({
  questions: [
    {
      header: 'Pick',
      question: 'Which one?',
      multiSelect: false,
      options: [
        { label: 'First', description: 'the first' },
        { label: 'Second', description: 'the second' },
      ],
    },
  ],
});

async function editors(account: Account): Promise<Editor[]> {
  const replyTitle = uniqueTitle('reply target');
  const askTitle = uniqueTitle('question target');
  const replyId = await createTitled(account, replyTitle, {
    prompt: `${replyTitle}\n#stub: done`,
    status: 'todo',
  });
  const askId = await createTitled(account, askTitle, {
    prompt: `${askTitle}\n#stub: ask ${QUESTIONS}`,
    status: 'todo',
  });
  await waitForStatus(account, replyId, 'needs-me');
  await waitForStatus(account, askId, 'needs-me');
  return [
    {
      name: 'new-task prompt',
      open: openNewTask,
      submit: async (page) => {
        const title = page.getByLabel(BOARD_NAMES.title);
        if ((await title.inputValue()) === '') await title.fill(uniqueTitle('drafted'));
        await page.getByRole('button', { name: BOARD_NAMES.create }).click();
      },
    },
    {
      name: 'reply box',
      open: async (page) => {
        await goToTask(page, replyTitle);
        return replyBox(page);
      },
      submit: async (page) => {
        await panelButton(page, TASK_PAGE.sendAndContinue).click();
      },
    },
    {
      name: 'question other field',
      open: async (page) => {
        await goToTask(page, askTitle);
        const other = questionForm(page).getByRole('textbox', {
          name: TASK_PAGE.questionOther,
          exact: true,
        });
        if (!(await other.isVisible())) {
          await questionForm(page)
            .getByRole('radio', { name: TASK_PAGE.questionOther, exact: true })
            .check();
        }
        return other;
      },
      submit: async (page) => {
        await questionForm(page)
          .getByRole('button', { name: TASK_PAGE.submitAnswer, exact: true })
          .click();
      },
    },
  ];
}

async function leaveAndReturn(page: Page): Promise<void> {
  await page.getByRole('link', { name: BOARD_NAMES.settingsLink }).click();
  await boardLink(page).click();
}

async function assertEmptyEverywhere(page: Page, text: string): Promise<void> {
  expect(await draftEntries(page, text)).toEqual([]);
}

test.describe('drafts', () => {
  const harness = useBoard({
    parts: ['api', 'web', 'cli'],
    features: ['machine-grant'],
    auth: 'no-login',
  });
  let worker: Worker | null = null;

  test.beforeEach(async () => {
    const account = await seedAccount(harness.board);
    worker = await startWorker(harness.board, account);
  });

  test.afterEach(async () => {
    await worker?.stop();
    worker = null;
  });

  test('[web-064] unsent text in the new-task prompt, the reply box and a question Other field survives navigation, a reload and a tab switch', async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);
    const account = await seedAccount(harness.board);
    const all = await editors(account);
    await openBoard(page, account);

    for (const editor of all) {
      const text = `unsent ${editor.name} ${uniqueTitle('text')}`;
      const field = await editor.open(page);
      await field.fill(text);

      await leaveAndReturn(page);
      await expect(await editor.open(page)).toHaveValue(text, { timeout: UI_TIMEOUT_MS });

      await reopenBoard(page, account);
      await expect(await editor.open(page)).toHaveValue(text, { timeout: UI_TIMEOUT_MS });

      await hideAndShowTab(page);
      await expect(await editor.open(page)).toHaveValue(text);
    }
  });

  test('[web-064] a draft is keyed by user and key id and a second server editor is empty', async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);
    const account = await seedAccount(harness.board);
    const text = `keyed draft ${uniqueTitle('text')}`;
    await openBoard(page, account);
    await (await openNewTask(page)).fill(text);

    const entries = await draftEntries(page, text);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.key).toMatch(/^ab:[^:]+:/);
      expect(entry.key).toContain(account.key.keyId);
      expect(
        [account.user.username, encodeURIComponent(account.user.username), account.user.owner].some(
          (user) => entry.key.includes(user),
        ),
      ).toBe(true);
    }

    const otherText = `other server draft ${uniqueTitle('text')}`;
    const foreignKey = `ab:e2e-server-b:draft:new:${account.key.keyId}`;
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [foreignKey, otherText],
    );
    await reopenBoard(page, account);
    await expect(await openNewTask(page)).toHaveValue('');
  });

  test('[web-064] drafts clear on send', async ({ page }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 180_000);
    const account = await seedAccount(harness.board);
    const all = await editors(account);
    await openBoard(page, account);

    for (const editor of all) {
      const text = `sent ${editor.name} ${uniqueTitle('text')}`;
      const field = await editor.open(page);
      await field.fill(text);
      expect((await draftEntries(page, text)).length).toBeGreaterThan(0);

      await editor.submit(page);

      await expect.poll(() => draftEntries(page, text), { timeout: UI_TIMEOUT_MS }).toEqual([]);
      await boardLink(page).click();
      await expect(await editor.open(page)).toHaveValue('', { timeout: UI_TIMEOUT_MS });
    }
  });

  test('[web-064] drafts clear on lock', async ({ page }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);
    const account = await seedAccount(harness.board);
    const all = await editors(account);
    await openBoard(page, account);

    for (const editor of all) {
      const text = `locked ${editor.name} ${uniqueTitle('text')}`;
      await (await editor.open(page)).fill(text);
      expect((await draftEntries(page, text)).length).toBeGreaterThan(0);

      await page.getByRole('button', { name: BOARD_NAMES.lock }).click();
      await expect(passphraseField(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
      await assertEmptyEverywhere(page, text);

      await page.getByLabel(/passphrase/i).fill(account.key.passphrase);
      await page.getByRole('button', { name: /^unlock$/i }).click();
      await expect(boardLink(page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
      await expect(await editor.open(page)).toHaveValue('', { timeout: UI_TIMEOUT_MS });
    }
  });
});

test.describe('drafts after sign-out', () => {
  const login = useLoginBoard(['api', 'web'], []);

  test('[web-064] drafts clear on sign-out', async ({ page, context }) => {
    const board = login.board();
    const account = await signedInAccount(board);
    const cookie = account.user.sessionCookie();
    expect(cookie).not.toBeNull();
    await context.addCookies([cookie as NonNullable<typeof cookie>]);
    const text = `signed out ${uniqueTitle('text')}`;
    await openBoard(page, account);
    await (await openNewTask(page)).fill(text);
    expect((await draftEntries(page, text)).length).toBeGreaterThan(0);

    await page.getByRole('button', { name: BOARD_NAMES.signOut }).click();

    await expect(boardLink(page)).toHaveCount(0, { timeout: UI_TIMEOUT_MS });
    await assertEmptyEverywhere(page, text);
  });
});
