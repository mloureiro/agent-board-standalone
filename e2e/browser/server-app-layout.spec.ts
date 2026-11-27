import { readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { bindings } from '@rumo/sealing';

import { UNLOCK_NAMES, persistentContext, unlockInPage } from '../src/fixtures/browser.js';
import { DEFAULT_PASSPHRASE, unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { writeSecretFile } from '../src/fixtures/machines.js';
import { startServerAppLayout, type ServerAppLayout } from '../src/fixtures/server-app-layout.js';
import { createTask } from '../src/fixtures/tasks.js';
import { noLoginUser, type BoardUser } from '../src/fixtures/users.js';
import { missingParts } from '../src/harness/paths.js';
import { partSkipReason } from '../src/harness/skip.js';
import { recordPlaywrightSkip, waitFor } from '../src/steps/migration.js';

const START_TIMEOUT_MS = 120_000;
const SIGHTING_WAIT_MS = 90_000;
const REMOTE_HOST = 'box.example.test';
const OTHER_HOST = 'other.example.test';
const SIGN_IN_NAMES = /sign in|log in|login/i;

interface Layout {
  readonly layout: ServerAppLayout;
  readonly user: BoardUser;
  readonly key: UnlockedKey;
}

function useLayout(
  options: { remoteHosts?: readonly string[]; cli?: boolean; user?: boolean } = {},
) {
  const state: { started: Layout | null; reason: string | null } = {
    started: null,
    reason: null,
  };

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(options.cli === true ? ['api', 'web', 'cli'] : ['api', 'web']);
    if (missing.length > 0) {
      state.reason = partSkipReason(missing);
      return;
    }
    const layout = await startServerAppLayout({
      web: true,
      ...(options.remoteHosts === undefined ? {} : { remoteHosts: options.remoteHosts }),
    });
    if (options.user === false) {
      state.started = { layout } as Layout;
      return;
    }
    const user = await noLoginUser(layout);
    const key = await unlockedKey(layout, user);
    state.started = { layout, user, key };
  });

  test.afterAll(async () => {
    await state.started?.layout.stop();
    state.started = null;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeEach(async ({}, testInfo) => {
    if (state.reason === null) return;
    recordPlaywrightSkip(testInfo, state.reason);
    test.skip(true, state.reason);
  });

  return {
    get current(): Layout {
      if (state.started === null) throw new Error('the layout is not started');
      return state.started;
    },
  };
}

function request(
  url: string,
  pathname: string,
  host: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: pathname,
        headers: { host: `${host}:${target.port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function createCard(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /new task/i }).click();
  await page.getByLabel(/title/i).fill(title);
  await page.getByLabel(/prompt/i).fill(title);
  await page.getByRole('button', { name: /^create/i }).click();
}

test.describe('the server app layout from a cleared environment', () => {
  const harness = useLayout();

  test('[server-app-074] the API runs no-login as the settings user with no login-mode variable', async () => {
    const { layout, user } = harness.current;
    expect(user.username).toBe(layout.settingsUser);
  });

  test('[server-app-074] the database is PGlite under the app root', async () => {
    const { layout } = harness.current;
    expect(layout.database.kind).toBe('pglite');
    expect(readdirSync(path.join(layout.root, 'db')).length).toBeGreaterThan(0);
  });

  test('[server-app-074] the app port is an allowed host and any other host is refused', async () => {
    const { layout } = harness.current;
    for (const host of ['127.0.0.1', 'localhost']) {
      expect((await request(layout.url, '/api/version', host)).status).toBe(200);
    }
    expect((await request(layout.url, '/api/version', OTHER_HOST)).status).toBe(421);
    expect((await request(layout.url, '/healthz', OTHER_HOST)).status).toBe(200);
  });

  test('[server-app-074] every request is the settings user and no sign-in page shows', async ({
    page,
  }) => {
    const { layout, user } = harness.current;
    const me = await user.ok('client.me', {});
    expect(me.username).toBe(layout.settingsUser);

    await page.goto(layout.url);
    await expect(page.getByLabel(UNLOCK_NAMES.passphrase)).toBeVisible();
    await expect(page.getByRole('button', { name: SIGN_IN_NAMES })).toHaveCount(0);
    await expect(page.getByRole('link', { name: SIGN_IN_NAMES })).toHaveCount(0);
  });
});

test.describe('the server app layout with a remote host', () => {
  const harness = useLayout({ remoteHosts: [REMOTE_HOST], user: false });

  test('[server-app-074] a remoteHosts name is an allowed host', async () => {
    const { layout } = harness.current;
    expect((await request(layout.url, '/api/version', REMOTE_HOST)).status).toBe(200);
    expect((await request(layout.url, '/api/version', OTHER_HOST)).status).toBe(421);
  });
});

test.describe('opening the board of the server app', () => {
  const harness = useLayout();

  test('[server-app-001] the board URL shows the board and a card can be created', async ({
    page,
  }) => {
    const { layout, user, key } = harness.current;
    await page.goto(layout.url);
    await unlockInPage(page, DEFAULT_PASSPHRASE);
    await expect(page.getByLabel(UNLOCK_NAMES.passphrase)).toHaveCount(0);

    const title = 'card from the server app board';
    await createCard(page, title);
    await expect(page.getByText(title).first()).toBeVisible();

    const listed = await waitFor(
      async () => {
        const tasks = (await user.ok('client.tasks.list', {})).tasks;
        return tasks.length > 0 ? tasks : null;
      },
      { label: 'the created card on the server' },
    );
    const titles = await Promise.all(
      listed.map((task) => key.open(bindings.title({ task: task.id }), task.title)),
    );
    expect(titles).toContain(title);
  });
});

test.describe('restarting the server app on the same root', () => {
  const harness = useLayout({ cli: true });

  test('[server-app-002] cards stay, the worker reconnects without rumo init and the client opens unlocked', async ({
    browserName,
  }) => {
    test.setTimeout(START_TIMEOUT_MS + SIGHTING_WAIT_MS);
    const { layout, user, key } = harness.current;
    const title = 'card that survives the restart';
    await createTask(layout, user, key, { prompt: title, title, status: 'backlog' });

    const issued = await user.ok('client.machines.issue', { name: 'app-worker' });
    const tokenFile = writeSecretFile(layout.tmp.path('secrets', 'token'), issued.token);
    const dataKeyFile = writeSecretFile(layout.tmp.path('secrets', 'data-key'), key.dataKey);
    const init = await layout.cli([
      'init',
      '--url',
      layout.url,
      '--token-file',
      tokenFile,
      '--data-key-file',
      dataKeyFile,
    ]);
    expect(init.code, `${init.stdout}${init.stderr}`).toBe(0);

    const userDataDir = layout.tmp.path('browser');
    const first = await persistentContext(userDataDir, {
      browser: browserName === 'webkit' ? 'webkit' : 'chromium',
    });
    try {
      const page = await first.newPage();
      await page.goto(layout.url);
      await unlockInPage(page, DEFAULT_PASSPHRASE);
      await expect(page.getByText(title).first()).toBeVisible();
    } finally {
      await first.close();
    }

    const lastSeenAfter = async (since: number) => {
      const machines = (await user.ok('client.machines.list', {})).machines;
      const seen = machines.find((machine) => machine.name === 'app-worker')?.lastSeenAt;
      return seen !== undefined && seen !== null && Date.parse(seen) > since ? seen : null;
    };
    const worker = layout.startCli(['internal', 'listen']);
    let seenBeforeRestart: string;
    try {
      seenBeforeRestart = await waitFor(() => lastSeenAfter(0), {
        label: 'the worker to connect',
        timeoutMs: 60_000,
      });
    } finally {
      await worker.stop();
    }
    await layout.restartApi();
    const reconnected = layout.startCli(['internal', 'listen']);
    try {
      await waitFor(() => lastSeenAfter(Date.parse(seenBeforeRestart)), {
        label: 'the worker to reconnect after the restart',
        timeoutMs: SIGHTING_WAIT_MS,
      });
      const machines = await layout.cli(['machines']);
      expect(machines.code, `${machines.stdout}${machines.stderr}`).toBe(0);
      expect(machines.stdout).toContain('app-worker');
      const listed = (await user.ok('client.tasks.list', {})).tasks;
      expect(listed.length).toBeGreaterThan(0);

      const second = await persistentContext(userDataDir, {
        browser: browserName === 'webkit' ? 'webkit' : 'chromium',
      });
      try {
        const page = await second.newPage();
        await page.goto(layout.url);
        await expect(page.getByText(title).first()).toBeVisible();
        await expect(page.getByLabel(UNLOCK_NAMES.passphrase)).toHaveCount(0);
      } finally {
        await second.close();
      }
    } finally {
      await reconnected.stop();
    }
  });
});
