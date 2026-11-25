import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BOARD_EXPORT_FORMAT, parseBoardExportLine } from '@agent-board/contract';
import { bindings, wrapSlot } from '@agent-board/sealing';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  call,
  machineToken,
  type RouteOutput,
  type ServerRef,
} from '../src/client/contract-client.js';
import { withVirtualAuthenticator } from '../src/fixtures/browser.js';
import { TEST_KDF, dataKeyBytes, unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine, type EnrolledMachine } from '../src/fixtures/machines.js';
import { createTask } from '../src/fixtures/tasks.js';
import { signedInUser, type BoardUser } from '../src/fixtures/users.js';
import {
  NAMES,
  SETTINGS_PAGES,
  loseFocus,
  notificationCount,
  openSettings,
  readSettings,
  settingValue,
  signedInPage,
  useLoginBoard,
} from '../src/steps/scenario.js';

const TOKEN_TEXT = /abm_[A-Za-z0-9_-]{43}/;
const DATA_KEY_TEXT = /abk1_[A-Za-z0-9_-]{43}/;
const NOTIFICATION_SETTING = 'notifications.desktop';

const openContexts: BrowserContext[] = [];

async function openSignedIn(
  ...args: Parameters<typeof signedInPage>
): ReturnType<typeof signedInPage> {
  const opened = await signedInPage(...args);
  openContexts.push(opened.context);
  return opened;
}

test.afterEach(async () => {
  await Promise.all(
    openContexts.splice(0).map((context) => context.close().catch(() => undefined)),
  );
});

