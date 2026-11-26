import { rmSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { runApi } from '../src/harness/api.js';
import { useBoard } from '../src/harness/playwright.js';
import { SETUP_NAMES, fillSetup, readRecoveryKey, waitForBoard } from '../src/steps/keys.js';
import { pairCodeIn, readBrowserKeyStorage, shortTempPath } from '../src/steps/signature.js';

function useSigningBoard(label: string) {
  const controlSocket = shortTempPath(label);
  const harness = useBoard({
    parts: ['api', 'web'],
    features: ['request-signature', 'pairing', 'devices'],
    auth: 'no-login',
    env: { REQUEST_SIGNATURE: 'on', CONTROL_SOCKET: controlSocket },
  });

  test.afterAll(() => {
    rmSync(controlSocket, { force: true });
  });

  return harness;
}

async function pairWithCode(page: Page, harness: ReturnType<typeof useBoard>): Promise<void> {
  const printed = await runApi(harness.board.api, ['pair']);
  const code = pairCodeIn(printed.stdout);
  expect(code).not.toBeNull();
  await page.getByLabel(/pairing code|code/i).fill(code as string);
  await page.getByRole('button', { name: /^pair/i }).click();
}

test.describe('browser client request signature', () => {
  const harness = useSigningBoard('web-control.sock');

  test('[web-104] a signing server asks for pairing, accepts a code from pair and then loads the board', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await expect(page.getByLabel(/pairing code|code/i)).toBeVisible();
    await pairWithCode(page, harness);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel(/pairing code|code/i)).toHaveCount(0);
  });

  test('[web-104] the client holds one non-extractable signing key for the server', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await pairWithCode(page, harness);
    await expect(page.getByRole('main')).toBeVisible();
    await expect
      .poll(async () => (await readBrowserKeyStorage(page)).keys.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const storage = await readBrowserKeyStorage(page);
    expect(storage.databases).toHaveLength(1);
    const privateKeys = storage.keys.filter((key) => key.type === 'private');
    expect(privateKeys).toHaveLength(1);
    expect(privateKeys[0]?.extractable).toBe(false);
  });
});

test.describe('browser client request signature', () => {
  const harness = useSigningBoard('web-revoke.sock');

  test('[web-104] Settings › Devices lists the key and revoking it returns the client to pairing', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await pairWithCode(page, harness);
    await fillSetup(page, 'a passphrase for this board');
    await readRecoveryKey(page);
    await page.getByRole('checkbox', { name: SETUP_NAMES.stored }).check();
    await page.getByRole('button', { name: SETUP_NAMES.done }).click();
    await waitForBoard(page);
    await page.getByRole('link', { name: /settings/i }).click();
    await page
      .getByRole('tab', { name: /devices/i })
      .or(page.getByRole('link', { name: /devices/i }))
      .click();
    const revoke = page.getByRole('button', { name: /revoke/i });
    await expect(revoke).toHaveCount(1);
    await revoke.click();
    const confirm = page
      .getByRole('alertdialog')
      .or(page.getByRole('dialog'))
      .getByRole('button', { name: /revoke/i });
    const pairing = page.getByLabel(/pairing code|code/i);
    await expect(confirm.or(pairing).first()).toBeVisible();
    if (await confirm.isVisible()) await confirm.click();
    await expect(pairing).toBeVisible();
  });
});
