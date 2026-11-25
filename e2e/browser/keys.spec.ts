import { expect, test } from '@playwright/test';

import { persistentContext } from '../src/fixtures/browser.js';
import { noLoginUser } from '../src/fixtures/users.js';
import { useBoard } from '../src/harness/playwright.js';
import {
  FORBIDDEN_WRONG_DETAIL,
  SETUP_NAMES,
  UI_TIMEOUT_MS,
  WRONG_PASSPHRASE,
  changePassphraseInSettings,
  fillSetup,
  passphraseOpensSlots,
  readRecoveryKey,
  recoveryKeyOpensSlots,
  seedAccount,
  unlockIfAsked,
  unlockWith,
  waitForBoard,
} from '../src/steps/keys.js';

test.describe('key setup', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[web-019] a fresh user sets a passphrase twice and the first-time box, then sees the recovery key once', async ({
    page,
  }) => {
    const { board } = harness;
    const user = await noLoginUser({ url: board.url });
    await page.goto(board.url);

    await fillSetup(page, 'first passphrase here', 'a different passphrase');
    await expect(page.getByRole('alert')).toContainText(/match/i);
    await expect(page.getByLabel(SETUP_NAMES.recoveryKey)).toHaveCount(0);
    expect((await user.ok('client.keys.get', {})).setup).toBeNull();

    await page.getByLabel(SETUP_NAMES.confirm).fill('first passphrase here');
    await page.getByRole('button', { name: SETUP_NAMES.create }).click();
    const recoveryKey = await readRecoveryKey(page);
    expect(recoveryKey).not.toBe('');
    expect(await recoveryKeyOpensSlots(user, recoveryKey)).toBe(true);

    const done = page.getByRole('button', { name: SETUP_NAMES.done });
    await expect(done).toBeDisabled();
    await page.getByRole('checkbox', { name: SETUP_NAMES.stored }).check();
    await expect(done).toBeEnabled();
    await done.click();
    await waitForBoard(page);

    await page.reload();
    await unlockIfAsked(page, 'first passphrase here');
    await expect(page.getByLabel(SETUP_NAMES.recoveryKey)).toHaveCount(0);
    expect(await page.content()).not.toContain(recoveryKey);
  });
});

test.describe('unlocking a client', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[web-020] a client with no stored key shows only that a wrong passphrase is wrong, and the right one opens the board', async ({
    page,
  }) => {
    const { board } = harness;
    const { key } = await seedAccount(board);
    await page.goto(board.url);

    await unlockWith(page, `${key.passphrase} but wrong`);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(WRONG_PASSPHRASE, { timeout: UI_TIMEOUT_MS });
    await expect(alert).not.toContainText(FORBIDDEN_WRONG_DETAIL);
    await expect(page.getByText(FORBIDDEN_WRONG_DETAIL)).toHaveCount(0);

    await page.getByLabel(/passphrase/i).fill(key.passphrase);
    await page.getByRole('button', { name: /^unlock$/i }).click();
    await waitForBoard(page);
  });

  test('[web-026] after one unlock in a persistent context, closing and reopening it opens the server unlocked', async ({
    browserName,
  }) => {
    const { board } = harness;
    const { key } = await seedAccount(board);
    const profile = board.tmp.path('profile', browserName);
    const engine = browserName === 'webkit' ? 'webkit' : 'chromium';

    const first = await persistentContext(profile, { browser: engine });
    try {
      const page = await first.newPage();
      await page.goto(board.url);
      await unlockWith(page, key.passphrase);
      await waitForBoard(page);
    } finally {
      await first.close();
    }

    const second = await persistentContext(profile, { browser: engine });
    try {
      const page = await second.newPage();
      await page.goto(board.url);
      await waitForBoard(page);
    } finally {
      await second.close();
    }
  });
});

test.describe('changing the passphrase', () => {
  const harness = useBoard({ parts: ['api', 'web'], features: [], auth: 'no-login' });

  test('[web-024] Settings > Encryption changes the passphrase with the current one, and a new context takes only the new one', async ({
    page,
    browser,
  }) => {
    const { board } = harness;
    const { user, key } = await seedAccount(board);
    const next = 'a brand new passphrase';

    await page.goto(board.url);
    await unlockWith(page, key.passphrase);
    await waitForBoard(page);
    await changePassphraseInSettings(page, key.passphrase, next);
    await expect
      .poll(() => passphraseOpensSlots(user, next), { timeout: UI_TIMEOUT_MS })
      .toBe(true);
    expect(await passphraseOpensSlots(user, key.passphrase)).toBe(false);

    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await other.goto(board.url);
      await unlockWith(other, key.passphrase);
      await expect(other.getByRole('alert')).toContainText(WRONG_PASSPHRASE, {
        timeout: UI_TIMEOUT_MS,
      });
      await other.getByLabel(/passphrase/i).fill(next);
      await other.getByRole('button', { name: /^unlock$/i }).click();
      await waitForBoard(other);
    } finally {
      await fresh.close();
    }
  });
});
