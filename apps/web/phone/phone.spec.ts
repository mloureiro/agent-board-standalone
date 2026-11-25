import { expect, test, type Locator, type Page } from '@playwright/test';

import { PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_HOME_ID } from '../test/projects-world.js';
import { PhoneWorld, serve, unlock } from './world.js';

const COLOUR = {
  header: 'Colour',
  question: 'Which colour should the badge use?',
  options: [{ label: 'Red' }, { label: 'Blue' }],
};

async function fitsViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function start(page: Page, world: PhoneWorld, path = '/'): Promise<void> {
  await serve(page.context(), world);
  await page.goto(path);
  await expect(page.getByLabel(/passphrase/i)).toBeVisible();
  await unlock(page);
  await expect(page.getByRole('main')).toBeVisible();
}

async function seededWorld(): Promise<PhoneWorld> {
  const world = new PhoneWorld();
  await world.seedProjects([
    { id: PROJECT_HOME_ID, name: null, icon: null, isDefault: true },
    { id: PROJECT_ALPHA, name: 'Alpha', icon: null, isDefault: false },
    { id: PROJECT_BRAVO, name: 'Bravo', icon: null, isDefault: false },
  ]);
  world.machines = [{ name: 'laptop', clientStatus: 'current' }];
  await world.seed({ id: 'task-home', title: 'Home chore', status: 'backlog' });
  await world.seed({
    id: 'task-alpha',
    title: 'Alpha chore',
    status: 'backlog',
    overrides: { projectId: PROJECT_ALPHA },
  });
  await world.seed({
    id: 'task-bravo',
    title: 'Bravo chore',
    status: 'backlog',
    overrides: { projectId: PROJECT_BRAVO },
  });
  await world.seed({ id: 'task-talk', title: 'Talk to me', status: 'needs-me' });
  await world.seed({
    id: 'task-ask',
    title: 'Ask me',
    status: 'needs-me',
    overrides: { openQuestion: true },
  });
  await world.seedNotes('task-talk', [{ id: 'n1', author: 'agent', body: 'Ready for you' }]);
  const asked = {
    id: 'q1',
    author: 'agent' as const,
    kind: 'question' as const,
    body: 'One question',
    questions: [
      {
        header: COLOUR.header,
        question: COLOUR.question,
        options: COLOUR.options.map((option) => ({ label: option.label })),
      },
    ],
  };
  await world.seedNotes('task-ask', [asked]);
  return world;
}

const menuButton = (page: Page): Locator => page.getByRole('button', { name: 'Menu' });

async function openMenu(page: Page): Promise<void> {
  await menuButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
}

