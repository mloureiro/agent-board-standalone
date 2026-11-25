import { expect, test, type Page } from '@playwright/test';

import { PROJECT_HOME_ID } from '../test/projects-world.js';
import { PhoneWorld, serve, serveOther, unlock } from './world.js';

const B_ORIGIN = 'https://b.example';

async function worldWith(title: string): Promise<PhoneWorld> {
  const world = new PhoneWorld();
  await world.seedProjects([{ id: PROJECT_HOME_ID, name: null, icon: null, isDefault: true }]);
  await world.seed({ id: 'only', title, status: 'backlog' });
  return world;
}

const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title });

async function addServerB(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^servers$/i }).click();
  await expect(page.getByRole('list', { name: /servers/i })).toBeVisible();
  await page.getByRole('button', { name: /^add server$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^add server$/i });
  await dialog.getByLabel(/^name$/i).fill('Server B');
  await dialog.getByLabel(/^address$/i).fill(B_ORIGIN);
  await dialog.getByRole('button', { name: /^add( server)?$/i }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole('list', { name: /servers/i })
      .getByRole('listitem')
      .filter({ hasText: 'Server B' }),
  ).toBeVisible();
}

test.describe('several servers', () => {
  test('[web-085] one server is unlocked while the other asks for its passphrase @desktop', async ({
    page,
  }) => {
    await serve(page.context(), await worldWith('Task on A'));
    await serveOther(page.context(), B_ORIGIN, await worldWith('Task on B'));
    await page.goto('/');
    await unlock(page);
    await expect(card(page, 'Task on A')).toBeVisible();

    await addServerB(page);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel(/passphrase/i).first()).toBeVisible();
    await expect(card(page, 'Task on A')).toBeVisible();
    await unlock(page);
    await expect(card(page, 'Task on B')).toBeVisible();
    await expect(card(page, 'Task on B')).toContainText('Server B');
    await expect(card(page, 'Task on A')).toContainText('127.0.0.1');
  });

  test('[web-086] the board shows one server at a time through the server filter @desktop', async ({
    page,
  }) => {
    await serve(page.context(), await worldWith('Task on A'));
    await serveOther(page.context(), B_ORIGIN, await worldWith('Task on B'));
    await page.goto('/');
    await unlock(page);
    await addServerB(page);
    await page.keyboard.press('Escape');
    await unlock(page);
    await expect(card(page, 'Task on B')).toBeVisible();

    const filter = page.getByRole('combobox', { name: /^server( filter)?$/i });
    await filter.click();
    await page.getByRole('option', { name: 'Server B' }).click();
    await expect(card(page, 'Task on B')).toBeVisible();
    await expect(card(page, 'Task on A')).toHaveCount(0);
    await filter.click();
    await page.getByRole('option', { name: /^all servers$/i }).click();
    await expect(card(page, 'Task on A')).toBeVisible();
  });

  test('[web-095] Remove sits behind the row menu, is confirmed in the row and deletes that namespace @desktop', async ({
    page,
  }) => {
    await serve(page.context(), await worldWith('Task on A'));
    await serveOther(page.context(), B_ORIGIN, await worldWith('Task on B'));
    await page.goto('/');
    await unlock(page);
    await addServerB(page);
    await page.keyboard.press('Escape');
    await unlock(page);
    await expect(card(page, 'Task on B')).toBeVisible();

    const entries = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('ab:servers') ?? '[]') as { id: string; name: string }[],
    );
    const idB = entries.find((entry) => entry.name === 'Server B')?.id ?? '';
    await page.getByRole('button', { name: /^servers$/i }).click();
    const row = page
      .getByRole('list', { name: /servers/i })
      .getByRole('listitem')
      .filter({ hasText: 'Server B' });
    await expect(row.getByRole('button', { name: /^remove$/i })).toHaveCount(0);
    await row.getByRole('button', { name: /actions|more|menu/i }).click();
    await page.getByRole('menuitem', { name: /^remove$/i }).click();
    const confirm = row.getByRole('button', { name: /confirm/i });
    await expect(confirm).toBeVisible();
    await page.getByRole('button', { name: /^add server$/i }).focus();
    await expect(confirm).toBeHidden();
    await row.getByRole('button', { name: /actions|more|menu/i }).click();
    await page.getByRole('menuitem', { name: /^remove$/i }).click();
    await row.getByRole('button', { name: /confirm/i }).click();
    await expect(row).toHaveCount(0);
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((entry) => entry.name),
    );
    expect(databases).not.toContain(`agent-board:${idB}`);
    await page.keyboard.press('Escape');
    await expect(card(page, 'Task on B')).toHaveCount(0);
    await expect(card(page, 'Task on A')).toBeVisible();
  });
});