function unique(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

async function machineList(
  user: BoardUser,
): Promise<RouteOutput<'client.machines.list'>['machines']> {
  return (await user.ok('client.machines.list', {})).machines;
}

test.describe('[web-069] [web-070] [web-073] Settings', () => {
  const harness = useLoginBoard({
    parts: ['api', 'web', 'cli'],
    features: ['feeds', 'settings-document', 'attention', 'board-export'],
  });

  let account: { user: BoardUser; key: UnlockedKey } | null = null;

  test.beforeAll(() => {
    account = null;
  });

  const prepare = async (): Promise<{ user: BoardUser; key: UnlockedKey }> => {
    if (account !== null) return account;
    const user = await signedInUser(harness.board);
    const key = await unlockedKey(harness.board, user);
    account = { user, key };
    return account;
  };

  const server = (): ServerRef => ({ url: harness.board.url });

  const rowOf = (page: Page, name: string) =>
    page
      .getByRole('listitem')
      .filter({ hasText: name })
      .or(page.getByRole('row').filter({ hasText: name }))
      .first();

  test.describe('Machines', () => {
    test('[web-069] lists machines with their CLI status and usage', async ({ browser }) => {
      const { user, key } = await prepare();
      const name = unique('listed');
      const machine = await enrolledMachine(harness.board, user, { key, name });
      const usage = JSON.stringify({ sessions: 7, tokens: 12345 });
      await machine.ok('machine.set-usage', {
        usage: await key.seal(bindings.machineDocument('machine.usage', name), usage),
        index: await key.blindIndex(usage),
      });
      const stored = (await machineList(user)).find((entry) => entry.name === name);
      expect(stored?.clientStatus).toBe('current');
      expect(stored?.usage).not.toBeNull();

      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.machines);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect(row).toContainText(/current/i);
      await expect(row).toContainText(/12,?345/);
    });

    test('[web-069] adds a machine and shows its token and data key once', async ({ browser }) => {
      const { user, key } = await prepare();
      const name = unique('added');
      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.machines);

      await page.getByRole('button', { name: /^add machine$/i }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(/name/i).fill(name);
      await dialog.getByRole('button', { name: /^(add|create|issue)( machine)?$/i }).click();

      await expect(dialog).toContainText(TOKEN_TEXT);
      await expect(dialog).toContainText(DATA_KEY_TEXT);
      const shown = (await dialog.innerText()) ?? '';
      const token = TOKEN_TEXT.exec(shown)?.[0] ?? '';
      const dataKey = DATA_KEY_TEXT.exec(shown)?.[0] ?? '';
      expect(dataKey).toBe(key.dataKey);
      const accepted = await call(server(), 'machine.version', {}, machineToken(token));
      expect(accepted.ok).toBe(true);

      await dialog.getByRole('button', { name: /^(close|done)$/i }).click();
      await expect(page.getByText(token)).toHaveCount(0);
      await expect(page.getByText(dataKey)).toHaveCount(0);
      await expect(rowOf(page, name)).toBeVisible();

      await page.getByRole('button', { name: /^add machine$/i }).click();
      await expect(page.getByRole('dialog')).not.toContainText(TOKEN_TEXT);
      await expect(page.getByRole('dialog')).not.toContainText(DATA_KEY_TEXT);
    });

    test('[web-069] re-issuing a machine token invalidates the old one', async ({ browser }) => {
      const { user, key } = await prepare();
      const name = unique('reissued');
      const machine: EnrolledMachine = await enrolledMachine(harness.board, user, { key, name });
      const before = await machine.cli(['tasks']);
      expect(before.code, before.stderr).toBe(0);

      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.machines);
      await rowOf(page, name)
        .getByRole('button', { name: /^re-?issue/i })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /^(re-?issue|confirm)$/i }).click();
      await expect(dialog).toContainText(TOKEN_TEXT);
      const fresh = TOKEN_TEXT.exec(await dialog.innerText())?.[0] ?? '';
      expect(fresh).not.toBe(machine.token);

      const old = await call(server(), 'machine.list-tasks', {}, machineToken(machine.token));
      expect(old.status).toBe(401);
      const after = await machine.cli(['tasks']);
      expect(after.code).not.toBe(0);
      const renewed = await call(server(), 'machine.list-tasks', {}, machineToken(fresh));
      expect(renewed.ok).toBe(true);
    });

    test('[web-069] revoking a machine removes it', async ({ browser }) => {
      const { user, key } = await prepare();
      const name = unique('revoked');
      const machine = await enrolledMachine(harness.board, user, { key, name, init: false });

      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.machines);
      await expect(rowOf(page, name)).toBeVisible();
      await rowOf(page, name)
        .getByRole('button', { name: /^revoke$/i })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^(revoke|confirm)$/i })
        .click();

      await expect(rowOf(page, name)).toHaveCount(0);
      const stored = (await machineList(user)).find((entry) => entry.name === name);
      expect(stored === undefined || stored.revokedAt !== null).toBe(true);
      const refused = await call(server(), 'machine.list-tasks', {}, machineToken(machine.token));
      expect(refused.status).toBe(401);
    });
  });

  test.describe('Feeds', () => {
    const feedId = '0123456789abcdef';
    const feedName = 'issues';

    interface FeedMachine {
      readonly machine: EnrolledMachine;
      readonly name: string;
    }

    let feedMachine: FeedMachine | null = null;

    test.beforeAll(() => {
      feedMachine = null;
    });

    const publish = async (state: 'idle' | 'paused'): Promise<FeedMachine> => {
      const { user, key } = await prepare();
      if (feedMachine === null) {
        const name = unique('feeder');
        feedMachine = {
          name,
          machine: await enrolledMachine(harness.board, user, { key, name, init: false }),
        };
      }
      const document = JSON.stringify({
        feeds: [
          {
            id: feedId,
            name: feedName,
            integration: 'e2e:issues',
            action: 'list',
            every: 3600,
            status: state,
            paused: state === 'paused',
          },
        ],
      });
      await feedMachine.machine.ok('machine.set-feeds', {
        feeds: await key.seal(
          bindings.machineDocument('machine.feeds', feedMachine.name),
          document,
        ),
        index: await key.blindIndex(document),
      });
      return feedMachine;
    };

    const requests = async (name: string): Promise<string[]> => {
      const { user } = await prepare();
      const listed = await user.ok('client.feeds.list', {});
      return listed.machines.find((entry) => entry.name === name)?.feedRequests ?? [];
    };

    const acknowledge = async (target: FeedMachine): Promise<void> => {
      const pending = await requests(target.name);
      await target.machine.ok('machine.ack-feed-requests', { requests: pending });
    };

    test("[web-070] shows each machine's feeds with their status", async ({ browser }) => {
      const { user, key } = await prepare();
      const target = await publish('idle');
      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.feeds);

      await expect(page.getByText(target.name)).toBeVisible();
      const row = rowOf(page, feedName);
      await expect(row).toBeVisible();
      await expect(row).toContainText(/idle/i);

      await publish('paused');
      await page.reload();
      await openSettings(page, SETTINGS_PAGES.feeds);
      await expect(rowOf(page, feedName)).toContainText(/paused/i);
    });

    test('[web-070] Run now, Pause and Resume each send their request for the feed', async ({
      browser,
    }) => {
      const { user, key } = await prepare();
      const target = await publish('idle');
      await acknowledge(target);
      const { page } = await openSignedIn(browser, harness.board, user, key);
      await openSettings(page, SETTINGS_PAGES.feeds);
      const row = rowOf(page, feedName);

      await row.getByRole('button', { name: /^run now$/i }).click();
      await expect.poll(() => requests(target.name)).toContain(`run:${feedId}`);
      await acknowledge(target);

      await row.getByRole('button', { name: /^pause$/i }).click();
      await expect.poll(() => requests(target.name)).toContain(`pause:${feedId}`);
      await acknowledge(target);
      await publish('paused');

      await page.reload();
      await openSettings(page, SETTINGS_PAGES.feeds);
      await rowOf(page, feedName)
        .getByRole('button', { name: /^resume$/i })
        .click();
      await expect.poll(() => requests(target.name)).toContain(`resume:${feedId}`);
    });
  });

  test.describe('Notifications', () => {
    const toggle = (page: Page) => page.getByRole('checkbox', { name: NAMES.notifications });

    const enable = async (browser: Parameters<typeof signedInPage>[0]): Promise<void> => {
      const { user, key } = await prepare();
      const { context, page } = await openSignedIn(browser, harness.board, user, key, {
        notifications: 'granted',
        spy: true,
      });
      await openSettings(page, SETTINGS_PAGES.notifications);
      await toggle(page).check();
      await expect
        .poll(async () => settingValue(await readSettings(user, key), NOTIFICATION_SETTING))
        .toBe(true);
      await context.close();
    };

    test(
      '[web-073] a task newly in Needs me fires a notification while the page is unfocused',
      {
        tag: '@chromium',
      },
      async ({ browser }) => {
        const { user, key } = await prepare();
        const { page } = await openSignedIn(browser, harness.board, user, key, {
          notifications: 'granted',
          spy: true,
        });
        await openSettings(page, SETTINGS_PAGES.notifications);
        await toggle(page).check();
        await expect
          .poll(async () => settingValue(await readSettings(user, key), NOTIFICATION_SETTING))
          .toBe(true);

        await loseFocus(page);
        const before = await notificationCount(page);
        await createTask(harness.board, user, key, {
          prompt: 'needs attention',
          title: unique('attention'),
          status: 'needs-me',
        });
        await expect.poll(() => notificationCount(page)).toBe(before + 1);
      },
    );

    test(
      '[web-073] the on and off setting is read back from the server in a new context',
      {
        tag: '@chromium',
      },
      async ({ browser }) => {
        const { user, key } = await prepare();
        await enable(browser);

        const second = await openSignedIn(browser, harness.board, user, key, {
          notifications: 'granted',
          spy: true,
        });
        await openSettings(second.page, SETTINGS_PAGES.notifications);
        await expect(toggle(second.page)).toBeChecked();
        await toggle(second.page).uncheck();
        await expect
          .poll(async () => settingValue(await readSettings(user, key), NOTIFICATION_SETTING))
          .toBe(false);
        await second.context.close();

        const third = await openSignedIn(browser, harness.board, user, key, {
          notifications: 'granted',
          spy: true,
        });
        await openSettings(third.page, SETTINGS_PAGES.notifications);
        await expect(toggle(third.page)).not.toBeChecked();
        await third.context.close();
      },
    );

    test(
      '[web-073] a context without the permission grant does not fire',
      {
        tag: '@chromium',
      },
      async ({ browser }) => {
        const { user, key } = await prepare();
        await enable(browser);

        const { page } = await openSignedIn(browser, harness.board, user, key, { spy: true });
        await loseFocus(page);
        const title = unique('ungranted');
        await createTask(harness.board, user, key, {
          prompt: 'needs attention',
          title,
          status: 'needs-me',
        });
        await expect(page.getByText(title).first()).toBeVisible();
        expect(await notificationCount(page)).toBe(0);
      },
    );
  });
});

