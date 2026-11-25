import { rmSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { runApi } from '../src/harness/api.js';
import { useBoard } from '../src/harness/playwright.js';
import { pairCodeIn, readBrowserKeyStorage, shortTempPath } from '../src/steps/signature.js';

const controlSocket = shortTempPath('web-control.sock');

test.describe('browser client request signature', () => {
  const harness = useBoard({
    parts: ['api', 'web'],
    features: ['request-signature', 'pairing', 'devices'],
    auth: 'no-login',
    env: { REQUEST_SIGNATURE: 'on', CONTROL_SOCKET: controlSocket },
  });

  test.afterAll(() => {
    rmSync(controlSocket, { force: true });
  });

  async function pairWithCode(page: Page): Promise<void> {
    const printed = await runApi(harness.board.api, ['pair']);
    const code = pairCodeIn(printed.stdout);
    expect(code).not.toBeNull();
    await page.getByLabel(/pairing code|code/i).fill(code as string);
    await page.getByRole('button', { name: /^pair/i }).click();
  }

  test('[web-104] a signing server asks for pairing, accepts a code from pair and then loads the board', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await expect(page.getByLabel(/pairing code|code/i)).toBeVisible();
    await pairWithCode(page);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel(/pairing code|code/i)).toHaveCount(0);
  });

  test('[web-104] the client holds one non-extractable signing key for the server', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await pairWithCode(page);
    await expect(page.getByRole('main')).toBeVisible();
    const storage = await readBrowserKeyStorage(page);
    expect(storage.databases).toHaveLength(1);
    expect(storage.keys).toHaveLength(1);
    expect(storage.keys[0]?.extractable).toBe(false);
  });

  test('[web-104] Settings › Devices lists the key and revoking it returns the client to pairing', async ({
    page,
  }) => {
    await page.goto(harness.board.url);
    await pairWithCode(page);
    await expect(page.getByRole('main')).toBeVisible();
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
