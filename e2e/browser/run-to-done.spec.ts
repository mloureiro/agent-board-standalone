import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { startServerAppLayout, type ServerAppLayout } from '../src/fixtures/server-app-layout.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { noLoginUser } from '../src/fixtures/users.js';
import { missingParts } from '../src/harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../src/harness/skip.js';
import {
  BOARD_NAMES,
  RUN_TIMEOUT_MS,
  UI_TIMEOUT_MS,
  boardLink,
  cardIn,
  openBoard,
  uniqueTitle,
  waitForStatus,
  type Account,
} from '../src/steps/board.js';

test.describe('server-app layout run to Done', () => {
  let layout: ServerAppLayout | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    const missing = missingParts(['api', 'web', 'cli']);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    layout = await startServerAppLayout({ web: true });
    const response = await fetch(`${layout.url}/api/version`);
    const body = (await response.json()) as { features?: string[] };
    if (!(body.features ?? []).includes('machine-grant')) {
      reason = featureSkipReason([{ name: 'machine-grant', label: 'machine grants' }]);
    }
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

  test('[server-app-004] a card made in the client is run to Done by the enrolled worker and the board shows the result @matrix', async ({
    page,
  }) => {
    test.setTimeout(RUN_TIMEOUT_MS + 120_000);
    const current = layout as ServerAppLayout;
    const user = await noLoginUser({ url: current.url });
    const key = await unlockedKey({ url: current.url }, user);
    const account: Account = { user, key, url: current.url };
    const worker = await enrolledMachine(current, user, {
      key,
      name: 'layout-worker',
      actsAsOwner: true,
    });
    const directory = worker.tmp.path('work');
    mkdirSync(directory, { recursive: true });
    expect((await worker.cli(['dirs', 'add', directory])).code).toBe(0);
    const listener = worker.start(['internal', 'listen']);
    try {
      await openBoard(page, account);
      const title = uniqueTitle('layout card');
      await page.getByRole('button', { name: BOARD_NAMES.newTask }).click();
      await page.getByLabel(BOARD_NAMES.prompt).fill(`${title}\n#stub: done`);
      await page.getByLabel(BOARD_NAMES.title).fill(title);
      await page.getByRole('button', { name: BOARD_NAMES.create }).click();

      await expect(cardIn(page, 'done', title)).toBeVisible({ timeout: RUN_TIMEOUT_MS });
      const listed = await user.ok('client.tasks.list', {});
      const task = listed.tasks.find(
        (entry) => entry.status === 'done' && entry.machine === 'layout-worker',
      );
      expect(task).toBeDefined();
      await waitForStatus(account, (task as { id: string }).id, 'done');

      await cardIn(page, 'done', title).getByRole('link', { name: title }).click();
      await expect(page.getByText('done', { exact: true }).first()).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });
      await boardLink(page).click();
      await expect(cardIn(page, 'done', title)).toBeVisible({ timeout: UI_TIMEOUT_MS });
    } finally {
      await listener.stop().catch(() => undefined);
    }
  });
});