async function openTask(page: Page, title: string): Promise<void> {
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test.describe('phone journeys', () => {
  test('[web-098] the sign in journey completes at the phone viewport', async ({ page }) => {
    const world = new PhoneWorld('none');
    await serve(page.context(), world);
    await page.goto('/');
    const handoff = page.getByRole('button', { name: /^sign in with your browser$/i });
    await expect(handoff).toBeVisible();
    await fitsViewport(page);
    await handoff.click();
    await expect(page.getByRole('status', { name: /waiting for approval/i })).toBeVisible();
    await expect(page.getByText(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/).first()).toBeVisible();
    await fitsViewport(page);
    world.approve();
    await expect(page.getByLabel(/passphrase/i)).toBeVisible({ timeout: 20_000 });
  });

  test('[web-098] the unlock journey completes at the phone viewport', async ({ page }) => {
    const world = await seededWorld();
    await serve(page.context(), world);
    await page.goto('/');
    await expect(page.getByLabel(/passphrase/i)).toBeVisible();
    await fitsViewport(page);
    await unlock(page);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText('Home chore').first()).toBeVisible();
  });

  test('[web-098] the board journey completes at the phone viewport', async ({ page }) => {
    await start(page, await seededWorld());
    const card = page.getByText('Talk to me').first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await fitsViewport(page);
  });

  test('[web-098] the project filter journey completes at the phone viewport', async ({ page }) => {
    await start(page, await seededWorld());
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('link', { name: 'Alpha', exact: true }).click();
    await expect(page.getByText('Alpha chore').first()).toBeVisible();
    await expect(page.getByText('Bravo chore')).toHaveCount(0);
    await fitsViewport(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('link', { name: 'Bravo', exact: true }).click();
    await expect(page.getByText('Bravo chore').first()).toBeVisible();
    await expect(page.getByText('Alpha chore')).toHaveCount(0);
  });

  test('[web-098] the task page journey completes at the phone viewport', async ({ page }) => {
    await start(page, await seededWorld());
    await openTask(page, 'Talk to me');
    await expect(page.getByRole('region', { name: 'Task actions' })).toBeInViewport();
    await fitsViewport(page);
  });

  test('[web-098] the reply journey completes at the phone viewport', async ({ page }) => {
    const world = await seededWorld();
    await start(page, world);
    await openTask(page, 'Talk to me');
    const panel = page.getByRole('region', { name: 'Task actions' });
    await panel.getByRole('textbox', { name: 'Reply' }).fill('reply text from the phone');
    await panel.getByRole('button', { name: /^Send( & continue)?$/ }).click();
    await expect.poll(() => world.commands.length).toBeGreaterThan(0);
    await expect(panel.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
  });

  test('[web-098] the answer a question journey completes at the phone viewport', async ({
    page,
  }) => {
    const world = await seededWorld();
    await start(page, world);
    await openTask(page, 'Ask me');
    const form = page.getByRole('form', { name: 'Question' });
    await form
      .getByRole('group', { name: COLOUR.question })
      .getByRole('radio', { name: /Red/ })
      .check();
    await form.getByRole('button', { name: 'Submit answer' }).click();
    await expect.poll(() => world.commands.length).toBeGreaterThan(0);
  });

  test('[web-098] the new task journey completes at the phone viewport', async ({ page }) => {
    const world = await seededWorld();
    await start(page, world);
    await page.getByRole('button', { name: /^new task$/i }).click();
    await page.getByLabel(/^prompt$/i).fill('prompt of the phone task');
    await page.getByLabel(/^title$/i).fill('Phone task');
    await fitsViewport(page);
    await page.getByRole('button', { name: /^create( task)?$/i }).click();
    await expect.poll(() => world.callsTo('/api/client/tasks/create').length).toBeGreaterThan(0);
  });

  test('[web-098] the schedules journey completes at the phone viewport', async ({ page }) => {
    const world = await seededWorld();
    await world.seedSchedule({ id: 'sched-1', title: 'Nightly build' });
    await start(page, world);
    await openMenu(page);
    await page.getByRole('link', { name: /^schedules$/i }).click();
    await expect(page.getByText('Nightly build').first()).toBeVisible();
    await fitsViewport(page);
    await page
      .getByRole('button', { name: /^pause$/i })
      .first()
      .click();
    await expect.poll(() => world.schedules[0]?.paused).toBe(true);
    await page
      .getByRole('button', { name: /^resume$/i })
      .first()
      .click();
    await expect.poll(() => world.schedules[0]?.paused).toBe(false);
  });

  test('[web-098] the settings journey completes at the phone viewport', async ({ page }) => {
    await start(page, await seededWorld());
    await openMenu(page);
    await page.getByRole('link', { name: /^settings$/i }).click();
    await page
      .getByRole('tab', { name: /^machines$/i })
      .or(page.getByRole('link', { name: /^machines$/i }))
      .first()
      .click();
    await expect(page.getByText('laptop').first()).toBeVisible();
    await fitsViewport(page);
  });

  test('[web-097] the servers dialog and its messages fit the phone viewport without scrolling', async ({
    page,
  }) => {
    await start(page, await seededWorld());
    await page.getByRole('button', { name: 'Servers' }).click();
    const list = page.getByRole('dialog', { name: 'Servers' });
    await expect(list).toBeInViewport();
    await list.getByRole('button', { name: 'Add server' }).click();
    const add = page.getByRole('dialog', { name: 'Add server' });
    await add.getByLabel('Name').fill('Plain http');
    await add.getByLabel('Address').fill('http://lan.example');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add.getByRole('alert')).toBeInViewport();
    await expect(add.getByRole('alert')).toContainText('Use https.');
    await fitsViewport(page);
  });
});
