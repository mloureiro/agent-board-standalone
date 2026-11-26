import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { useBoard } from '../src/harness/playwright.js';
import {
  JOURNEY_NAMES,
  UI_TIMEOUT_MS,
  cardOf,
  clearWebStorageKeepingServerList,
  entriesContaining,
  journeyMarker,
  openNotificationSettings,
  readWebStorage,
  runJourney,
  seedAccount,
  unlockIfAsked,
  unlockWith,
  waitForBoard,
} from '../src/steps/keys.js';

test.describe('web storage holds volatile state only', () => {
  const harness = useBoard({
    parts: ['api', 'web'],
    features: ['settings-document'],
    auth: 'no-login',
  });

  test('[web-099] after a full journey, clearing localStorage and sessionStorage (the server list is the one exemption) loses no title, icon, label or setting', async ({
    page,
  }) => {
    const { board } = harness;
    const { user, key } = await seedAccount(board);
    const journey = journeyMarker(randomBytes(4).toString('hex'));

    await page.goto(board.url);
    await unlockWith(page, key.passphrase);
    await waitForBoard(page);
    await runJourney(page, journey);

    await clearWebStorageKeepingServerList(page);
    await page.reload();
    await unlockIfAsked(page, key.passphrase);

    const card = cardOf(page, journey.title);
    await expect(card).toBeVisible({ timeout: UI_TIMEOUT_MS });
    await expect(card.getByRole('img', { name: journey.icon })).toBeVisible();
    await expect(card.getByText(journey.label)).toBeVisible();

    await openNotificationSettings(page);
    await expect(page.getByRole('checkbox', { name: JOURNEY_NAMES.notifications })).toBeChecked();
    expect((await user.ok('client.settings.get', {})).document).not.toBeNull();
  });

  test('[web-099] no key in localStorage or sessionStorage holds the task title or prompt text', async ({
    page,
  }) => {
    const { board } = harness;
    const { key } = await seedAccount(board);
    const journey = journeyMarker(randomBytes(4).toString('hex'));

    await page.goto(board.url);
    await unlockWith(page, key.passphrase);
    await waitForBoard(page);
    await runJourney(page, journey);

    const snapshot = await readWebStorage(page);
    expect(entriesContaining(snapshot, journey.title)).toEqual([]);
    expect(entriesContaining(snapshot, journey.prompt)).toEqual([]);
  });
});
