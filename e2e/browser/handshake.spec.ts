import { CONTRACT } from '@agent-board/contract';
import { expect, test, type Page } from '@playwright/test';

import { startVersionProxy, type VersionOverride } from '../src/fixtures/version-proxy.js';
import { useBoard } from '../src/harness/playwright.js';
import { versionNamed } from '../src/steps/signature.js';

test.describe('browser client handshake', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  async function openThroughProxy(page: Page, override: VersionOverride): Promise<void> {
    const proxy = await startVersionProxy({ target: harness.board.url, override });
    try {
      await page.goto(proxy.url);
      await expect(page.getByText(/too old/i).first()).toBeVisible();
    } catch (error) {
      await proxy.stop();
      throw error;
    }
    test.info().annotations.push({ type: 'proxy', description: proxy.url });
    proxies.push(proxy);
  }

  const proxies: Awaited<ReturnType<typeof startVersionProxy>>[] = [];

  test.afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  });

  test('[web-078] a server whose minimum client is higher shows "client too old" naming both versions @matrix', async ({
    page,
  }) => {
    await openThroughProxy(page, { minClient: { web: CONTRACT + 1 } });
    await expect(page.getByText(/client too old/i).first()).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toMatch(versionNamed(CONTRACT));
    expect(text).toMatch(versionNamed(CONTRACT + 1));
  });

  test('[web-078] a server with a lower contract shows "server too old" naming both versions @matrix', async ({
    page,
  }) => {
    await openThroughProxy(page, { contract: CONTRACT - 1 });
    await expect(page.getByText(/server too old/i).first()).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toMatch(versionNamed(CONTRACT));
    expect(text).toMatch(versionNamed(CONTRACT - 1));
  });

  test('[web-078] against the real server the board loads @matrix', async ({ page }) => {
    await page.goto(harness.board.url);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText(/too old/i)).toHaveCount(0);
  });
});
