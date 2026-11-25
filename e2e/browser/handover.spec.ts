import { randomBytes } from 'node:crypto';

import { buildHandover } from '@agent-board/contract';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { createBridgeHost, type BridgeHost } from '../src/fakes/bridge/host.js';
import type { Board } from '../src/harness/board.js';
import { DEFAULT_PASSPHRASE } from '../src/fixtures/keys.js';
import { createTask } from '../src/fixtures/tasks.js';
import { cardOf, seedAccount, unlockAll, usePair } from '../src/steps/servers.js';

const NAME_A = 'Handover A';
const NAME_B = 'Handover B';

interface Native {
  readonly context: BrowserContext;
  readonly host: BridgeHost;
  readonly page: Page;
}

async function openNative(
  browser: Browser,
  loadFrom: Board,
  servers: readonly { readonly name: string; readonly url: string }[],
): Promise<Native> {
  const host = createBridgeHost({ servers });
  const context = await browser.newContext();
  await host.attach(context);
  const page = await context.newPage();
  await page.goto(loadFrom.url);
  await unlockAll(page, DEFAULT_PASSPHRASE);
  return { context, host, page };
}

async function closeNative(native: Native | null): Promise<void> {
  native?.host.stopStreams();
  await native?.context.close();
}

const portOf = (url: string): string => new URL(url).port;
const linkFor = (board: Board): string => buildHandover(`${board.url}/`);

test.describe('handover from the server app to the client app', () => {
  const harness = usePair({ parts: ['api', 'web'], features: [] });

  async function seedTitles(): Promise<{ titleA: string; titleB: string }> {
    const { pair } = harness;
    const suffix = randomBytes(3).toString('hex');
    const titles = { titleA: `handover a ${suffix}`, titleB: `handover b ${suffix}` };
    for (const [board, title] of [
      [pair.a, titles.titleA],
      [pair.b, titles.titleB],
    ] as const) {
      const { user, key } = await seedAccount(board);
      await createTask(board, user, key, { prompt: title, title, status: 'backlog' });
    }
    return titles;
  }

  test('[client-app-013] a handed-over URL already in the list opens that server and adds nothing', async ({
    browser,
  }) => {
    const { pair } = harness;
    const { titleA, titleB } = await seedTitles();
    let native: Native | null = null;
    try {
      native = await openNative(browser, pair.a, [
        { name: NAME_A, url: pair.a.url },
        { name: NAME_B, url: pair.b.url },
      ]);
      const { host, page } = native;
      const before = host.servers().map((entry) => entry.id);
      await host.deliverHandover(linkFor(pair.b));
      await unlockAll(page, DEFAULT_PASSPHRASE);
      await expect(cardOf(page, titleB)).toBeVisible();
      await expect(cardOf(page, titleA)).toHaveCount(0);
      expect(host.servers().map((entry) => entry.id)).toEqual(before);
      expect(host.confirmations).toEqual([]);
    } finally {
      await closeNative(native);
    }
  });

  test('[client-app-013] a handed-over URL not in the list adds the server and opens it through the handshake', async ({
    browser,
  }) => {
    const { pair } = harness;
    const { titleA, titleB } = await seedTitles();
    let native: Native | null = null;
    try {
      native = await openNative(browser, pair.a, [{ name: NAME_A, url: pair.a.url }]);
      const { host, page } = native;
      await expect(cardOf(page, titleA)).toBeVisible();
      await host.deliverHandover(linkFor(pair.b));
      await expect.poll(() => host.servers().length).toBe(2);
      const added = host.servers().find((entry) => entry.url.replace(/\/+$/, '') === pair.b.url);
      expect(added).toBeDefined();
      await unlockAll(page, DEFAULT_PASSPHRASE);
      await expect(cardOf(page, titleB)).toBeVisible();
      await expect(cardOf(page, titleA)).toHaveCount(0);
      expect(host.refusals).toEqual([]);
    } finally {
      await closeNative(native);
    }
  });

  test('[client-app-013] two loopback servers added by handover get distinct names that include their port', async ({
    browser,
  }) => {
    const { pair } = harness;
    await seedTitles();
    let native: Native | null = null;
    try {
      native = await openNative(browser, pair.a, []);
      const { host } = native;
      await host.deliverHandover(linkFor(pair.a));
      await expect.poll(() => host.servers().length).toBe(1);
      await host.deliverHandover(linkFor(pair.b));
      await expect.poll(() => host.servers().length).toBe(2);
      const names = host.servers().map((entry) => entry.name);
      expect(new Set(names).size).toBe(2);
      for (const board of [pair.a, pair.b]) {
        const entry = host
          .servers()
          .find((candidate) => candidate.url.replace(/\/+$/, '') === board.url);
        expect(entry?.name).toContain(portOf(board.url));
      }
    } finally {
      await closeNative(native);
    }
  });
});
