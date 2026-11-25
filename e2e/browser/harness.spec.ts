import { expect, test } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';

test.describe('[harness]', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[harness] the browser client loads from WEB_ROOT', async ({ page }) => {
    const response = await page.goto(harness.board.url);
    expect(response?.status()).toBe(200);
    await expect(page.locator('body')).toBeAttached();
  });
});
