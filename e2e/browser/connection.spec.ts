import { expect, test } from '@playwright/test';

import { createTask } from '../src/fixtures/tasks.js';
import { useBoard } from '../src/harness/playwright.js';
import { seedAccount, unlockIfAsked } from '../src/steps/keys.js';

const BANNER = /not answering,? retrying/i;
const OUTAGE_BUDGET_MS = 30_000;

test.describe('connection check', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[web-006] a stopped server shows the retrying banner, keeps the cards, and the banner clears once it answers again', async ({
    page,
  }) => {
    const { board } = harness;
    const { user, key } = await seedAccount(board);
    const task = await createTask({ url: board.url }, user, key, {
      prompt: 'a card that stays while the server is away',
      title: 'Card that stays',
      status: 'backlog',
    });

    await page.goto(board.url);
    await unlockIfAsked(page, key.passphrase);
    await expect(page.getByText(task.title).first()).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);

    await board.api.stop();
    await expect(page.getByText(BANNER).first()).toBeVisible({ timeout: OUTAGE_BUDGET_MS });
    await expect(page.getByText(task.title).first()).toBeVisible();

    await board.api.restart();
    await expect(page.getByText(BANNER)).toHaveCount(0, { timeout: OUTAGE_BUDGET_MS });
    await expect(page.getByText(task.title).first()).toBeVisible();
  });
});