test.describe('[web-075] Settings › Account', () => {
  const harness = useLoginBoard({
    parts: ['api', 'web', 'cli'],
    features: ['feeds', 'settings-document', 'attention', 'board-export'],
    passkeys: true,
  });

  test.describe.configure({ mode: 'serial' });

  interface Account {
    readonly user: BoardUser;
    readonly key: UnlockedKey;
    readonly taskIds: readonly string[];
    readonly titles: readonly string[];
  }

  let account: Account | null = null;
  let exported: string | null = null;
  let fresh: BoardUser | null = null;

  test.beforeAll(() => {
    account = null;
    exported = null;
    fresh = null;
  });

  const prepare = async (): Promise<Account> => {
    if (account !== null) return account;
    const user = await signedInUser(harness.board);
    const key = await unlockedKey(harness.board, user);
    const titles = [unique('first'), unique('second')];
    const taskIds: string[] = [];
    for (const title of titles) {
      const task = await createTask(harness.board, user, key, {
        prompt: `prompt of ${title}`,
        title,
        status: 'backlog',
      });
      taskIds.push(task.id);
    }
    account = { user, key, taskIds, titles };
    return account;
  };

  test('[web-075] adds and removes a passkey @chromium', async ({ browser }) => {
    const { user, key } = await prepare();
    const { page } = await openSignedIn(browser, harness.board, user, key);
    const authenticator = await withVirtualAuthenticator(page);
    const name = unique('e2e-passkey');
    await openSettings(page, SETTINGS_PAGES.account);

    await page.getByRole('button', { name: /^add passkey$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/name/i).fill(name);
    await dialog.getByRole('button', { name: /^(save|register|add)$/i }).click();

    await expect
      .poll(async () => (await user.ok('client.passkeys.list', {})).passkeys.map((p) => p.name))
      .toContain(name);
    expect(await authenticator.credentials()).toHaveLength(1);
    const row = page.getByRole('listitem').filter({ hasText: name }).first();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: /^(remove|delete)$/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(remove|delete|confirm)$/i })
      .click();
    await expect
      .poll(async () => (await user.ok('client.passkeys.list', {})).passkeys.map((p) => p.name))
      .not.toContain(name);
    await authenticator.remove();
  });

  test('[web-075] exports the account as a downloaded file', async ({ browser }) => {
    const { user, key, taskIds } = await prepare();
    const { page } = await openSignedIn(browser, harness.board, user, key);
    await openSettings(page, SETTINGS_PAGES.account);

    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: /export/i })
      .or(page.getByRole('link', { name: /export/i }))
      .first()
      .click();
    const file = harness.board.tmp.path('account-export.ndjson');
    await (await download).saveAs(file);

    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    const header = JSON.parse(lines[0] ?? '{}') as { format?: string };
    expect(header.format).toBe(BOARD_EXPORT_FORMAT);
    const parsed = lines.map((line, index) => parseBoardExportLine(line, index));
    const exportedTasks = parsed.filter((entry) => 'table' in entry && entry.table === 'task');
    expect(exportedTasks.length).toBeGreaterThanOrEqual(taskIds.length);
    exported = file;
  });

  test('[web-075] deleting the account signs out and the user cannot sign back in to the old data', async ({
    browser,
  }) => {
    const { user, key } = await prepare();
    const { page } = await openSignedIn(browser, harness.board, user, key);
    await openSettings(page, SETTINGS_PAGES.account);

    await page.getByRole('button', { name: /^delete account$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/username|type/i).fill(user.username);
    await dialog.getByRole('button', { name: /^delete( account)?$/i }).click();

    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible();
    expect((await user.call('client.me', {})).status).toBe(401);

    fresh = await signedInUser(harness.board);
    expect((await fresh.ok('client.tasks.list', {})).tasks).toHaveLength(0);
    expect((await fresh.ok('client.keys.get', {})).setup).toBeNull();
  });

  test('[web-075] importing the exported file into a fresh account restores its tasks', async ({
    browser,
  }) => {
    const { key, taskIds, titles } = await prepare();
    expect(exported).not.toBeNull();
    expect(fresh).not.toBeNull();
    const user = fresh as BoardUser;
    await user.ok('client.keys.setup', {
      keyId: key.keyId,
      slots: [
        await wrapSlot(
          dataKeyBytes(key),
          { kind: 'passphrase', passphrase: key.passphrase },
          TEST_KDF,
        ),
      ],
    });
    const { page } = await openSignedIn(browser, harness.board, user, key);
    await openSettings(page, SETTINGS_PAGES.account);

    const chooser = page.waitForEvent('filechooser');
    await page
      .getByRole('button', { name: /import/i })
      .or(page.getByLabel(/import/i))
      .first()
      .click();
    await (await chooser).setFiles(exported as string);

    await expect
      .poll(async () => (await user.ok('client.tasks.list', {})).tasks.map((task) => task.id))
      .toEqual(expect.arrayContaining([...taskIds]));
    const restored = (await user.ok('client.tasks.list', {})).tasks;
    for (const [index, id] of taskIds.entries()) {
      const task = restored.find((entry) => entry.id === id);
      expect(task).toBeDefined();
      expect(await key.open(bindings.title({ task: id }), task?.title ?? '')).toBe(titles[index]);
    }
  });
});
