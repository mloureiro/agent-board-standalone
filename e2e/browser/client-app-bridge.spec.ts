import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { call, clientToken } from '../src/client/contract-client.js';
import { setClockOffset } from '../src/harness/clock.js';
import {
  BRIDGE_NAMES,
  SESSION_CHECK_TIMEOUT_MS,
  SESSION_LIFETIME_SECONDS,
  accountOnLoginBoard,
  approverContext,
  dumpPageStorage,
  holdsToken,
  indexedDbNames,
  localKeysWithPrefix,
  newBridgeHost,
  openBridgedClient,
  seedNamespace,
  signInButton,
  signInThroughBridge,
  startHandoff,
  useLoginBoard,
} from '../src/steps/bridge.js';
import { NOT_ANSWERING } from '../src/steps/journeys.js';
import { UI_TIMEOUT_MS, unlockIfAsked, waitForBoard } from '../src/steps/keys.js';
import { approveHandoff } from '../src/fixtures/browser.js';

const PASSPHRASE = 'bridge passphrase here';
const UNREACHABLE_URL = 'http://127.0.0.1:9';

test.describe('client app sessions through the native bridge', () => {
  const harness = useLoginBoard({ parts: ['api', 'web'], features: ['client-tokens'] });

  test('[client-app-022] a second page for the same server opens signed in and unlocked', async ({
    browser,
  }) => {
    const { board } = harness;
    const account = await accountOnLoginBoard(board, PASSPHRASE);
    const { host, serverId } = newBridgeHost(board);
    const client = await openBridgedClient(browser, board, host, serverId);
    const approver = await approverContext(browser, account.user);
    try {
      await signInThroughBridge(client, board, approver);
      await unlockIfAsked(client.page, PASSPHRASE);

      const second = await client.context.newPage();
      await second.goto(board.url);
      await waitForBoard(second);
      await expect(signInButton(second)).toHaveCount(0);
    } finally {
      await approver.close();
      await client.context.close();
    }
  });

  test('[client-app-033] the hand-off link goes to the external-open call and approval elsewhere signs in; an in-app link stays in the page', async ({
    browser,
  }) => {
    const { board } = harness;
    const account = await accountOnLoginBoard(board, PASSPHRASE);
    const { host, serverId } = newBridgeHost(board);
    const client = await openBridgedClient(browser, board, host, serverId);
    const approver = await approverContext(browser, account.user);
    try {
      const code = await startHandoff(client.page, host);
      await expect.poll(() => host.externalOpens.length, { timeout: UI_TIMEOUT_MS }).toBe(1);
      const opened = new URL(host.externalOpens[0] ?? '');
      expect(opened.origin).toBe(new URL(board.url).origin);
      expect(opened.toString()).toContain(code);
      expect(client.page.url()).not.toBe(opened.toString());

      const approval = await approveHandoff(approver, board.url, code);
      await approval.close();
      await unlockIfAsked(client.page, PASSPHRASE);
      expect(host.tokenFor(serverId)).toBeDefined();

      await client.page.getByRole('link', { name: BRIDGE_NAMES.settings }).click();
      await expect(client.page).toHaveURL(/settings/i);
      expect(new URL(client.page.url()).origin).toBe(new URL(board.url).origin);
      expect(host.externalOpens).toHaveLength(1);
    } finally {
      await approver.close();
      await client.context.close();
    }
  });

  test('[client-app-035] the session survives an app restart while the server keeps it valid, and expiry shows sign-in', async ({
    browser,
  }) => {
    const { board } = harness;
    const account = await accountOnLoginBoard(board, PASSPHRASE);
    const { host, serverId } = newBridgeHost(board);
    const first = await openBridgedClient(browser, board, host, serverId);
    const approver = await approverContext(browser, account.user);
    try {
      await signInThroughBridge(first, board, approver);
      await unlockIfAsked(first.page, PASSPHRASE);
      const token = host.tokenFor(serverId);
      await first.context.close();

      const restarted = await openBridgedClient(browser, board, host, serverId);
      try {
        expect(host.tokenFor(serverId)).toBe(token);
        await expect(signInButton(restarted.page)).toHaveCount(0);
        await unlockIfAsked(restarted.page, PASSPHRASE);

        setClockOffset(board, SESSION_LIFETIME_SECONDS);
        await restarted.page.reload();
        await expect(signInButton(restarted.page)).toBeVisible({
          timeout: SESSION_CHECK_TIMEOUT_MS,
        });
      } finally {
        setClockOffset(board, 0);
        await restarted.context.close();
      }
    } finally {
      await approver.close();
    }
  });

  test('[client-app-037] the token stays in the bridge, sign-out deletes it, and a revoked session returns the page to sign-in within 25 s', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { board } = harness;
    const account = await accountOnLoginBoard(board, PASSPHRASE);
    const { host, serverId } = newBridgeHost(board);
    const client = await openBridgedClient(browser, board, host, serverId);
    const approver = await approverContext(browser, account.user);
    try {
      await signInThroughBridge(client, board, approver);
      await unlockIfAsked(client.page, PASSPHRASE);
      const token = host.tokenFor(serverId) ?? '';
      expect(holdsToken(token)).toBe(true);

      expect(host.passedToPage.filter(holdsToken)).toEqual([]);
      const stored = await dumpPageStorage(client.page);
      expect(holdsToken(stored)).toBe(false);
      expect(stored).not.toContain(token);
      expect(JSON.stringify(await client.context.cookies())).not.toContain(token);

      await client.page.getByRole('button', { name: BRIDGE_NAMES.signOut }).click();
      await expect.poll(() => host.tokenFor(serverId), { timeout: UI_TIMEOUT_MS }).toBeUndefined();
      await expect(signInButton(client.page)).toBeVisible({ timeout: UI_TIMEOUT_MS });

      await signInThroughBridge(client, board, approver);
      await unlockIfAsked(client.page, PASSPHRASE);
      const revoked = host.tokenFor(serverId) ?? '';
      const logout = await call({ url: board.url }, 'auth.logout', {}, clientToken(revoked));
      expect(logout.ok).toBe(true);
      await expect(signInButton(client.page)).toBeVisible({ timeout: 25_000 });
    } finally {
      await approver.close();
      await client.context.close();
    }
  });

  test('[client-app-039] signing out of a server clears its token, keys, drafts and cache and leaves another server untouched', async ({
    browser,
  }) => {
    const { board } = harness;
    const account = await accountOnLoginBoard(board, PASSPHRASE);
    const task = await account.seedTask(
      `Cached ${randomBytes(4).toString('hex')}`,
      'cached prompt',
    );
    const { host, serverId } = newBridgeHost(board);
    const client = await openBridgedClient(browser, board, host, serverId);
    const approver = await approverContext(browser, account.user);
    try {
      await signInThroughBridge(client, board, approver);
      await unlockIfAsked(client.page, PASSPHRASE);
      await expect(client.page.getByText(task.title).first()).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });

      const other = host.seedServer({ name: 'Other server', url: UNREACHABLE_URL });
      await seedNamespace(client.page, other.id, 'other server marker');

      await client.page.getByRole('button', { name: /new task/i }).click();
      await client.page.getByLabel(/^prompt$/i).fill('a draft that dies with the session');
      await expect
        .poll(() => localKeysWithPrefix(client.page, `ab:${serverId}:`), { timeout: UI_TIMEOUT_MS })
        .not.toEqual([]);
      expect(await indexedDbNames(client.page)).toContain(`agent-board:${serverId}`);

      await client.page.getByRole('button', { name: BRIDGE_NAMES.signOut }).click();
      await expect.poll(() => host.tokenFor(serverId), { timeout: UI_TIMEOUT_MS }).toBeUndefined();
      await expect(signInButton(client.page)).toBeVisible({ timeout: UI_TIMEOUT_MS });

      expect(await localKeysWithPrefix(client.page, `ab:${serverId}:`)).toEqual([]);
      expect(await indexedDbNames(client.page)).not.toContain(`agent-board:${serverId}`);
      await client.page.reload();
      await expect(signInButton(client.page)).toBeVisible({ timeout: UI_TIMEOUT_MS });
      await signInThroughBridge(client, board, approver);
      host.seedServer({ id: serverId, name: 'Unreachable', url: UNREACHABLE_URL });
      await client.page.reload();
      await expect(client.page.getByText(NOT_ANSWERING).first()).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      });
      await expect(client.page.getByText(task.title)).toHaveCount(0);

      expect(await localKeysWithPrefix(client.page, `ab:${other.id}:`)).toEqual([
        `ab:${other.id}:draft`,
      ]);
      expect(await indexedDbNames(client.page)).toContain(`agent-board:${other.id}`);
      expect(await dumpPageStorage(client.page)).toContain('other server marker');
    } finally {
      await approver.close();
      await client.context.close();
    }
  });
});
